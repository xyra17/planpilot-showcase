"""Learning Events 集成测试

验证：
- Service 操作触发正确的事件写入
- Event payload 内容正确
- 事件与 domain change 原子落库
"""

from datetime import date, timedelta

from httpx import AsyncClient
from sqlalchemy import select

from src.core.time import local_date_for_timezone
from src.events.publisher import emit
from src.models import Goal, LearningEvent, User


def _future(days=365) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


async def test_create_goal_emits_goal_created(client: AsyncClient, auth: dict, db):
    r = await client.post(
        "/api/v1/goals",
        json={"type": "skill", "title": "学Python", "deadline": _future(), "daily_hours": 2.0},
        headers=auth,
    )
    assert r.status_code == 201
    goal_id = r.json()["id"]

    events = (
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.event_type == "GoalCreated",
                    LearningEvent.aggregate_id == goal_id,
                )
            )
        )
        .scalars()
        .all()
    )

    assert len(events) == 1
    event = events[0]
    assert event.aggregate_type == "goal"
    assert event.payload["title"] == "学Python"
    assert event.payload["type"] == "skill"


async def test_update_goal_status_emits_goal_status_changed(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    r = await client.patch(
        f"/api/v1/goals/{goal_id}",
        json={"status": "paused"},
        headers=auth,
    )
    assert r.status_code == 200

    events = (
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.event_type == "GoalStatusChanged",
                    LearningEvent.aggregate_id == goal_id,
                )
            )
        )
        .scalars()
        .all()
    )

    assert len(events) == 1
    event = events[0]
    assert event.payload["from_status"] == "active"
    assert event.payload["to_status"] == "paused"


async def test_update_goal_fields_emits_goal_updated(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    r = await client.patch(
        f"/api/v1/goals/{goal_id}",
        json={"title": "新标题", "daily_hours": 3.0},
        headers=auth,
    )
    assert r.status_code == 200

    events = (
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.event_type == "GoalUpdated",
                    LearningEvent.aggregate_id == goal_id,
                )
            )
        )
        .scalars()
        .all()
    )

    assert len(events) == 1
    event = events[0]
    assert "title" in event.payload["changed_fields"]
    assert "daily_hours" in event.payload["changed_fields"]
    assert event.payload["after"]["title"] == "新标题"


async def test_create_task_emits_task_created(client: AsyncClient, auth: dict, goal_id: str, db):
    today = date.today().isoformat()
    r = await client.post(
        "/api/v1/tasks",
        json={"title": "学习变量", "goalId": goal_id, "date": today, "estimatedMinutes": 30},
        headers=auth,
    )
    assert r.status_code == 201
    task_id = r.json()["id"]

    events = (
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.event_type == "TaskCreated",
                    LearningEvent.aggregate_id == task_id,
                )
            )
        )
        .scalars()
        .all()
    )

    assert len(events) == 1
    event = events[0]
    assert event.aggregate_type == "task"
    assert event.payload["title"] == "学习变量"
    assert event.payload["scheduled_date"] == today


async def test_complete_task_emits_task_completed(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    today = date.today().isoformat()
    r = await client.post(
        "/api/v1/tasks",
        json={"title": "待完成任务", "goalId": goal_id, "date": today},
        headers=auth,
    )
    task_id = r.json()["id"]

    r2 = await client.patch(f"/api/v1/tasks/{task_id}", json={"done": True}, headers=auth)
    assert r2.status_code == 200

    events = (
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.event_type == "TaskCompleted",
                    LearningEvent.aggregate_id == task_id,
                )
            )
        )
        .scalars()
        .all()
    )

    assert len(events) == 1
    event = events[0]
    assert event.payload["title"] == "待完成任务"
    assert event.payload["days_overdue"] == 0
    started = await db.scalar(
        select(LearningEvent).where(
            LearningEvent.event_type == "TaskStarted",
            LearningEvent.aggregate_id == task_id,
        )
    )
    assert started is not None
    assert started.payload["trigger"] == "task_completion_backfill"


async def test_reschedule_task_emits_task_rescheduled(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    today = date.today().isoformat()
    tomorrow = (date.today() + timedelta(days=1)).isoformat()

    r = await client.post(
        "/api/v1/tasks",
        json={"title": "改期任务", "goalId": goal_id, "date": today},
        headers=auth,
    )
    task_id = r.json()["id"]

    r2 = await client.patch(f"/api/v1/tasks/{task_id}", json={"date": tomorrow}, headers=auth)
    assert r2.status_code == 200

    events = (
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.event_type == "TaskRescheduled",
                    LearningEvent.aggregate_id == task_id,
                )
            )
        )
        .scalars()
        .all()
    )

    assert len(events) == 1
    event = events[0]
    assert event.payload["from_date"] == today
    assert event.payload["to_date"] == tomorrow


