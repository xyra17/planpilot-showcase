from datetime import date, timedelta

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


def _future(days: int = 365) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


async def test_create_goal_exam(client: AsyncClient, auth_headers: dict, shared: dict, seed: dict):
    payload = seed["goals"][0]
    r = await client.post("/api/v1/goals", json=payload, headers=auth_headers)
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["title"] == payload["title"]
    assert data["status"] == "active"
    assert data["type"] == "exam"
    shared["goal_id_1"] = data["id"]


async def test_create_goal_skill(client: AsyncClient, auth_headers: dict, shared: dict, seed: dict):
    payload = seed["goals"][1]
    r = await client.post("/api/v1/goals", json=payload, headers=auth_headers)
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["type"] == "skill"
    shared["goal_id_2"] = data["id"]


async def test_list_goals_contains_both(client: AsyncClient, auth_headers: dict, shared: dict):
    r = await client.get("/api/v1/goals", headers=auth_headers)
    assert r.status_code == 200
    ids = [g["id"] for g in r.json()]
    assert shared["goal_id_1"] in ids
    assert shared["goal_id_2"] in ids


async def test_get_goal_detail(client: AsyncClient, auth_headers: dict, shared: dict):
    r = await client.get(f"/api/v1/goals/{shared['goal_id_1']}", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["id"] == shared["goal_id_1"]


async def test_get_goal_not_found(client: AsyncClient, auth_headers: dict):
    r = await client.get("/api/v1/goals/nonexistent-id", headers=auth_headers)
    assert r.status_code == 404


async def test_patch_goal_status(client: AsyncClient, auth_headers: dict, shared: dict):
    r = await client.patch(
        f"/api/v1/goals/{shared['goal_id_2']}",
        json={"status": "paused"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["status"] == "paused"
    # 恢复 active 供后续测试使用
    await client.patch(
        f"/api/v1/goals/{shared['goal_id_2']}",
        json={"status": "active"},
        headers=auth_headers,
    )


async def test_goal_progress(client: AsyncClient, auth_headers: dict, shared: dict):
    r = await client.get(f"/api/v1/goals/{shared['goal_id_1']}/progress", headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    assert "total_tasks" in data
    assert "completed_tasks" in data
    assert "streak_days" in data
    assert "avg_completion_rate" in data


async def test_other_user_cannot_access(client: AsyncClient, shared: dict):
    headers = {"Authorization": f"Bearer {shared['user2_token']}"}
    r = await client.get(f"/api/v1/goals/{shared['goal_id_1']}", headers=headers)
    assert r.status_code == 404
