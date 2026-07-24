import os
import secrets
from datetime import datetime, timedelta, timezone

import aiosmtplib
from email.mime.text import MIMEText
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials
from passlib.context import CryptContext
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import ALGORITHM, bearer_scheme, create_access_token, get_current_user
from src.models import PasswordResetToken, User
from src.schemas.auth import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    RegisterRequest,
    ResetPasswordRequest,
    TokenResponse,
    UpdateProfileRequest,
    UserOut,
)
from src.config import settings

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
limiter = Limiter(key_func=get_remote_address)


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/hour")
async def register(request: Request, body: RegisterRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    result = await db.execute(select(User).where(User.email == body.email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="该邮箱已被注册")
    result2 = await db.execute(select(User).where(User.username == body.username))
    if result2.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="该用户名已被使用")

    user = User(
        email=body.email,
        username=body.username,
        hashed_password=pwd_context.hash(body.password),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    return TokenResponse(
        access_token=create_access_token(user.id),
        user=UserOut.model_validate(user),
    )


@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
async def login(request: Request, body: LoginRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="该邮箱未注册")
    if not pwd_context.verify(body.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="密码错误")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="账号已被停用")

    return TokenResponse(
        access_token=create_access_token(user.id),
        user=UserOut.model_validate(user),
    )


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

    await db.commit()
    await db.refresh(current_user)
    return UserOut.model_validate(current_user)


@router.post("/logout", status_code=204)
async def logout(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> None:
    from jose import jwt as jose_jwt, JWTError
    try:
        payload = jose_jwt.decode(
            credentials.credentials, settings.secret_key, algorithms=[ALGORITHM]
        )
        jti: str | None = payload.get("jti")
        exp: int | None = payload.get("exp")
        if jti and exp:
            ttl = int(exp - datetime.now(timezone.utc).timestamp())
            if ttl > 0:
                from src.redis_client import get_redis
                await get_redis().setex(f"bl:{jti}", ttl, "1")
    except (JWTError, Exception):
        pass  # Token 无效也视为登出成功


@router.post("/change-password", status_code=204)
async def change_password(
    body: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    if not pwd_context.verify(body.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="当前密码错误")
    current_user.hashed_password = pwd_context.hash(body.new_password)
    await db.commit()


@router.post("/forgot-password", status_code=200)
@limiter.limit("3/hour")
async def forgot_password(
    request: Request,
    body: ForgotPasswordRequest,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    from datetime import datetime
    user = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if user:
        await db.execute(
            delete(PasswordResetToken).where(PasswordResetToken.user_id == user.id)
        )
        token_str = secrets.token_urlsafe(32)
        reset_token = PasswordResetToken(
            user_id=user.id,
            token=token_str,
            expires_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=1),
        )
        db.add(reset_token)
        await db.commit()
        frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000")
        reset_url = f"{frontend_url}/reset-password?token={token_str}"
        msg = MIMEText(
            f"你好，\n\n我们收到了你的密码重置请求。点击下方链接重置密码（链接有效期 1 小时）：\n\n{reset_url}\n\n如果这不是你发起的请求，请忽略此邮件。\n\n— PlanPilot 团队",
            "plain",
            "utf-8",
        )
        msg["Subject"] = "重置你的 PlanPilot 密码"
        msg["From"] = f"{os.getenv('SMTP_FROM_NAME', 'PlanPilot')} <{os.getenv('SMTP_USER')}>"
        msg["To"] = body.email
        try:
            await aiosmtplib.send(
                msg,
                hostname=os.getenv("SMTP_HOST"),
                port=int(os.getenv("SMTP_PORT", "587")),
                username=os.getenv("SMTP_USER"),
                password=os.getenv("SMTP_PASSWORD"),
                start_tls=True,
            )
        except Exception:
            pass  # 不泄露邮件是否发送成功
    return {"message": "如果该邮箱已注册，重置链接已发送至邮箱"}


@router.post("/reset-password", status_code=200)
async def reset_password(
    body: ResetPasswordRequest,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    from datetime import datetime
    record = (
        await db.execute(select(PasswordResetToken).where(PasswordResetToken.token == body.token))
    ).scalar_one_or_none()
    if not record or record.used or record.expires_at < datetime.utcnow():
        raise HTTPException(status_code=400, detail="链接无效或已过期，请重新申请")
    user = (await db.execute(select(User).where(User.id == record.user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="用户不存在")
    user.hashed_password = pwd_context.hash(body.new_password)
    record.used = True
    await db.commit()
    return {"message": "密码已重置，请重新登录"}


@router.delete("/me", status_code=204)
async def delete_me(    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    import os
    from src.models import CheckinRecord, DailySchedule, KnowledgeBase, KnowledgeItem

    # 清理上传文件 + 知识条目（先删 items，再删 kb，避免 FK 约束）
    knowledge_items = (await db.execute(
        select(KnowledgeItem).where(KnowledgeItem.user_id == current_user.id)
    )).scalars().all()
    for item in knowledge_items:
        if item.file_path and os.path.exists(item.file_path):
            try:
                os.remove(item.file_path)
            except FileNotFoundError:
                pass
        await db.delete(item)

    # 删除知识库（无 cascade to user）
    kbs = (await db.execute(
        select(KnowledgeBase).where(KnowledgeBase.user_id == current_user.id)
    )).scalars().all()
    for kb in kbs:
        await db.delete(kb)

    # 删除打卡记录（无 cascade to user）
    checkins = (await db.execute(
        select(CheckinRecord).where(CheckinRecord.user_id == current_user.id)
    )).scalars().all()
    for c in checkins:
        await db.delete(c)

    # 删除日程（无 cascade to user）
    schedules = (await db.execute(
        select(DailySchedule).where(DailySchedule.user_id == current_user.id)
    )).scalars().all()
    for s in schedules:
        await db.delete(s)

    # 删除用户（goals → tasks/plans/checkin_records 由 cascade 处理）
    await db.delete(current_user)
    await db.commit()