async def test_scheduled_window_observation_is_idempotent_and_emits_task_started(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    user = await db.scalar(select(User).join(Goal).where(Goal.id == goal_id))
    today = local_date_for_timezone(user.timezone).isoformat()
    created = await client.post(
        "/api/v1/tasks",
        json={"title": "开始事件任务", "goalId": goal_id, "date": today},
        headers=auth,
    )
    task_id = created.json()["id"]

    scheduled = await client.put(
        "/api/v1/schedule/today",
        json={
            "blocks": [
                {
                    "id": "active-observation-window",
                    "label": "开始事件任务",
                    "taskId": task_id,
                    "goalTitle": "测试目标",
                    "startHour": 0,
                    "durationMinutes": 1440,
                    "color": "#7c6cf2",
                    "progress": 0,
                }
            ]
        },
        headers=auth,
    )
    assert scheduled.status_code == 200
    before_observation = await db.scalar(
        select(LearningEvent).where(
            LearningEvent.event_type == "TaskStarted",
            LearningEvent.aggregate_id == task_id,
        )
    )
    assert before_observation is None

    first = await client.post(f"/api/v1/tasks/{task_id}/observe-start", headers=auth)
    retry = await client.post(f"/api/v1/tasks/{task_id}/observe-start", headers=auth)

    assert first.status_code == 200
    assert first.json()["status"] == "in_progress"
    assert retry.status_code == 200
    events = list(
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.event_type == "TaskStarted",
                    LearningEvent.aggregate_id == task_id,
                )
            )
        ).scalars()
    )
    assert len(events) == 1
    assert events[0].payload["from_status"] == "pending"
    assert events[0].payload["trigger"] == "schedule_window_observed"
    assert events[0].payload["observed_via"] == "today_workspace_active"


async def test_actual_minutes_backfill_task_started_without_visible_start_action(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    today = date.today().isoformat()
    created = await client.post(
        "/api/v1/tasks",
        json={"title": "投入触发开始", "goalId": goal_id, "date": today},
        headers=auth,
    )
    task_id = created.json()["id"]

    recorded = await client.patch(
        f"/api/v1/tasks/{task_id}",
        json={"actual_mins": 15},
        headers=auth,
    )

    assert recorded.status_code == 200
    assert recorded.json()["status"] == "in_progress"
    started = await db.scalar(
        select(LearningEvent).where(
            LearningEvent.event_type == "TaskStarted",
            LearningEvent.aggregate_id == task_id,
        )
    )
    assert started is not None
    assert started.payload["trigger"] == "actual_minutes_recorded"
    assert started.payload["actual_mins"] == 15


async def test_confirmed_overload_recovery_connects_selection_and_completion(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    today = date.today().isoformat()
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    created = await client.post(
        "/api/v1/tasks",
        json={"title": "负荷恢复任务", "goalId": goal_id, "date": today},
        headers=auth,
    )
    task_id = created.json()["id"]

    moved = await client.patch(
        f"/api/v1/tasks/{task_id}",
        json={
            "date": tomorrow,
            "rescheduleTrigger": "overload_recovery",
            "recoveryStrategy": "standard",
        },
        headers=auth,
    )
    assert moved.status_code == 200
    completed = await client.patch(
        f"/api/v1/tasks/{task_id}", json={"done": True}, headers=auth
    )
    assert completed.status_code == 200

    events = list(
        (
            await db.execute(
                select(LearningEvent)
                .where(LearningEvent.aggregate_id == task_id)
                .order_by(LearningEvent.occurred_at)
            )
        ).scalars()
    )
    event_types = {event.event_type for event in events}
    assert {"TaskRescheduled", "TaskStarted"} <= event_types
    recovery_events = list(
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.goal_id == goal_id,
                    LearningEvent.event_type.in_(
                        ["DeviationDetected", "RecoverySelected", "RecoveryCompleted"]
                    ),
                )
            )
        ).scalars()
    )
    by_type = {event.event_type: event for event in recovery_events}
    assert {"DeviationDetected", "RecoverySelected", "RecoveryCompleted"} <= set(by_type)
    assert by_type["RecoverySelected"].payload["strategy"] == "standard"
    assert by_type["RecoveryCompleted"].payload["action_type"] == "TaskStarted"


