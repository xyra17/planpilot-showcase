import secrets
import uuid
from datetime import timedelta
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile, status
from passlib.context import CryptContext
from PIL import Image, ImageOps, UnidentifiedImageError
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.core.time import utc_now
from src.database import get_db
from src.deps import AuthContext, get_auth_context, get_current_user
from src.models import EmailVerificationToken, PasswordResetToken, User
from src.schemas.auth import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    RegisterRequest,
    RegisterResponse,
    ResetPasswordRequest,
    SessionResponse,
    UpdateProfileRequest,
    UserOut,
    VerifyEmailRequest,
)
from src.services.auth_session_service import (
    clear_session_cookies,
    issue_session,
    require_trusted_origin,
    revoke_family,
    revoke_user_sessions,
    rotate_session,
    set_session_cookies,
)
from src.services.object_storage import ObjectStorageError, get_object_storage, object_reference

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
limiter = Limiter(key_func=get_remote_address)
MAX_AVATAR_BYTES = 5 * 1024 * 1024
MAX_AVATAR_PIXELS = 20_000_000
AVATAR_OUTPUT_SIZE = 512


def _avatar_storage_dir() -> Path:
    directory = Path(settings.avatar_upload_dir).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _stored_avatar_reference(avatar_url: str | None) -> str | None:
    if not avatar_url:
        return None
    filename = Path(avatar_url).name
    if not filename.startswith("avatar-") or not filename.endswith(".webp"):
        return None
    if avatar_url.startswith("/api/v1/auth/avatars/"):
        return object_reference(f"avatars/{filename}")
    if avatar_url.startswith("/media/avatars/"):
        return str((_avatar_storage_dir() / filename).resolve())
    return None


