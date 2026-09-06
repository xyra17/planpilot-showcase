import uuid

import pytest


@pytest.mark.asyncio
async def test_registration_creates_default_cloud_workspace(client, auth):
    response = await client.get("/api/v1/workspaces", headers=auth)
    assert response.status_code == 200, response.text
    workspaces = response.json()
    assert len(workspaces) == 1
    assert workspaces[0]["name"] == "我的学习空间"
    assert workspaces[0]["kind"] == "cloud"
    assert workspaces[0]["is_default"] is True


@pytest.mark.asyncio
async def test_device_registry_is_account_scoped(client, auth):
    installation_id = f"desktop-{uuid.uuid4().hex}"
    created = await client.put(
        "/api/v1/devices/current",
        headers=auth,
        json={
            "installation_id": installation_id,
            "name": "Test Mac",
            "platform": "darwin",
            "app_version": "0.1.0-beta.2",
        },
    )
    assert created.status_code == 200, created.text
    listed = await client.get("/api/v1/devices", headers=auth)
    assert listed.status_code == 200, listed.text
    assert [item["installation_id"] for item in listed.json()] == [installation_id]

    revoked = await client.delete(f"/api/v1/devices/{created.json()['id']}", headers=auth)
    assert revoked.status_code == 204, revoked.text
    after = await client.get("/api/v1/devices", headers=auth)
    assert after.json()[0]["revoked_at"] is not None
