import asyncio
import uuid
from datetime import date, timedelta
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from src.core.agent_v2.orchestrator import advance_run
from src.core.agent_v2.schemas import ChangeOperation, ChangeSet
from src.database import AsyncSessionLocal
from src.models import AgentAuditEvent, AgentRun, Goal, Task, User
from src.services.agent_schedule import apply_task_changes, undo_task_changes

pytestmark = pytest.mark.integration


async def _account(client):
    token = uuid.uuid4().hex[:10]
    registered = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"agent-v2-{token}@test.com",
            "username": f"agent-{token}",
            "password": "testpass123",
        },
    )
    assert registered.status_code == 201, registered.text
    auth = {"Authorization": f"Bearer {registered.cookies.get('pp_access')}"}
    deadline = (date.today() + timedelta(days=180)).isoformat()
    goal = await client.post(
        "/api/v1/goals",
        headers=auth,
        json={"type": "skill", "title": f"并发目标 {token}", "deadline": deadline},
    )
    assert goal.status_code == 201, goal.text
    return auth, goal.json()["id"]


async def _stored_run(run_id: str) -> AgentRun:
    async with AsyncSessionLocal() as db:
        return (await db.execute(select(AgentRun).where(AgentRun.id == run_id))).scalar_one()


@pytest.mark.asyncio
async def test_twenty_concurrent_approvals_dispatch_and_transition_once(client):
    auth, goal_id = await _account(client)
    old_date = (date.today() - timedelta(days=3)).isoformat()
    task = await client.post(
        "/api/v1/tasks",
        headers=auth,
        json={
            "title": "并发审批任务",
            "goalId": goal_id,
            "estimatedMinutes": 30,
            "date": old_date,
        },
    )
    assert task.status_code == 201, task.text
    created = await client.post(
        "/api/v2/agent/runs",
        headers=auth,
        json={
            "request": "检查逾期任务并重新安排到下周，修改前让我确认",
            "goal_id": goal_id,
        },
    )
    assert created.status_code == 201, created.text
    run_id = created.json()["id"]
    stored = await _stored_run(run_id)
    async with AsyncSessionLocal() as db:
        await advance_run(db, user_id=stored.user_id, run_id=run_id)
    detail = (await client.get(f"/api/v2/agent/runs/{run_id}", headers=auth)).json()
    approval = detail["approvals"][0]
    body = {
        "approval_id": approval["id"],
        "change_hash": approval["change_hash"],
        "change_set_version": approval["change_set_version"],
        "run_state_version": approval["run_state_version"],
    }

    with patch("src.api.agent_v2.dispatch_agent_run") as dispatch:
        responses = await asyncio.gather(
            *[
                client.post(
                    f"/api/v2/agent/runs/{run_id}/approve",
                    headers=auth,
                    json=body,
                )
                for _ in range(20)
            ]
        )
    assert [response.status_code for response in responses] == [200] * 20
    assert dispatch.call_count == 1

    async with AsyncSessionLocal() as db:
        approved_events = (
            await db.execute(
                select(func.count())
                .select_from(AgentAuditEvent)
                .where(
                    AgentAuditEvent.run_id == run_id,
                    AgentAuditEvent.event_type == "approval.approved",
                )
            )
        ).scalar_one()
        assert approved_events == 1
        stored = await db.get(AgentRun, run_id)
        await advance_run(db, user_id=stored.user_id, run_id=run_id)
    tasks = (await client.get("/api/v1/tasks", headers=auth)).json()
    changed = [row for row in tasks if row["id"] == task.json()["id"]]
    assert len(changed) == 1
    assert changed[0]["date"] != old_date


