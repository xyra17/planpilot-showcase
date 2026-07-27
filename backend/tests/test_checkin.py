
from datetime import date, timedelta

from httpx import AsyncClient
from sqlalchemy import select

from src.models import CheckinRecord, Goal


async def test_checkin_quick_all_done(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={"mode": "quick", "quick_status": "all_done"},
        headers=auth,
    )
    assert r.status_code == 200
    data = r.json()
    assert data["stats"]["completion_rate"] == 1.0
    assert "太棒了" in data["feedback"]


async def test_checkin_quick_barely_done(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={"mode": "quick", "quick_status": "barely_done"},
        headers=auth,
    )
    assert r.status_code == 200
    assert r.json()["stats"]["completion_rate"] == 0.1


async def test_checkin_natural(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={"mode": "natural", "text": "今天学了函数和类，感觉还好"},
        headers=auth,
    )
    assert r.status_code == 200
    assert r.json()["stats"]["completion_rate"] == 0.5


async def test_checkin_task_list(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={
            "mode": "task_list",
            "tasks": [
                {"task_id": "t1", "status": "completed"},
                {"task_id": "t2", "status": "partial"},
                {"task_id": "t3", "status": "skipped"},
            ],
        },
        headers=auth,
    )
    assert r.status_code == 200
    data = r.json()
    stats = data["stats"]
    assert stats["completed"] == 1
    assert stats["partial"] == 1
    assert stats["skipped"] == 1
    # completion_rate = (1 + 0.5*1) / 3
    assert abs(stats["completion_rate"] - 0.5) < 0.01


async def test_checkin_unknown_goal(client: AsyncClient, auth: dict):
    r = await client.post(
        "/api/v1/checkin/nonexistent",
        json={"mode": "quick", "quick_status": "all_done"},
        headers=auth,
    )
    assert r.status_code == 404


async def test_daily_checkin_is_persisted_and_updated(
    client: AsyncClient, auth: dict, goal_id: str
):
    today = date.today().isoformat()
    created = await client.post(
        "/api/v1/tasks",
        json={
            "title": "今日学习任务",
            "goalId": goal_id,
            "done": False,
            "estimatedMinutes": 30,
            "date": today,
        },
        headers=auth,
    )
    task_id = created.json()["id"]

    first = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={
            "mode": "daily",
            "tasks": [{
                "task_id": task_id,
                "status": "pending",
                "mastery": "L2",
                "note": "还需要复习",
            }],
        },
        headers=auth,
    )
    assert first.status_code == 200
    assert first.json()["stats"]["completion_rate"] == 0
    assert first.json()["stats"]["mastery_rate"] == 0.5

    second = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={
            "mode": "daily",
            "tasks": [{
                "task_id": task_id,
                "status": "completed",
                "mastery": "L3",
                "note": "已经掌握",
            }],
        },
        headers=auth,
    )
    assert second.status_code == 200

    loaded = await client.get(
        f"/api/v1/checkin/{goal_id}/today",
        headers=auth,
    )
    assert loaded.status_code == 200
    data = loaded.json()
    assert data["stats"]["completion_rate"] == 1
    assert data["stats"]["mastery_rate"] == 1
    assert data["tasks"] == [{
        "task_id": task_id,
        "status": "completed",
        "mastery": "L3",
        "actual_mins": None,
        "note": "已经掌握",
    }]


async def test_replan_uses_three_distinct_study_days(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    goal = (await db.execute(
        select(Goal).where(Goal.id == goal_id)
    )).scalar_one()
    today = date.today()
    for offset in (2, 1):
        db.add(CheckinRecord(
            goal_id=goal_id,
            user_id=goal.user_id,
            date=(today - timedelta(days=offset)).isoformat(),
            mode="daily",
            completion_rate=0.25,
            stats={"total_tasks": 1},
            feedback="",
        ))
    await db.commit()

    created = await client.post(
        "/api/v1/tasks",
        json={
            "title": "未执行任务",
            "goalId": goal_id,
            "done": False,
            "estimatedMinutes": 30,
            "date": today.isoformat(),
        },
        headers=auth,
    )
    task_id = created.json()["id"]
    current = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={
            "mode": "daily",
            "tasks": [{
                "task_id": task_id,
                "status": "pending",
                "mastery": "L1",
            }],
        },
        headers=auth,
    )
    assert current.status_code == 200
    assert current.json()["replan_triggered"] is True
