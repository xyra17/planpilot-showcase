import time
import uuid
from datetime import timedelta
from io import BytesIO

from httpx import ASGITransport, AsyncClient
from jose import jwt
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.core.time import utc_now
from src.main import app
from src.models import AuthSession, EmailVerificationToken, PasswordResetToken, User
from src.services.auth_session_service import hash_refresh_token


def _creds():
    uid = uuid.uuid4().hex[:8]
    return {"email": f"{uid}@test.com", "username": uid, "password": "pass1234"}


async def test_register_ok(client: AsyncClient):
    r = await client.post("/api/v1/auth/register", json=_creds())
    assert r.status_code == 201
    data = r.json()
    assert "access_token" not in data
    assert client.cookies.get(settings.auth_access_cookie_name)
    assert client.cookies.get(settings.auth_refresh_cookie_name)
    assert client.cookies.get(settings.auth_csrf_cookie_name)
    assert data["user"]["email"].endswith("@test.com")
    assert data["user"]["email_verified"] is False
    assert data["email_verification_required"] is True


async def test_register_duplicate_email(client: AsyncClient):
    creds = _creds()
    await client.post("/api/v1/auth/register", json=creds)
    r2 = await client.post("/api/v1/auth/register", json=creds)
    assert r2.status_code == 400
    assert "邮箱" in r2.json()["detail"]


async def test_register_duplicate_username(client: AsyncClient):
    creds = _creds()
    await client.post("/api/v1/auth/register", json=creds)
    creds2 = dict(creds, email=f"other_{creds['email']}")
    r = await client.post("/api/v1/auth/register", json=creds2)
    assert r.status_code == 400
    assert "用户名" in r.json()["detail"]


async def test_register_rejects_weak_password(client: AsyncClient):
    creds = _creds()
    creds["password"] = "onlyletters"
    response = await client.post("/api/v1/auth/register", json=creds)
    assert response.status_code == 422
    assert "字母和数字" in response.text


async def test_verify_email(client: AsyncClient, db: AsyncSession):
    creds = _creds()
    registered = await client.post("/api/v1/auth/register", json=creds)
    user_id = registered.json()["user"]["id"]
    token = (
        await db.execute(
            select(EmailVerificationToken).where(EmailVerificationToken.user_id == user_id)
        )
    ).scalar_one()

    verified = await client.post(
        "/api/v1/auth/verify-email",
        json={"token": token.token},
    )
    assert verified.status_code == 200
    assert verified.json()["message"] == "邮箱验证成功"

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one()
    assert user.email_verified is True

    reused = await client.post(
        "/api/v1/auth/verify-email",
        json={"token": token.token},
    )
    assert reused.status_code == 400


async def test_login_ok(client: AsyncClient):
    creds = _creds()
    await client.post("/api/v1/auth/register", json=creds)
    r = await client.post(
        "/api/v1/auth/login",
        json={"email": creds["email"], "password": creds["password"]},
    )
    assert r.status_code == 200
    assert "access_token" not in r.json()
    assert client.cookies.get(settings.auth_access_cookie_name)


async def test_login_with_username(client: AsyncClient):
    creds = _creds()
    await client.post("/api/v1/auth/register", json=creds)
    r = await client.post(
        "/api/v1/auth/login",
        json={"identifier": creds["username"], "password": creds["password"]},
    )
    assert r.status_code == 200
    assert r.json()["user"]["username"] == creds["username"]


async def test_login_access_token_is_short_lived_regardless_of_remember_me(client: AsyncClient):
    creds = _creds()
    await client.post("/api/v1/auth/register", json=creds)

    session_login = await client.post(
        "/api/v1/auth/login",
        json={"identifier": creds["username"], "password": creds["password"], "remember_me": False},
    )
    session_token = session_login.cookies.get(settings.auth_access_cookie_name)
    session_refresh = session_login.cookies.get(settings.auth_refresh_cookie_name)
    remembered_login = await client.post(
        "/api/v1/auth/login",
        json={"identifier": creds["username"], "password": creds["password"], "remember_me": True},
    )

    remembered_token = remembered_login.cookies.get(settings.auth_access_cookie_name)
    assert session_token and remembered_token and session_refresh
    session_claims = jwt.get_unverified_claims(session_token)
    remembered_claims = jwt.get_unverified_claims(remembered_token)
    assert abs(remembered_claims["exp"] - session_claims["exp"]) <= 2
    assert (
        0
        < session_claims["exp"] - int(time.time())
        <= settings.access_token_expire_minutes * 60 + 5
    )
    session_cookie = next(
        value
        for value in session_login.headers.get_list("set-cookie")
        if value.startswith(f"{settings.auth_refresh_cookie_name}=")
    )
    remembered_cookie = next(
        value
        for value in remembered_login.headers.get_list("set-cookie")
        if value.startswith(f"{settings.auth_refresh_cookie_name}=")
    )
    assert "Max-Age" not in session_cookie
    assert "Max-Age" in remembered_cookie


