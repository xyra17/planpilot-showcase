import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass
from datetime import timedelta
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, Response, status
from jose import jwt
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.core.time import utc_now, utc_now_aware
from src.models import AuthSession, User

ALGORITHM = "HS256"


@dataclass(frozen=True)
class IssuedSession:
    access_token: str
    refresh_token: str
    csrf_token: str
    session: AuthSession


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_access_token(user_id: str, session_id: str) -> str:
    issued_at = utc_now_aware()
    expires_at = issued_at + timedelta(minutes=settings.access_token_expire_minutes)
    return jwt.encode(
        {
            "sub": user_id,
            "sid": session_id,
            "typ": "access",
            "jti": str(uuid.uuid4()),
            "iat": issued_at,
            "exp": expires_at,
        },
        settings.secret_key,
        algorithm=ALGORITHM,
    )


def create_csrf_token(session_id: str) -> str:
    nonce = secrets.token_urlsafe(32)
    signature = hmac.new(
        settings.secret_key.encode("utf-8"),
        f"{session_id}.{nonce}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{signature}.{nonce}"


def validate_csrf_token(session_id: str, token: str | None) -> bool:
    if not token or "." not in token:
        return False
    signature, nonce = token.split(".", 1)
    expected = hmac.new(
        settings.secret_key.encode("utf-8"),
        f"{session_id}.{nonce}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


def require_csrf(request: Request, session_id: str) -> None:
    if request.method.upper() in {"GET", "HEAD", "OPTIONS"}:
        return
    require_trusted_origin(request)
    cookie_token = request.cookies.get(settings.auth_csrf_cookie_name)
    header_token = request.headers.get("X-CSRF-Token")
    if (
        not cookie_token
        or not header_token
        or not hmac.compare_digest(cookie_token, header_token)
        or not validate_csrf_token(session_id, header_token)
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF 校验失败")


def require_trusted_origin(request: Request) -> None:
    """Reject browser state changes that explicitly come from another site."""
    if request.headers.get("Sec-Fetch-Site", "").lower() == "cross-site":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="请求来源不受信任")
    origin = request.headers.get("Origin")
    if not origin or origin in settings.cors_origin_list:
        return
    # Development servers frequently move between 3000, 3001, 3010, etc.
    # Keep production's explicit allow-list strict, while allowing only local
    # HTTP origins during local development and tests.
    parsed = urlsplit(origin)
    is_local_dev_origin = (
        settings.environment.lower() in {"development", "test"}
        and parsed.scheme == "http"
        and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        and parsed.path in {"", "/"}
        and not parsed.username
        and not parsed.query
        and not parsed.fragment
    )
    if not is_local_dev_origin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="请求来源不受信任")


async def issue_session(db: AsyncSession, user: User, remember_me: bool) -> IssuedSession:
    raw_refresh = secrets.token_urlsafe(48)
    lifetime = (
        timedelta(days=settings.refresh_token_expire_days)
        if remember_me
        else timedelta(hours=settings.session_refresh_token_expire_hours)
    )
    session = AuthSession(
        family_id=str(uuid.uuid4()),
        user_id=user.id,
        refresh_token_hash=hash_refresh_token(raw_refresh),
        remember_me=remember_me,
        expires_at=utc_now() + lifetime,
    )
    db.add(session)
    await db.flush()
    return IssuedSession(
        access_token=create_access_token(user.id, session.id),
        refresh_token=raw_refresh,
        csrf_token=create_csrf_token(session.id),
        session=session,
    )


async def rotate_session(
    db: AsyncSession, raw_refresh: str, request: Request
) -> tuple[IssuedSession, User]:
    token_hash = hash_refresh_token(raw_refresh)
    record = (
        await db.execute(
            select(AuthSession)
            .where(AuthSession.refresh_token_hash == token_hash)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=401, detail="刷新会话无效，请重新登录")

    require_csrf(request, record.id)

    now = utc_now()
    if record.revoked_at is not None:
        if (
            record.replaced_by_session_id
            and record.last_used_at
            and (now - record.last_used_at).total_seconds()
            <= settings.refresh_token_reuse_grace_seconds
        ):
            raise HTTPException(status_code=409, detail="刷新会话刚刚完成轮换，请重试原请求")
        await revoke_family(db, record.family_id, now=now)
        await db.commit()
        raise HTTPException(status_code=401, detail="检测到刷新令牌复用，已撤销该登录会话")
    if record.expires_at <= now:
        record.revoked_at = now
        await db.commit()
        raise HTTPException(status_code=401, detail="登录会话已过期，请重新登录")

    user = (await db.execute(select(User).where(User.id == record.user_id))).scalar_one_or_none()
    if not user or not user.is_active:
        await revoke_family(db, record.family_id, now=now)
        await db.commit()
        raise HTTPException(status_code=401, detail="用户不可用，请重新登录")

    new_raw_refresh = secrets.token_urlsafe(48)
    replacement = AuthSession(
        family_id=record.family_id,
        user_id=record.user_id,
        refresh_token_hash=hash_refresh_token(new_raw_refresh),
        remember_me=record.remember_me,
        expires_at=record.expires_at,
    )
    db.add(replacement)
    await db.flush()
    record.last_used_at = now
    record.revoked_at = now
    record.replaced_by_session_id = replacement.id
    issued = IssuedSession(
        access_token=create_access_token(user.id, replacement.id),
        refresh_token=new_raw_refresh,
        csrf_token=create_csrf_token(replacement.id),
        session=replacement,
    )
    return issued, user


async def revoke_family(db: AsyncSession, family_id: str, *, now=None) -> None:
    await db.execute(
        update(AuthSession)
        .where(AuthSession.family_id == family_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=now or utc_now())
    )


async def revoke_user_sessions(db: AsyncSession, user_id: str) -> None:
    await db.execute(
        update(AuthSession)
        .where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=utc_now())
    )


def set_session_cookies(response: Response, issued: IssuedSession) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    common = {
        "secure": settings.secure_auth_cookies,
        "samesite": settings.auth_cookie_samesite.lower(),
    }
    access_max_age = settings.access_token_expire_minutes * 60 if issued.session.remember_me else None
    response.set_cookie(
        settings.auth_access_cookie_name,
        issued.access_token,
        httponly=True,
        path="/",
        max_age=access_max_age,
        **common,
    )
    refresh_max_age = None
    if issued.session.remember_me:
        refresh_max_age = settings.refresh_token_expire_days * 24 * 60 * 60
    response.set_cookie(
        settings.auth_refresh_cookie_name,
        issued.refresh_token,
        httponly=True,
        path="/api/v1/auth",
        max_age=refresh_max_age,
        **common,
    )
    response.set_cookie(
        settings.auth_csrf_cookie_name,
        issued.csrf_token,
        httponly=False,
        path="/",
        max_age=refresh_max_age,
        **common,
    )


def clear_session_cookies(response: Response) -> None:
    common = {
        "secure": settings.secure_auth_cookies,
        "samesite": settings.auth_cookie_samesite.lower(),
    }
    response.delete_cookie(settings.auth_access_cookie_name, path="/", **common)
    response.delete_cookie(settings.auth_refresh_cookie_name, path="/api/v1/auth", **common)
    response.delete_cookie(settings.auth_csrf_cookie_name, path="/", **common)
