from datetime import date, timedelta

import pytest
from httpx import AsyncClient


async def test_today_tasks_empty(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.get(f"/api/v1/plans/{goal_id}/today", headers=auth)
    assert r.status_code == 200
    # 无今日任务时，返回最近 pending 任务（目标刚建立，无任务 → []）
    assert isinstance(r.json(), list)


async def test_today_tasks_with_scheduled(client: AsyncClient, auth: dict, goal_id: str):
    today = date.today().isoformat()
    # 创建今日任务
    await client.post(
        "/api/v1/tasks",
        json={"title": "今日任务1", "goalId": goal_id, "date": today, "estimatedMinutes": 30},
        headers=auth,
    )
    await client.post(
        "/api/v1/tasks",
        json={"title": "今日任务2", "goalId": goal_id, "date": today, "estimatedMinutes": 45},
        headers=auth,
    )
    r = await client.get(f"/api/v1/plans/{goal_id}/today", headers=auth)
    assert r.status_code == 200
    tasks = r.json()
    titles = [t["title"] for t in tasks]
    assert "今日任务1" in titles
    assert "今日任务2" in titles


async def test_today_tasks_fallback_to_pending(client: AsyncClient, auth: dict, goal_id: str):
    # 创建非今日任务（明天），今日无排期 → 应 fallback 到 pending
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    await client.post(
        "/api/v1/tasks",
        json={"title": "明日待办", "goalId": goal_id, "date": tomorrow, "estimatedMinutes": 20},
        headers=auth,
    )
    r = await client.get(f"/api/v1/plans/{goal_id}/today", headers=auth)
    assert r.status_code == 200
    tasks = r.json()
    # fallback 应该返回 pending 任务
    assert any(t["title"] == "明日待办" for t in tasks)


async def test_today_tasks_unknown_goal(client: AsyncClient, auth: dict):
    r = await client.get("/api/v1/plans/nonexistent/today", headers=auth)
    assert r.status_code == 404


async def test_today_task_fields(client: AsyncClient, auth: dict, goal_id: str):
    today = date.today().isoformat()
    await client.post(
        "/api/v1/tasks",
        json={"title": "字段测试任务", "goalId": goal_id, "date": today},
        headers=auth,
    )
    r = await client.get(f"/api/v1/plans/{goal_id}/today", headers=auth)
    task = next(t for t in r.json() if t["title"] == "字段测试任务")
    assert "id" in task
    assert "estimated_mins" in task
    assert "status" in task
    assert "kb_refs" in task
    assert "mastery_level" in task