async def test_auth_cookies_have_security_attributes(client: AsyncClient):
    response = await client.post("/api/v1/auth/register", json=_creds())
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"
    cookies = response.headers.get_list("set-cookie")
    access = next(value for value in cookies if value.startswith("pp_access="))
    refresh = next(value for value in cookies if value.startswith("pp_refresh="))
    csrf = next(value for value in cookies if value.startswith("pp_csrf="))
    assert "HttpOnly" in access and "SameSite=lax" in access
    assert "HttpOnly" in refresh and "Path=/api/v1/auth" in refresh
    assert "HttpOnly" not in csrf and "SameSite=lax" in csrf


async def test_production_cookie_configuration_adds_secure(client: AsyncClient, monkeypatch):
    monkeypatch.setattr(settings, "auth_cookie_secure", True)
    response = await client.post("/api/v1/auth/register", json=_creds())
    auth_cookies = [
        value
        for value in response.headers.get_list("set-cookie")
        if value.startswith(("pp_access=", "pp_refresh=", "pp_csrf="))
    ]
    assert len(auth_cookies) == 3
    assert all("Secure" in value for value in auth_cookies)


async def test_cookie_authenticated_mutation_requires_csrf(client: AsyncClient):
    await client.post("/api/v1/auth/register", json=_creds())
    rejected = await client.patch("/api/v1/auth/me", json={"language": "zh-CN"})
    assert rejected.status_code == 403
    accepted = await client.patch(
        "/api/v1/auth/me",
        json={"language": "zh-CN"},
        headers={"X-CSRF-Token": client.cookies.get(settings.auth_csrf_cookie_name)},
    )
    assert accepted.status_code == 200


async def test_auth_rejects_untrusted_browser_origin(client: AsyncClient):
    rejected_login = await client.post(
        "/api/v1/auth/login",
        json={"identifier": "nobody@example.com", "password": "pass1234"},
        headers={"Origin": "https://attacker.example", "Sec-Fetch-Site": "cross-site"},
    )
    assert rejected_login.status_code == 403

    await client.post("/api/v1/auth/register", json=_creds())
    csrf = client.cookies.get(settings.auth_csrf_cookie_name)
    rejected_mutation = await client.patch(
        "/api/v1/auth/me",
        json={"language": "zh-CN"},
        headers={"Origin": "https://attacker.example", "X-CSRF-Token": csrf},
    )
    assert rejected_mutation.status_code == 403


async def test_auth_accepts_local_development_origin_on_dynamic_port(client: AsyncClient):
    creds = _creds()
    await client.post("/api/v1/auth/register", json=creds)
    accepted_login = await client.post(
        "/api/v1/auth/login",
        json={"identifier": creds["username"], "password": creds["password"]},
        headers={"Origin": "http://127.0.0.1:3010"},
    )
    assert accepted_login.status_code == 200


