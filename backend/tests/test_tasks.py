from datetime import date, timedelta

from httpx import AsyncClient
from sqlalchemy import select

from src.models import LearningEvent, TaskMasteryRecord


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


async def test_task_optimistic_version_and_complete_event(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    created = await client.post(
        "/api/v1/tasks",
        json={"title": "版本任务", "goalId": goal_id, "date": _today()},
        headers=auth,
    )
    task = created.json()
    assert task["version"] == 1

    updated = await client.patch(
        f"/api/v1/tasks/{task['id']}",
        json={"done": True, "mastery_level": "L2", "expectedVersion": 1},
        headers=auth,
    )
    assert updated.status_code == 200
    assert updated.json()["version"] == 2

    stale = await client.patch(
        f"/api/v1/tasks/{task['id']}",
        json={"priority": "high", "expectedVersion": 1},
        headers=auth,
    )
    assert stale.status_code == 409
    assert stale.json()["actual_version"] == 2

    event_types = set(
        (
            await db.execute(
                select(LearningEvent.event_type).where(
                    LearningEvent.aggregate_id == task["id"]
                )
            )
        ).scalars()
    )
    assert {"TaskCreated", "TaskCompleted", "MasteryRecorded"} <= event_types
    mastery = await db.scalar(
        select(TaskMasteryRecord).where(TaskMasteryRecord.task_id == task["id"])
    )
    assert mastery is not None
    assert mastery.mastery_level == "L2"

    stale_delete = await client.delete(
        f"/api/v1/tasks/{task['id']}?expected_version=1", headers=auth
    )
    assert stale_delete.status_code == 409
    current_delete = await client.delete(
        f"/api/v1/tasks/{task['id']}?expected_version=2", headers=auth
    )
    assert current_delete.status_code == 204
