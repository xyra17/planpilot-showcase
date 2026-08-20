import uuid
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.core.time import utc_now
from src.models import AuthSession
from src.services.ssrf_guard import UnsafeUrlError, normalize_public_http_url
from src.tasks.knowledge import KnowledgeProcessingError, fetch_public_url_content


async def _resolver(addresses: list[str]):
    async def resolve(host: str, port: int) -> list[str]:
        assert host
        assert port in {80, 443}
        return addresses

    return resolve


async def test_ssrf_guard_accepts_and_canonicalizes_public_url():
    resolver = await _resolver(["93.184.216.34"])
    result = await normalize_public_http_url(
        "HTTPS://Example.COM./docs?q=1#fragment",
        resolver=resolver,
    )
    assert result == "https://example.com/docs?q=1"


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/admin",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/",
        "http://2130706433/",
        "file:///etc/passwd",
        "http://user:password@example.com/",
        "https://example.com:444/",
        "http://service.internal/",
    ],
)
async def test_ssrf_guard_rejects_unsafe_url_shapes(url: str):
    with pytest.raises(UnsafeUrlError):
        await normalize_public_http_url(url)


@pytest.mark.parametrize("addresses", [["10.0.0.5"], ["93.184.216.34", "::1"]])
async def test_ssrf_guard_rejects_private_or_mixed_dns_answers(addresses: list[str]):
    resolver = await _resolver(addresses)
    with pytest.raises(UnsafeUrlError, match="非公网"):
        await normalize_public_http_url("https://example.com/resource", resolver=resolver)


async def test_url_import_rejects_private_target_before_persisting(
    client: AsyncClient,
    auth: dict,
):
    response = await client.post(
        "/api/v1/knowledge/url",
        json={"url": "http://169.254.169.254/latest/meta-data"},
        headers=auth,
    )
    assert response.status_code == 422
    assert "非公网" in response.json()["detail"]


@pytest.mark.parametrize(
    ("response", "message"),
    [
        (httpx.Response(302, headers={"Location": "http://127.0.0.1"}), "不允许重定向"),
        (httpx.Response(200, headers={"Content-Type": "application/octet-stream"}), "内容类型"),
        (
            httpx.Response(200, headers={"Content-Length": str(2 * 1024 * 1024 + 1)}),
            "超过 2 MB",
        ),
    ],
)
async def test_url_fetch_rejects_redirect_type_and_size(response: httpx.Response, message: str):
    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: response)

    def client_factory(**kwargs):
        return real_client(transport=transport, **kwargs)

    with (
        patch("httpx.AsyncClient", side_effect=client_factory),
        patch(
            "src.services.ssrf_guard.normalize_public_http_url",
            new=AsyncMock(return_value="https://example.com/"),
        ),
        pytest.raises(KnowledgeProcessingError, match=message),
    ):
        await fetch_public_url_content("https://example.com/")


async def test_url_fetch_returns_bounded_text():
    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"Content-Type": "text/plain; charset=utf-8"},
            content="安全的公开内容".encode(),
        )
    )

    def client_factory(**kwargs):
        return real_client(transport=transport, **kwargs)

    with (
        patch("httpx.AsyncClient", side_effect=client_factory),
        patch(
            "src.services.ssrf_guard.normalize_public_http_url",
            new=AsyncMock(return_value="https://example.com/"),
        ),
    ):
        assert await fetch_public_url_content("https://example.com/") == "安全的公开内容"


async def test_redis_outage_uses_explicit_session_authoritative_policy(
    client: AsyncClient,
    db: AsyncSession,
    monkeypatch,
):
    suffix = uuid.uuid4().hex[:8]
    registered = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"{suffix}@test.com",
            "username": suffix,
            "password": "testpass123",
        },
    )
    token = registered.cookies.get(settings.auth_access_cookie_name)
    user_id = registered.json()["user"]["id"]
    assert token
    failing_redis = AsyncMock()
    failing_redis.exists.side_effect = ConnectionError("redis unavailable")

    monkeypatch.setattr(settings, "auth_redis_failure_policy", "session_authoritative")
    with patch("src.redis_client.get_redis", return_value=failing_redis):
        allowed = await client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert allowed.status_code == 200

    monkeypatch.setattr(settings, "auth_redis_failure_policy", "fail_closed")
    with patch("src.redis_client.get_redis", return_value=failing_redis):
        blocked = await client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert blocked.status_code == 503

    session = (
        await db.execute(select(AuthSession).where(AuthSession.user_id == user_id))
    ).scalar_one()
    session.revoked_at = utc_now()
    await db.commit()
    monkeypatch.setattr(settings, "auth_redis_failure_policy", "session_authoritative")
    with patch("src.redis_client.get_redis", return_value=failing_redis):
        revoked = await client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert revoked.status_code == 401
