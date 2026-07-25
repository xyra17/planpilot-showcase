from datetime import date, timedelta

from httpx import AsyncClient


def _today() -> str:
    return date.today().isoformat()


def _future(days=1) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


async def test_create_task(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.post(
        "/api/v1/tasks",
        json={"title": "学习变量", "goalId": goal_id, "date": _today(), "estimatedMinutes": 45},
        headers=auth,
    )
    assert r.status_code == 201
    data = r.json()
    assert data["title"] == "学习变量"
    assert data["done"] is False
    assert data["estimatedMinutes"] == 45


async def test_create_task_unknown_goal(client: AsyncClient, auth: dict):
    r = await client.post(
        "/api/v1/tasks",
        json={"title": "t", "goalId": "nonexistent", "date": _today()},
        headers=auth,
    )
    assert r.status_code == 404


async def test_list_tasks(client: AsyncClient, auth: dict, goal_id: str):
    await client.post(
        "/api/v1/tasks",
        json={"title": "任务A", "goalId": goal_id, "date": _today()},
        headers=auth,
    )
    r = await client.get("/api/v1/tasks", headers=auth)
    assert r.status_code == 200
    titles = [t["title"] for t in r.json()]
    assert "任务A" in titles


async def test_update_task_done(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.post(
        "/api/v1/tasks",
        json={"title": "待完成任务", "goalId": goal_id, "date": _today()},
        headers=auth,
    )
    tid = r.json()["id"]
    r2 = await client.patch(f"/api/v1/tasks/{tid}", json={"done": True}, headers=auth)
    assert r2.status_code == 200
    assert r2.json()["done"] is True


async def test_update_task_not_found(client: AsyncClient, auth: dict):
    r = await client.patch("/api/v1/tasks/nonexistent", json={"done": True}, headers=auth)
    assert r.status_code == 404


async def test_delete_task(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.post(
        "/api/v1/tasks",
        json={"title": "要删的任务", "goalId": goal_id, "date": _today()},
        headers=auth,
    )
    tid = r.json()["id"]
    r_del = await client.delete(f"/api/v1/tasks/{tid}", headers=auth)
    assert r_del.status_code == 204