@pytest.mark.asyncio
async def test_batch_write_conflict_rolls_back_every_operation(client):
    auth, goal_id = await _account(client)
    first_date = (date.today() + timedelta(days=2)).isoformat()
    second_date = (date.today() + timedelta(days=3)).isoformat()
    first = (
        await client.post(
            "/api/v1/tasks",
            headers=auth,
            json={"title": "批量一", "goalId": goal_id, "date": first_date},
        )
    ).json()
    second = (
        await client.post(
            "/api/v1/tasks",
            headers=auth,
            json={"title": "批量二", "goalId": goal_id, "date": second_date},
        )
    ).json()
    target = (date.today() + timedelta(days=10)).isoformat()
    changes = ChangeSet(
        summary="batch",
        operations=[
            ChangeOperation(
                entity="task",
                entity_id=first["id"],
                field="scheduled_date",
                before=first_date,
                after=target,
                label="批量一",
                reason="test",
            ),
            ChangeOperation(
                entity="task",
                entity_id=second["id"],
                field="scheduled_date",
                before="2000-01-01",
                after=target,
                label="批量二",
                reason="stale",
            ),
        ],
    )
    async with AsyncSessionLocal() as db:
        user_id = (
            await db.execute(
                select(User.id).join(Goal, Goal.user_id == User.id).where(Goal.id == goal_id)
            )
        ).scalar_one()
        with pytest.raises(HTTPException) as error:
            await apply_task_changes(db, user_id, changes)
        assert error.value.status_code == 409
        await db.rollback()
    async with AsyncSessionLocal() as db:
        dates = dict(
            (
                await db.execute(
                    select(Task.id, Task.scheduled_date).where(
                        Task.id.in_([first["id"], second["id"]])
                    )
                )
            ).all()
        )
    assert dates == {first["id"]: first_date, second["id"]: second_date}


@pytest.mark.asyncio
async def test_create_operation_is_idempotent(client):
    _auth, goal_id = await _account(client)
    task_id = str(uuid.uuid4())
    scheduled = (date.today() + timedelta(days=4)).isoformat()
    snapshot = {
        "id": task_id,
        "goal_id": goal_id,
        "title": "幂等创建",
        "description": None,
        "estimated_mins": 30,
        "status": "pending",
        "priority": "medium",
        "scheduled_date": scheduled,
        "mastery_level": "unknown",
    }
    changes = ChangeSet(
        summary="create once",
        operations=[
            ChangeOperation(
                entity="task",
                entity_id=task_id,
                field="__create__",
                before=None,
                after=snapshot,
                label="幂等创建",
                reason="test",
                idempotency_key="idempotent-create-test",
            )
        ],
    )
    async with AsyncSessionLocal() as db:
        user_id = (await db.execute(select(Goal.user_id).where(Goal.id == goal_id))).scalar_one()
        first = await apply_task_changes(db, user_id, changes)
        await db.commit()
        second = await apply_task_changes(db, user_id, changes)
        await db.commit()
        count = (
            await db.execute(select(func.count()).select_from(Task).where(Task.id == task_id))
        ).scalar_one()
    assert first["count"] == second["count"] == 1
    assert second["applied"][0]["already_applied"] is True
    assert count == 1


@pytest.mark.asyncio
async def test_undo_conflict_does_not_overwrite_newer_user_value(client):
    auth, goal_id = await _account(client)
    original = (date.today() + timedelta(days=2)).isoformat()
    applied_date = (date.today() + timedelta(days=5)).isoformat()
    newer_date = (date.today() + timedelta(days=8)).isoformat()
    task = (
        await client.post(
            "/api/v1/tasks",
            headers=auth,
            json={"title": "撤销冲突", "goalId": goal_id, "date": original},
        )
    ).json()
    operation = ChangeOperation(
        entity="task",
        entity_id=task["id"],
        field="scheduled_date",
        before=original,
        after=applied_date,
        label="撤销冲突",
        reason="test",
    )
    async with AsyncSessionLocal() as db:
        user_id = (await db.execute(select(Goal.user_id).where(Goal.id == goal_id))).scalar_one()
        await apply_task_changes(db, user_id, ChangeSet(summary="apply", operations=[operation]))
        await db.commit()
        row = await db.get(Task, task["id"])
        row.scheduled_date = newer_date
        await db.commit()
        with pytest.raises(HTTPException) as error:
            await undo_task_changes(db, user_id, [operation.model_dump(mode="json")])
        assert error.value.status_code == 409
        await db.rollback()
    async with AsyncSessionLocal() as db:
        assert (await db.get(Task, task["id"])).scheduled_date == newer_date