@router.get("/avatars/{filename}")
async def serve_avatar(filename: str) -> Response:
    if not filename.startswith("avatar-") or not filename.endswith(".webp"):
        raise HTTPException(status_code=404, detail="头像不存在")
    storage = get_object_storage()
    reference = object_reference(f"avatars/{filename}")
    try:
        body = await storage.read(reference)
    except ObjectStorageError as exc:
        raise HTTPException(status_code=404, detail="头像不存在") from exc
    return Response(
        body,
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/hour")
async def register(
    request: Request,
    response: Response,
    body: RegisterRequest,
    db: AsyncSession = Depends(get_db),
) -> RegisterResponse:
    require_trusted_origin(request)
    normalized_email = str(body.email).strip().lower()
    normalized_username = body.username.strip()
    result = await db.execute(select(User).where(func.lower(User.email) == normalized_email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="该邮箱已被注册")
    result2 = await db.execute(select(User).where(User.username == normalized_username))
    if result2.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="该用户名已被使用")

    user = User(
        email=normalized_email,
        username=normalized_username,
        hashed_password=pwd_context.hash(body.password),
    )
    db.add(user)
    await db.flush()
    from src.services.workspace_service import ensure_default_workspace

    await ensure_default_workspace(user, db)

    verification_token = secrets.token_urlsafe(32)
    db.add(
        EmailVerificationToken(
            user_id=user.id,
            token=verification_token,
            expires_at=utc_now() + timedelta(hours=24),
        )
    )
    issued = await issue_session(db, user, remember_me=True)
    await db.commit()
    await db.refresh(user)
    set_session_cookies(response, issued)

    verification_email_sent = False
    if settings.smtp_user and settings.smtp_password:
        try:
            from src.tasks.email_verification import send_email_verification

            send_email_verification.apply_async(
                args=[user.email, user.username, verification_token],
                expires=3600,
            )
            verification_email_sent = True
        except Exception:
            verification_email_sent = False

    return RegisterResponse(
        user=UserOut.model_validate(user),
        verification_email_sent=verification_email_sent,
    )


@router.post("/verify-email", status_code=200)
async def verify_email(
    body: VerifyEmailRequest,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    record = (
        await db.execute(
            select(EmailVerificationToken).where(EmailVerificationToken.token == body.token)
        )
    ).scalar_one_or_none()
    if not record or record.used or record.expires_at < utc_now():
        raise HTTPException(status_code=400, detail="验证链接无效或已过期")

    user = (await db.execute(select(User).where(User.id == record.user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="用户不存在")

    user.email_verified = True
    record.used = True
    await db.commit()
    return {"message": "邮箱验证成功"}


@router.post("/login", response_model=SessionResponse)
@limiter.limit("10/minute")
async def login(
    request: Request,
    response: Response,
    body: LoginRequest,
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    require_trusted_origin(request)
    identifier = body.identifier
    if "@" in identifier:
        result = await db.execute(select(User).where(func.lower(User.email) == identifier.lower()))
    else:
        result = await db.execute(select(User).where(User.username == identifier))
    user = result.scalar_one_or_none()
    if not user or not pwd_context.verify(body.password, user.hashed_password):
        # 不区分账号不存在与密码错误，避免泄露已注册账号信息。
        raise HTTPException(status_code=401, detail="账号或密码错误")
    if not user.is_active:
        raise HTTPException(status_code=423, detail="账户已锁定，请联系管理员")

    issued = await issue_session(db, user, remember_me=body.remember_me)
    await db.commit()
    set_session_cookies(response, issued)
    return SessionResponse(user=UserOut.model_validate(user))


@router.post("/refresh", response_model=SessionResponse)
@limiter.limit("30/minute")
async def refresh_session(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    refresh_token = request.cookies.get(settings.auth_refresh_cookie_name)
    if not refresh_token:
        raise HTTPException(status_code=401, detail="缺少刷新会话，请重新登录")
    issued, user = await rotate_session(db, refresh_token, request)
    await db.commit()
    set_session_cookies(response, issued)
    return SessionResponse(user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
async def me(current_user: User = Depends(get_current_user)) -> UserOut:
    return UserOut.model_validate(current_user)


@router.patch("/me", response_model=UserOut)
async def update_me(
    body: UpdateProfileRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserOut:
    if body.username is not None and body.username != current_user.username:
        result = await db.execute(select(User).where(User.username == body.username))
        if result.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="该用户名已被使用")
        current_user.username = body.username

    if body.email is not None and body.email != current_user.email:
        result = await db.execute(select(User).where(User.email == body.email))
        if result.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="该邮箱已被使用")
        current_user.email = body.email

    if body.timezone is not None:
        current_user.timezone = body.timezone

    if body.language is not None:
        current_user.language = body.language

    if body.week_start is not None:
        current_user.week_start = body.week_start

    if body.study_days is not None:
        current_user.study_days = body.study_days

    if body.availability_windows is not None:
        current_user.availability_windows = body.availability_windows

    if body.weekly_availability is not None:
        current_user.weekly_availability = {
            day: [period.model_dump() for period in periods]
            for day, periods in body.weekly_availability.items()
        }

    if body.ui_experience is not None:
        current_user.ui_experience = body.ui_experience

    if body.ui_theme is not None:
        current_user.ui_theme = body.ui_theme

    if body.ui_accent is not None:
        current_user.ui_accent = body.ui_accent

    if body.font_density is not None:
        current_user.font_density = body.font_density

    if body.preferred_start_method is not None:
        current_user.preferred_start_method = body.preferred_start_method

    if body.account_preferences is not None:
        merged_preferences = dict(current_user.account_preferences or {})
        for key, value in body.account_preferences.items():
            existing_value = merged_preferences.get(key)
            if isinstance(existing_value, dict) and isinstance(value, dict):
                merged_preferences[key] = {**existing_value, **value}
            else:
                merged_preferences[key] = value
        current_user.account_preferences = merged_preferences

    if body.onboarding_completed is not None:
        current_user.onboarding_completed = body.onboarding_completed

    await db.commit()
    await db.refresh(current_user)
    return UserOut.model_validate(current_user)


@router.post("/me/avatar", response_model=UserOut)
async def upload_avatar(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserOut:
    """Validate, normalize and persist an account-owned profile image."""
    if file.content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=415, detail="头像仅支持 JPG、PNG 或 WebP")

    raw = await file.read(MAX_AVATAR_BYTES + 1)
    await file.close()
    if not raw:
        raise HTTPException(status_code=400, detail="头像文件为空")
    if len(raw) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="头像不能超过 5 MB")

    previous_reference = _stored_avatar_reference(current_user.avatar_url)
    filename = f"avatar-{current_user.id}-{uuid.uuid4().hex}.webp"

    try:
        with Image.open(BytesIO(raw)) as source:
            if source.width * source.height > MAX_AVATAR_PIXELS:
                raise HTTPException(status_code=413, detail="头像图片尺寸过大")
            source.seek(0)
            image = ImageOps.fit(
                ImageOps.exif_transpose(source).convert("RGB"),
                (AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE),
                method=Image.Resampling.LANCZOS,
                centering=(0.5, 0.5),
            )
            output = BytesIO()
            image.save(output, format="WEBP", quality=88, method=6)
    except HTTPException:
        raise
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(status_code=400, detail="无法识别该图片，请换一张后重试") from None

    storage = get_object_storage()
    try:
        stored_reference = await storage.put(
            f"avatars/{filename}", output.getvalue(), "image/webp"
        )
    except ObjectStorageError as exc:
        raise HTTPException(status_code=503, detail="头像存储暂时不可用") from exc
    current_user.avatar_url = f"/api/v1/auth/avatars/{filename}"
    try:
        await db.commit()
        await db.refresh(current_user)
    except Exception:
        await storage.delete(stored_reference)
        raise

    if previous_reference and previous_reference != stored_reference:
        await storage.delete(previous_reference)
    return UserOut.model_validate(current_user)


@router.post("/logout", status_code=204)
async def logout(
    response: Response,
    context: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    await revoke_family(db, context.session.family_id)
    await db.commit()
    clear_session_cookies(response)


@router.post("/logout-all", status_code=204)
async def logout_all(
    response: Response,
    context: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    await revoke_user_sessions(db, context.user.id)
    await db.commit()
    clear_session_cookies(response)


@router.post("/change-password", status_code=204)
async def change_password(
    response: Response,
    body: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    if not pwd_context.verify(body.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="当前密码错误")
    current_user.hashed_password = pwd_context.hash(body.new_password)
    await revoke_user_sessions(db, current_user.id)
    await db.commit()
    clear_session_cookies(response)


@router.post("/forgot-password", status_code=200)
@limiter.limit("3/hour")
async def forgot_password(
    request: Request,
    body: ForgotPasswordRequest,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str | bool]:
    normalized_email = str(body.email).strip().lower()
    user = (
        await db.execute(select(User).where(func.lower(User.email) == normalized_email))
    ).scalar_one_or_none()
    delivery_available = bool(settings.smtp_user and settings.smtp_password)
    if user:
        await db.execute(delete(PasswordResetToken).where(PasswordResetToken.user_id == user.id))
        token_str = secrets.token_urlsafe(32)
        reset_token = PasswordResetToken(
            user_id=user.id,
            token=token_str,
            expires_at=utc_now() + timedelta(hours=1),
        )
        db.add(reset_token)
        await db.commit()
        if delivery_available:
            try:
                from src.tasks.password_recovery import send_password_reset

                send_password_reset.apply_async(
                    args=[user.email, user.username, token_str],
                    expires=3600,
                )
            except Exception:
                delivery_available = False
    return {
        "message": "如果该邮箱已注册且可用，重置链接已发送至邮箱",
        "delivery_available": delivery_available,
    }


@router.get("/reset-password/validate", status_code=200)
async def validate_reset_password_link(
    token: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    record = (
        await db.execute(select(PasswordResetToken).where(PasswordResetToken.token == token))
    ).scalar_one_or_none()
    if not record or record.used:
        raise HTTPException(status_code=400, detail="链接无效，请重新申请")
    if record.expires_at < utc_now():
        raise HTTPException(status_code=410, detail="链接已失效，请重新申请")
    return {"status": "valid"}


@router.post("/reset-password", status_code=200)
async def reset_password(
    body: ResetPasswordRequest,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    record = (
        await db.execute(select(PasswordResetToken).where(PasswordResetToken.token == body.token))
    ).scalar_one_or_none()
    if not record or record.used:
        raise HTTPException(status_code=400, detail="链接无效，请重新申请")
    if record.expires_at < utc_now():
        raise HTTPException(status_code=410, detail="链接已失效，请重新申请")
    user = (await db.execute(select(User).where(User.id == record.user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="用户不存在")
    user.hashed_password = pwd_context.hash(body.new_password)
    user.email_verified = True
    record.used = True
    await revoke_user_sessions(db, user.id)
    await db.commit()
    return {"message": "密码已重置，请重新登录"}


@router.delete("/me", status_code=204)
async def delete_me(
    response: Response,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    from src.models import (
        CheckinRecord,
        DailySchedule,
        KnowledgeBase,
        KnowledgeItem,
        KnowledgeItemFileVersion,
    )
    from src.services.object_storage import get_object_storage

    avatar_reference = _stored_avatar_reference(current_user.avatar_url)

    # 清理上传文件 + 知识条目（先删 items，再删 kb，避免 FK 约束）
    knowledge_items = (
        (await db.execute(select(KnowledgeItem).where(KnowledgeItem.user_id == current_user.id)))
        .scalars()
        .all()
    )
    storage = get_object_storage()
    item_ids = [item.id for item in knowledge_items]
    if item_ids:
        versions = (
            (
                await db.execute(
                    select(KnowledgeItemFileVersion).where(
                        KnowledgeItemFileVersion.item_id.in_(item_ids)
                    )
                )
            )
            .scalars()
            .all()
        )
        for version in versions:
            await storage.delete(version.file_path)
    for item in knowledge_items:
        for preview_reference in (
            item.media_playback_path,
            item.media_poster_path,
            item.media_waveform_path,
        ):
            if preview_reference:
                await storage.delete(preview_reference)
        if item.file_path:
            await storage.delete(item.file_path)
        await db.delete(item)

    # 删除知识库（无 cascade to user）
    kbs = (
        (await db.execute(select(KnowledgeBase).where(KnowledgeBase.user_id == current_user.id)))
        .scalars()
        .all()
    )
    for kb in kbs:
        await db.delete(kb)

    # 删除打卡记录（无 cascade to user）
    checkins = (
        (await db.execute(select(CheckinRecord).where(CheckinRecord.user_id == current_user.id)))
        .scalars()
        .all()
    )
    for c in checkins:
        await db.delete(c)

    # 删除日程（无 cascade to user）
    schedules = (
        (await db.execute(select(DailySchedule).where(DailySchedule.user_id == current_user.id)))
        .scalars()
        .all()
    )
    for s in schedules:
        await db.delete(s)

    # 删除用户（goals → tasks/plans/checkin_records 由 cascade 处理）
    await db.delete(current_user)
    await db.commit()
    clear_session_cookies(response)
    if avatar_reference:
        await storage.delete(avatar_reference)
