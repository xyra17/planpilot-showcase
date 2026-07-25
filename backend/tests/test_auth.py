import uuid

from httpx import AsyncClient


def _creds():
    uid = uuid.uuid4().hex[:8]
    return {"email": f"{uid}@test.com", "username": uid, "password": "pass1234"}


async def test_register_ok(client: AsyncClient):
    r = await client.post("/api/v1/auth/register", json=_creds())
    assert r.status_code == 201
    data = r.json()
    assert "access_token" in data
    assert data["user"]["email"].endswith("@test.com")


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


async def test_login_ok(client: AsyncClient):
    creds = _creds()
    await client.post("/api/v1/auth/register", json=creds)
    r = await client.post(
        "/api/v1/auth/login",
        json={"email": creds["email"], "password": creds["password"]},
    )
    assert r.status_code == 200
    assert "access_token" in r.json()


async def test_login_wrong_password(client: AsyncClient):
    creds = _creds()
    await client.post("/api/v1/auth/register", json=creds)
    r = await client.post(
        "/api/v1/auth/login",
        json={"email": creds["email"], "password": "wrongpass"},
    )
    assert r.status_code == 401


async def test_login_unknown_email(client: AsyncClient):
    r = await client.post(
        "/api/v1/auth/login",
        json={"email": "nobody@nowhere.com", "password": "x"},
    )
    assert r.status_code == 401


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


async def test_me_delete(client: AsyncClient, user_token: str):
    headers = {"Authorization": f"Bearer {user_token}"}
    r = await client.delete("/api/v1/auth/me", headers=headers)
    assert r.status_code == 204
    r2 = await client.get("/api/v1/auth/me", headers=headers)
    assert r2.status_code == 401