async def test_refresh_rotates_and_reuse_revokes_family(client: AsyncClient, db: AsyncSession):
    await client.post("/api/v1/auth/register", json=_creds())
    old_refresh = client.cookies.get(settings.auth_refresh_cookie_name)
    old_csrf = client.cookies.get(settings.auth_csrf_cookie_name)
    old_access = client.cookies.get(settings.auth_access_cookie_name)
    assert old_refresh and old_csrf and old_access

    rotated = await client.post(
        "/api/v1/auth/refresh",
        headers={"X-CSRF-Token": old_csrf},
    )
    assert rotated.status_code == 200, rotated.text
    new_refresh = client.cookies.get(settings.auth_refresh_cookie_name)
    new_csrf = client.cookies.get(settings.auth_csrf_cookie_name)
    assert new_refresh and new_refresh != old_refresh
    assert client.cookies.get(settings.auth_access_cookie_name) != old_access

    concurrent = await client.post(
        "/api/v1/auth/refresh",
        headers={
            "Cookie": f"{settings.auth_refresh_cookie_name}={old_refresh}; {settings.auth_csrf_cookie_name}={old_csrf}",
            "X-CSRF-Token": old_csrf,
        },
    )
    assert concurrent.status_code == 409

    original = (
        await db.execute(
            select(AuthSession).where(
                AuthSession.refresh_token_hash == hash_refresh_token(old_refresh)
            )
        )
    ).scalar_one()
    original.last_used_at = utc_now() - timedelta(
        seconds=settings.refresh_token_reuse_grace_seconds + 1
    )
    await db.commit()

    replayed = await client.post(
        "/api/v1/auth/refresh",
        headers={
            "Cookie": f"{settings.auth_refresh_cookie_name}={old_refresh}; {settings.auth_csrf_cookie_name}={old_csrf}",
            "X-CSRF-Token": old_csrf,
        },
    )
    assert replayed.status_code == 401
    assert "复用" in replayed.json()["detail"]

    current = (
        (await db.execute(select(AuthSession).where(AuthSession.family_id == original.family_id)))
        .scalars()
        .all()
    )
    assert current and all(record.revoked_at is not None for record in current)

    rejected_current = await client.post(
        "/api/v1/auth/refresh",
        headers={"X-CSRF-Token": new_csrf},
    )
    assert rejected_current.status_code == 401


async def test_logout_all_revokes_every_user_session(client: AsyncClient, db: AsyncSession):
    creds = _creds()
    first = await client.post("/api/v1/auth/register", json=creds)
    first_access = first.cookies.get(settings.auth_access_cookie_name)
    second = await client.post(
        "/api/v1/auth/login",
        json={"identifier": creds["email"], "password": creds["password"]},
    )
    second_access = second.cookies.get(settings.auth_access_cookie_name)
    user_id = second.json()["user"]["id"]
    assert first_access and second_access

    response = await client.post(
        "/api/v1/auth/logout-all",
        headers={"Authorization": f"Bearer {second_access}"},
    )
    assert response.status_code == 204
    sessions = (
        (await db.execute(select(AuthSession).where(AuthSession.user_id == user_id)))
        .scalars()
        .all()
    )
    assert len(sessions) == 2
    assert all(session.revoked_at is not None for session in sessions)
    rejected = await client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {first_access}"}
    )
    assert rejected.status_code == 401


async def test_login_unexpected_error_returns_json_with_cors(client: AsyncClient, monkeypatch):
    creds = _creds()
    await client.post("/api/v1/auth/register", json=creds)

    def raise_unexpected_error(*args, **kwargs):
        raise RuntimeError("password verifier unavailable")

    monkeypatch.setattr("src.api.auth.pwd_context.verify", raise_unexpected_error)
    async with AsyncClient(
        transport=ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test",
    ) as non_raising_client:
        response = await non_raising_client.post(
            "/api/v1/auth/login",
            json={"identifier": creds["username"], "password": creds["password"]},
            headers={"Origin": "http://localhost:3000"},
        )

    assert response.status_code == 500
    assert response.json()["detail"] == "服务暂时不可用，请稍后重试"
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


async def test_login_wrong_password(client: AsyncClient):
    creds = _creds()
    await client.post("/api/v1/auth/register", json=creds)
    r = await client.post(
        "/api/v1/auth/login",
        json={"email": creds["email"], "password": "wrongpass"},
    )
    assert r.status_code == 401
    assert r.json()["detail"] == "账号或密码错误"


async def test_login_unknown_email(client: AsyncClient):
    r = await client.post(
        "/api/v1/auth/login",
        json={"email": "nobody@nowhere.com", "password": "x"},
    )
    assert r.status_code == 401
    assert r.json()["detail"] == "账号或密码错误"


async def test_login_locked_account(client: AsyncClient, db: AsyncSession):
    creds = _creds()
    registered = await client.post("/api/v1/auth/register", json=creds)
    user_id = registered.json()["user"]["id"]
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one()
    user.is_active = False
    await db.commit()

    r = await client.post(
        "/api/v1/auth/login",
        json={"identifier": creds["username"], "password": creds["password"]},
    )
    assert r.status_code == 423
    assert r.json()["detail"] == "账户已锁定，请联系管理员"


