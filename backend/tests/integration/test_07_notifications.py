import pytest
from httpx import AsyncClient


pytestmark = pytest.mark.integration


async def test_list_notifications_initial(client: AsyncClient, auth_headers: dict, shared: dict):
    r = await client.get("/api/v1/notifications", headers=auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "unread_count" in data
    assert "items" in data
    assert isinstance(data["items"], list)
    assert isinstance(data["unread_count"], int)
    shared["initial_notification_count"] = len(data["items"])


async def test_mark_all_read(client: AsyncClient, auth_headers: dict):
    r = await client.patch("/api/v1/notifications/mark-read", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


async def test_list_after_mark_read(client: AsyncClient, auth_headers: dict):
    r = await client.get("/api/v1/notifications", headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    assert data["unread_count"] == 0
    # 所有 item 的 is_read 应为 True
    for item in data["items"]:
        assert item["is_read"] is True


async def test_clear_notifications(client: AsyncClient, auth_headers: dict):
    r = await client.delete("/api/v1/notifications", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    # 验证清空后列表为空
    r2 = await client.get("/api/v1/notifications", headers=auth_headers)
    assert r2.json()["unread_count"] == 0
    assert r2.json()["items"] == []
