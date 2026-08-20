import logging
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.core.time import utc_now
from src.database import get_db
from src.models import AuthSession, User
from src.services.auth_session_service import ALGORITHM, require_csrf

bearer_scheme = HTTPBearer(auto_error=False)
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AuthContext:
    user: User
    session: AuthSession
    jti: str | None
    source: str


def _unauthorized(detail: str = "无效的认证凭据") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_auth_context(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> AuthContext:
    cookie_token = request.cookies.get(settings.auth_access_cookie_name)
    token = (credentials.credentials if credentials else None) or cookie_token
    source = "bearer" if credentials else "cookie"
    if not token:
        raise _unauthorized("请先登录")

    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        session_id = payload.get("sid")
        token_type = payload.get("typ")
        jti = payload.get("jti")
        if not user_id or not session_id or token_type != "access":
            raise ValueError
    except (JWTError, ValueError):
        raise _unauthorized() from None

    session = (
        await db.execute(select(AuthSession).where(AuthSession.id == session_id))
    ).scalar_one_or_none()
    if (
        session is None
        or session.user_id != user_id
        or session.revoked_at is not None
        or session.expires_at <= utc_now()
    ):
        raise _unauthorized("登录会话已失效，请重新登录")

    if source == "cookie":
        require_csrf(request, session.id)

    # Redis is defense in depth for individual access JWT revocation. Session
    # state in the database remains the authoritative fail-closed control.
    if jti:
        from src.redis_client import get_redis

        try:
            if await get_redis().exists(f"bl:{jti}"):
                raise _unauthorized("Token 已失效，请重新登录")
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning(
                "auth_revocation_cache_unavailable policy=%s session_id=%s error=%s",
                settings.auth_redis_failure_policy,
                session.id,
                type(exc).__name__,
            )
            if settings.auth_redis_failure_policy == "fail_closed":
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="认证撤销检查暂时不可用，请稍后重试",
                ) from exc

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None or not user.is_active:
        raise _unauthorized("用户不存在或已停用")
    return AuthContext(user=user, session=session, jti=jti, source=source)


async def get_current_user(context: AuthContext = Depends(get_auth_context)) -> User:
    return context.user


async def get_current_admin(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员权限")
    return current_user