async def test_forgot_password_creates_reset_token(client: AsyncClient, db: AsyncSession):
    creds = _creds()
    registered = await client.post("/api/v1/auth/register", json=creds)
    user_id = registered.json()["user"]["id"]

    response = await client.post(
        "/api/v1/auth/forgot-password",
        json={"email": creds["email"]},
    )
    assert response.status_code == 200
    assert "如果该邮箱已注册且可用" in response.json()["message"]
    token = (
        await db.execute(select(PasswordResetToken).where(PasswordResetToken.user_id == user_id))
    ).scalar_one()
    assert token.used is False


async def test_forgot_password_unknown_email_uses_same_response(client: AsyncClient):
    response = await client.post(
        "/api/v1/auth/forgot-password",
        json={"email": f"unknown-{uuid.uuid4().hex}@test.com"},
    )
    assert response.status_code == 200
    assert "如果该邮箱已注册且可用" in response.json()["message"]


async def test_validate_reset_link_invalid(client: AsyncClient):
    response = await client.get(
        "/api/v1/auth/reset-password/validate",
        params={"token": "not-a-real-token"},
    )
    assert response.status_code == 400
    assert "链接无效" in response.json()["detail"]


async def test_validate_reset_link_expired(client: AsyncClient, db: AsyncSession):
    creds = _creds()
    registered = await client.post("/api/v1/auth/register", json=creds)
    user_id = registered.json()["user"]["id"]
    expired = PasswordResetToken(
        user_id=user_id,
        token=uuid.uuid4().hex,
        expires_at=utc_now() - timedelta(minutes=1),
    )
    db.add(expired)
    await db.commit()

    response = await client.get(
        "/api/v1/auth/reset-password/validate",
        params={"token": expired.token},
    )
    assert response.status_code == 410
    assert "链接已失效" in response.json()["detail"]


async def test_reset_password_success(client: AsyncClient, db: AsyncSession):
    creds = _creds()
    registered = await client.post("/api/v1/auth/register", json=creds)
    user_id = registered.json()["user"]["id"]
    await client.post("/api/v1/auth/forgot-password", json={"email": creds["email"]})
    token = (
        await db.execute(select(PasswordResetToken).where(PasswordResetToken.user_id == user_id))
    ).scalar_one()

    response = await client.post(
        "/api/v1/auth/reset-password",
        json={"token": token.token, "new_password": "NewPassword123"},
    )
    assert response.status_code == 200
    assert "密码已重置" in response.json()["message"]

    login = await client.post(
        "/api/v1/auth/login",
        json={"identifier": creds["email"], "password": "NewPassword123"},
    )
    assert login.status_code == 200
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one()
    assert user.email_verified is True


async def test_reset_password_rejects_weak_password(client: AsyncClient):
    response = await client.post(
        "/api/v1/auth/reset-password",
        json={"token": uuid.uuid4().hex, "new_password": "weakpass"},
    )
    assert response.status_code == 422
    assert "字母和数字" in response.text


async def test_me_ok(client: AsyncClient, auth: dict):
    r = await client.get("/api/v1/auth/me", headers=auth)
    assert r.status_code == 200
    assert "email" in r.json()


async def test_me_no_token(client: AsyncClient):
    r = await client.get("/api/v1/auth/me")
    assert r.status_code in (401, 403)


async def test_me_patch_username(client: AsyncClient, auth: dict):
    new_name = uuid.uuid4().hex[:8]
    r = await client.patch("/api/v1/auth/me", json={"username": new_name}, headers=auth)
    assert r.status_code == 200
    assert r.json()["username"] == new_name


async def test_me_patch_reminder_email_overrides_notification_recipient(
    client: AsyncClient, auth: dict
):
    updated = await client.patch(
        "/api/v1/auth/me",
        json={"account_preferences": {"study_preferences": {"reminder_email": "Alerts@Example.com"}}},
        headers=auth,
    )
    assert updated.status_code == 200
    assert updated.json()["account_preferences"]["study_preferences"]["reminder_email"] == "alerts@example.com"

    status = await client.get("/api/v1/notifications/email-reminder-status", headers=auth)
    assert status.status_code == 200
    assert status.json()["recipient"] == "alerts@example.com"

    rejected = await client.patch(
        "/api/v1/auth/me",
        json={"account_preferences": {"study_preferences": {"reminder_email": "not-an-email"}}},
        headers=auth,
    )
    assert rejected.status_code == 422


