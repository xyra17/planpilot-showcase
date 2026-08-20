import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


async def test_register_success(client: AsyncClient, shared: dict, seed: dict):
    r = await client.post("/api/v1/auth/register", json=seed["user"])
    assert r.status_code == 201, r.text
    data = r.json()
    assert "access_token" not in data
    assert r.cookies.get("pp_access")
    assert data["user"]["email"] == seed["user"]["email"]
    shared["user_id"] = data["user"]["id"]


async def test_register_duplicate_email(client: AsyncClient, seed: dict):
    r = await client.post("/api/v1/auth/register", json=seed["user"])
    assert r.status_code == 400
    assert "邮箱" in r.json()["detail"]


async def test_register_second_user(client: AsyncClient, shared: dict, seed: dict):
    r = await client.post("/api/v1/auth/register", json=seed["user2"])
    assert r.status_code == 201
    shared["user2_token"] = r.cookies.get("pp_access")


async def test_login_success(client: AsyncClient, seed: dict):
    r = await client.post(
        "/api/v1/auth/login",
        json={"email": seed["user"]["email"], "password": seed["user"]["password"]},
    )
    assert r.status_code == 200
    assert "access_token" not in r.json()
    assert r.cookies.get("pp_access")


async def test_login_wrong_password(client: AsyncClient, seed: dict):
    r = await client.post(
        "/api/v1/auth/login",
        json={"email": seed["user"]["email"], "password": "wrongpass"},
    )
    assert r.status_code == 401


async def test_me_authenticated(client: AsyncClient, auth_headers: dict, seed: dict):
    r = await client.get("/api/v1/auth/me", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["email"] == seed["user"]["email"]


async def test_me_unauthenticated(client: AsyncClient):
    client.cookies.clear()
    r = await client.get("/api/v1/auth/me")
    assert r.status_code in (401, 403)


async def test_update_username(client: AsyncClient, auth_headers: dict):
    r = await client.patch(
        "/api/v1/auth/me",
        json={"username": "int_tester_updated"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["username"] == "int_tester_updated"
