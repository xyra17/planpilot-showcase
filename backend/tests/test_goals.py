from datetime import date, timedelta

import pytest
from httpx import AsyncClient


def _future(days=365) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


async def test_create_goal(client: AsyncClient, auth: dict):
    r = await client.post(
        "/api/v1/goals",
        json={"type": "skill", "title": "学 Python", "deadline": _future(), "daily_hours": 2.0},
        headers=auth,
    )
    assert r.status_code == 201
    data = r.json()
    assert data["title"] == "学 Python"
    assert data["status"] == "active"


async def test_list_goals(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.get("/api/v1/goals", headers=auth)
    assert r.status_code == 200
    ids = [g["id"] for g in r.json()]
    assert goal_id in ids


async def test_get_goal(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.get(f"/api/v1/goals/{goal_id}", headers=auth)
    assert r.status_code == 200
    assert r.json()["id"] == goal_id


async def test_get_goal_not_found(client: AsyncClient, auth: dict):
    r = await client.get("/api/v1/goals/nonexistent", headers=auth)
    assert r.status_code == 404


async def test_patch_goal_status(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.patch(f"/api/v1/goals/{goal_id}", json={"status": "paused"}, headers=auth)
    assert r.status_code == 200
    assert r.json()["status"] == "paused"


async def test_patch_goal_invalid_status(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.patch(f"/api/v1/goals/{goal_id}", json={"status": "invalid"}, headers=auth)
    assert r.status_code == 422


async def test_delete_goal(client: AsyncClient, auth: dict):
    r_create = await client.post(
        "/api/v1/goals",
        json={"type": "exam", "title": "删除目标", "deadline": _future(), "daily_hours": 1.0},
        headers=auth,
    )
    gid = r_create.json()["id"]
    r_del = await client.delete(f"/api/v1/goals/{gid}", headers=auth)
    assert r_del.status_code == 204
    r_get = await client.get(f"/api/v1/goals/{gid}", headers=auth)
    assert r_get.status_code == 404


async def test_goal_requires_future_deadline(client: AsyncClient, auth: dict):
    r = await client.post(
        "/api/v1/goals",
        json={"type": "skill", "title": "过期目标", "deadline": "2020-01-01", "daily_hours": 2.0},
        headers=auth,
    )
    assert r.status_code == 422


async def test_goal_progress(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.get(f"/api/v1/goals/{goal_id}/progress", headers=auth)
    assert r.status_code == 200
    data = r.json()
    assert "total_tasks" in data
    assert "streak_days" in data