async def test_upload_avatar_persists_normalized_image(
    client: AsyncClient, auth: dict, monkeypatch, tmp_path
):
    storage_root = tmp_path / "storage"
    monkeypatch.setattr(settings, "storage_local_root", str(storage_root))
    buffer = BytesIO()
    Image.new("RGB", (900, 600), (87, 184, 160)).save(buffer, format="PNG")

    response = await client.post(
        "/api/v1/auth/me/avatar",
        files={"file": ("portrait.png", buffer.getvalue(), "image/png")},
        headers=auth,
    )

    assert response.status_code == 200, response.text
    avatar_url = response.json()["avatar_url"]
    assert avatar_url.startswith("/api/v1/auth/avatars/avatar-")
    stored = storage_root / "avatars" / avatar_url.rsplit("/", 1)[-1]
    assert stored.exists()
    with Image.open(stored) as avatar:
        assert avatar.format == "WEBP"
        assert avatar.size == (512, 512)
    current = await client.get("/api/v1/auth/me", headers=auth)
    assert current.json()["avatar_url"] == avatar_url
    served = await client.get(avatar_url)
    assert served.status_code == 200
    assert served.headers["content-type"] == "image/webp"

    replacement = BytesIO()
    Image.new("RGB", (600, 900), (105, 91, 210)).save(replacement, format="JPEG")
    replaced = await client.post(
        "/api/v1/auth/me/avatar",
        files={"file": ("replacement.jpg", replacement.getvalue(), "image/jpeg")},
        headers=auth,
    )
    assert replaced.status_code == 200
    assert replaced.json()["avatar_url"] != avatar_url
    assert not stored.exists()


async def test_upload_avatar_rejects_fake_image(client: AsyncClient, auth: dict):
    response = await client.post(
        "/api/v1/auth/me/avatar",
        files={"file": ("fake.png", b"not-an-image", "image/png")},
        headers=auth,
    )
    assert response.status_code == 400
    assert "无法识别" in response.json()["detail"]


async def test_update_ui_preferences(client: AsyncClient, auth: dict):
    response = await client.patch(
        "/api/v1/auth/me",
        json={
            "timezone": "Asia/Shanghai",
            "language": "zh-CN",
            "week_start": "monday",
            "study_days": ["mon", "wed", "fri", "sat"],
            "availability_windows": ["early_morning", "evening"],
            "weekly_availability": {
                "mon": [
                    {"start": "09:00", "end": "12:00"},
                    {"start": "19:30", "end": "22:30"},
                ],
                "sat": [{"start": "10:00", "end": "16:00"}],
            },
            "ui_experience": "minimal",
            "ui_theme": "notebook",
            "ui_accent": "newspaper",
            "font_density": "compact",
            "preferred_start_method": "import_plan",
            "onboarding_completed": True,
        },
        headers=auth,
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ui_experience"] == "minimal"
    assert payload["ui_theme"] == "notebook"
    assert payload["ui_accent"] == "newspaper"
    assert payload["language"] == "zh-CN"
    assert payload["week_start"] == "monday"
    assert payload["study_days"] == ["mon", "wed", "fri", "sat"]
    assert payload["availability_windows"] == ["early_morning", "evening"]
    assert payload["weekly_availability"]["mon"][1] == {
        "start": "19:30",
        "end": "22:30",
    }
    assert payload["font_density"] == "compact"
    assert payload["preferred_start_method"] == "import_plan"
    assert payload["onboarding_completed"] is True


async def test_update_weekly_availability_rejects_overlaps(client: AsyncClient, auth: dict):
    response = await client.patch(
        "/api/v1/auth/me",
        json={
            "weekly_availability": {
                "mon": [
                    {"start": "09:00", "end": "12:00"},
                    {"start": "11:30", "end": "13:00"},
                ]
            }
        },
        headers=auth,
    )
    assert response.status_code == 422
    assert "不能重叠" in response.text


async def test_me_delete(client: AsyncClient, user_token: str):
    headers = {"Authorization": f"Bearer {user_token}"}
    r = await client.delete("/api/v1/auth/me", headers=headers)
    assert r.status_code == 204
    r2 = await client.get("/api/v1/auth/me", headers=headers)
    assert r2.status_code == 401