async def test_mastery_update_emits_mastery_recorded(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    today = date.today().isoformat()
    r = await client.post(
        "/api/v1/tasks",
        json={"title": "掌握度任务", "goalId": goal_id, "date": today},
        headers=auth,
    )
    task_id = r.json()["id"]

    r2 = await client.patch(f"/api/v1/tasks/{task_id}", json={"mastery_level": "L3"}, headers=auth)
    assert r2.status_code == 200

    events = (
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.event_type == "MasteryRecorded",
                    LearningEvent.aggregate_id == task_id,
                )
            )
        )
        .scalars()
        .all()
    )

    assert len(events) == 1
    event = events[0]
    assert event.payload["from_level"] == "unknown"
    assert event.payload["to_level"] == "L3"


async def test_checkin_submit_emits_checkin_submitted(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    # 创建今日任务
    today = date.today().isoformat()
    r1 = await client.post(
        "/api/v1/tasks",
        json={"title": "任务1", "goalId": goal_id, "date": today},
        headers=auth,
    )
    task_id = r1.json()["id"]

    # 提交打卡
    r2 = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={
            "mode": "task_list",
            "tasks": [{"task_id": task_id, "status": "completed"}],
        },
        headers=auth,
    )
    assert r2.status_code == 200

    events = (
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.event_type == "CheckinSubmitted",
                    LearningEvent.goal_id == goal_id,
                )
            )
        )
        .scalars()
        .all()
    )

    assert len(events) == 1
    event = events[0]
    assert event.aggregate_type == "checkin"
    assert event.payload["mode"] == "task_list"
    assert event.payload["completion_rate"] == 1.0
    completed_event = await db.scalar(
        select(LearningEvent).where(
            LearningEvent.event_type == "TaskCompleted",
            LearningEvent.aggregate_id == task_id,
        )
    )
    assert completed_event is not None
    assert completed_event.payload["submission_mode"] == "checkin"
    started_event = await db.scalar(
        select(LearningEvent).where(
            LearningEvent.event_type == "TaskStarted",
            LearningEvent.aggregate_id == task_id,
        )
    )
    assert started_event is not None
    assert started_event.payload["trigger"] == "checkin_completion_backfill"


async def test_partial_checkin_emits_task_started(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    today = date.today().isoformat()
    created = await client.post(
        "/api/v1/tasks",
        json={"title": "部分推进任务", "goalId": goal_id, "date": today},
        headers=auth,
    )
    task_id = created.json()["id"]

    response = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={"mode": "task_list", "tasks": [{"task_id": task_id, "status": "partial"}]},
        headers=auth,
    )
    assert response.status_code == 200
    started_event = await db.scalar(
        select(LearningEvent).where(
            LearningEvent.event_type == "TaskStarted",
            LearningEvent.aggregate_id == task_id,
        )
    )
    assert started_event is not None
    assert started_event.payload["submission_mode"] == "checkin_partial"


async def test_skip_task_emits_task_skipped(client: AsyncClient, auth: dict, goal_id: str, db):
    today = date.today().isoformat()
    r1 = await client.post(
        "/api/v1/tasks",
        json={"title": "跳过任务", "goalId": goal_id, "date": today},
        headers=auth,
    )
    task_id = r1.json()["id"]

    # 打卡时跳过
    r2 = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={
            "mode": "task_list",
            "tasks": [{"task_id": task_id, "status": "skipped", "note": "时间不足"}],
        },
        headers=auth,
    )
    assert r2.status_code == 200

    events = (
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.event_type == "TaskSkipped",
                    LearningEvent.aggregate_id == task_id,
                )
            )
        )
        .scalars()
        .all()
    )

    assert len(events) == 1
    event = events[0]
    assert event.payload["title"] == "跳过任务"
    assert event.payload["skip_reason"] == "时间不足"
    assert event.payload["debt_created"] is True


async def test_event_idempotency_key_deduplicates_retries(db, auth: dict, goal_id: str):
    user = await db.scalar(select(User))
    first = await emit(
        db,
        user_id=user.id,
        goal_id=goal_id,
        aggregate_type="task",
        aggregate_id="retry-target",
        event_type="RetrySafeEvent",
        payload={"attempt": 1},
        idempotency_key="learning-event:test:retry-safe",
    )
    await db.flush()
    second = await emit(
        db,
        user_id=user.id,
        goal_id=goal_id,
        aggregate_type="task",
        aggregate_id="retry-target",
        event_type="RetrySafeEvent",
        payload={"attempt": 2},
        idempotency_key="learning-event:test:retry-safe",
    )
    await db.commit()

    rows = list(
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.idempotency_key == "learning-event:test:retry-safe"
                )
            )
        ).scalars()
    )
    assert first.id == second.id
    assert len(rows) == 1
    assert rows[0].payload == {"attempt": 1}
