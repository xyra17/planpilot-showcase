import uuid

import pytest


async def register_device(client, auth) -> str:
    response = await client.put(
        "/api/v1/devices/current",
        headers=auth,
        json={
            "installation_id": f"offline-{uuid.uuid4().hex}",
            "name": "Offline Test Mac",
            "platform": "darwin",
            "app_version": "0.1.0-beta.2",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


@pytest.mark.asyncio
async def test_offline_conflict_preserves_both_versions_until_user_confirmation(
    client, auth, goal_id
):
    workspace = (await client.get("/api/v1/workspaces", headers=auth)).json()[0]
    device_id = await register_device(client, auth)
    goal = (await client.get(f"/api/v1/goals/{goal_id}", headers=auth)).json()
    original_title = goal["title"]
    operation_id = f"operation-{uuid.uuid4().hex}"
    staged = await client.post(
        "/api/v1/sync/operations",
        headers=auth,
        json={
            "operation_id": operation_id,
            "workspace_id": workspace["id"],
            "device_id": device_id,
            "operation_type": "update",
            "entity_type": "goal",
            "entity_id": goal_id,
            "base_version": max(0, goal["version"] - 1),
            "local_snapshot": {"title": "离线修改的标题"},
        },
    )
    assert staged.status_code == 201, staged.text
    payload = staged.json()
    assert payload["status"] == "conflict"
    assert payload["requires_user_confirmation"] is True
    assert payload["local_snapshot"]["title"] == "离线修改的标题"
    assert payload["server_snapshot"]["title"] == original_title

    resolved = await client.post(
        f"/api/v1/sync/operations/{operation_id}/resolve",
        headers=auth,
        json={"action": "keep_both"},
    )
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["status"] == "ready_copy"
    assert resolved.json()["resolution"] == "keep_both"
    # The generic protocol never overwrites the server object.
    unchanged = await client.get(f"/api/v1/goals/{goal_id}", headers=auth)
    assert unchanged.json()["title"] == original_title


@pytest.mark.asyncio
async def test_offline_operation_is_idempotent_and_rejects_reused_operation_id(
    client, auth, goal_id
):
    workspace = (await client.get("/api/v1/workspaces", headers=auth)).json()[0]
    device_id = await register_device(client, auth)
    goal = (await client.get(f"/api/v1/goals/{goal_id}", headers=auth)).json()
    operation_id = f"operation-{uuid.uuid4().hex}"
    body = {
        "operation_id": operation_id,
        "workspace_id": workspace["id"],
        "device_id": device_id,
        "operation_type": "update",
        "entity_type": "goal",
        "entity_id": goal_id,
        "base_version": goal["version"],
        "local_snapshot": {"title": "本机草案"},
    }
    first = await client.post("/api/v1/sync/operations", headers=auth, json=body)
    second = await client.post("/api/v1/sync/operations", headers=auth, json=body)
    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json()["id"] == second.json()["id"]
    assert first.json()["status"] == "queued"

    reused = await client.post(
        "/api/v1/sync/operations",
        headers=auth,
        json={**body, "local_snapshot": {"title": "另一份内容"}},
    )
    assert reused.status_code == 409
    assert "operation_id" in reused.text
