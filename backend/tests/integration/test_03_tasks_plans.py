from datetime import date, timedelta

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


def _today() -> str:
    return date.today().isoformat()


def _future(days: int = 1) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


async def test_create_tasks_batch(client: AsyncClient, auth_headers: dict, shared: dict, seed: dict):
    goal_id = shared["goal_id_1"]
    task_ids = []
    for t in seed["tasks"]:
        r = await client.post(
            "/api/v1/tasks",
            json={
                "title": t["title"],
                "goalId": goal_id,
                "date": _today(),
                "estimatedMinutes": t["estimated_mins"],
            },
            headers=auth_headers,
        )
        assert r.status_code == 201, r.text
        task_ids.append(r.json()["id"])
    shared["task_ids"] = task_ids


async def test_list_tasks_today(client: AsyncClient, auth_headers: dict, shared: dict, seed: dict):
    r = await client.get(f"/api/v1/tasks?date={_today()}", headers=auth_headers)
    assert r.status_code == 200
    titles = [t["title"] for t in r.json()]
    for t in seed["tasks"]:
        assert t["title"] in titles


async def test_mark_task_done(client: AsyncClient, auth_headers: dict, shared: dict):
    task_id = shared["task_ids"][0]
    r = await client.patch(f"/api/v1/tasks/{task_id}", json={"done": True}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["done"] is True


async def test_mark_task_undone(client: AsyncClient, auth_headers: dict, shared: dict):
    task_id = shared["task_ids"][0]
    r = await client.patch(f"/api/v1/tasks/{task_id}", json={"done": False}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["done"] is False


async def test_delete_task(client: AsyncClient, auth_headers: dict, shared: dict):
    # 创建一个专门用于删除的任务
    r = await client.post(
        "/api/v1/tasks",
        json={"title": "将被删除的任务", "goalId": shared["goal_id_1"], "date": _today()},
        headers=auth_headers,
    )
    tid = r.json()["id"]
    r_del = await client.delete(f"/api/v1/tasks/{tid}", headers=auth_headers)
    assert r_del.status_code == 204
    r_list = await client.get("/api/v1/tasks", headers=auth_headers)
    titles = [t["title"] for t in r_list.json()]
    assert "将被删除的任务" not in titles


async def test_today_tasks_via_plans(client: AsyncClient, auth_headers: dict, shared: dict):
    r = await client.get(f"/api/v1/plans/{shared['goal_id_1']}/today", headers=auth_headers)
    assert r.status_code == 200
    tasks = r.json()
    assert isinstance(tasks, list)
    assert len(tasks) > 0
    task = tasks[0]
    assert "id" in task
    assert "title" in task
    assert "estimated_mins" in task
    assert "status" in task


async def test_schedule_get_empty(client: AsyncClient, auth_headers: dict):
    r = await client.get("/api/v1/schedule/today", headers=auth_headers)
    assert r.status_code == 200


async def test_schedule_save_and_retrieve(client: AsyncClient, auth_headers: dict, shared: dict, seed: dict):
    blocks = seed["schedule_blocks"]
    r = await client.put(
        "/api/v1/schedule/today",
        json={"blocks": blocks},
        headers=auth_headers,
    )
    assert r.status_code == 200

    r2 = await client.get("/api/v1/schedule/today", headers=auth_headers)
    assert r2.status_code == 200
    saved_blocks = r2.json().get("blocks", [])
    assert len(saved_blocks) == len(blocks)
    labels = [b["label"] for b in saved_blocks]
    assert "早间学习" in labels
