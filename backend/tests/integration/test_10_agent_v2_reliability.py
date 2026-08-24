import asyncio
import uuid
from datetime import date, timedelta
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from src.core.agent_v2.orchestrator import advance_run, change_hash, review_hash
from src.core.agent_v2.schemas import ChangeOperation, ChangeSet
from src.models import AgentApproval, AgentAuditEvent, AgentRun, Goal, InsightActionRun, Task, User
from src.services.agent_schedule import apply_task_changes, undo_task_changes
from src.services.proposal_service import ProposalCreate, create_proposal
from tests.integration.database import IntegrationSessionLocal as AsyncSessionLocal

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
async def test_twenty_concurrent_insight_conversions_create_one_active_run(client):
    auth, goal_id = await _account(client)
    task_response = await client.post(
        "/api/v1/tasks",
        headers=auth,
        json={
            "title": "并发转换任务",
            "goalId": goal_id,
            "estimatedMinutes": 30,
            "date": date.today().isoformat(),
        },
    )
    assert task_response.status_code == 201, task_response.text
    async with AsyncSessionLocal() as db:
        goal = await db.get(Goal, goal_id)
        assert goal is not None
        proposal = await create_proposal(
            goal.user_id,
            ProposalCreate(
                goal_id=goal.id,
                proposal_type="reschedule_overdue_tasks",
                title="并发转换洞察",
                reasoning=["验证单活跃 Run"],
                proposed_changes={
                    "task_updates": [
                        {
                            "task_id": task_response.json()["id"],
                            "scheduled_date": (date.today() + timedelta(days=2)).isoformat(),
                        }
                    ]
                },
                confidence=0.8,
            ),
            db,
        )
        proposal_id = proposal["id"]

    responses = await asyncio.gather(
        *[
            client.post(
                f"/api/v1/learner/proposals/{proposal_id}/action-run",
                headers=auth,
            )
            for _ in range(20)
        ]
    )
    assert [response.status_code for response in responses] == [200] * 20
    run_ids = {response.json()["id"] for response in responses}
    assert len(run_ids) == 1
    async with AsyncSessionLocal() as db:
        links = list(
            (
                await db.execute(
                    select(InsightActionRun).where(
                        InsightActionRun.insight_id == proposal_id,
                        InsightActionRun.is_active.is_(True),
                    )
                )
            ).scalars()
        )
        assert len(links) == 1
        assert links[0].run_id == next(iter(run_ids))


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
    owner_user_id = stored.user_id
    async with AsyncSessionLocal() as db:
        await advance_run(db, user_id=owner_user_id, run_id=run_id)
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
async def test_edit_and_approve_race_never_executes_an_unreviewed_changeset(client):
    auth, goal_id = await _account(client)
    old_date = (date.today() - timedelta(days=2)).isoformat()
    task = await client.post(
        "/api/v1/tasks",
        headers=auth,
        json={"title": "编辑审批竞态", "goalId": goal_id, "date": old_date},
    )
    created = await client.post(
        "/api/v2/agent/runs",
        headers=auth,
        json={
            "request": "检查逾期任务并重新安排到下周，修改前让我确认",
            "goal_id": goal_id,
        },
    )
    run_id = created.json()["id"]
    stored = await _stored_run(run_id)
    owner_user_id = stored.user_id
    async with AsyncSessionLocal() as db:
        await advance_run(db, user_id=owner_user_id, run_id=run_id)
    detail = (await client.get(f"/api/v2/agent/runs/{run_id}", headers=auth)).json()
    approval = detail["approvals"][0]
    edited = approval["change_set"]
    edited["operations"][0]["after"] = (date.today() + timedelta(days=7)).isoformat()
    approve_body = {
        "approval_id": approval["id"],
        "change_hash": approval["change_hash"],
        "change_set_version": approval["change_set_version"],
        "run_state_version": approval["run_state_version"],
    }

    with patch("src.api.agent_v2.dispatch_agent_run"):
        edit_response, approve_response = await asyncio.gather(
            client.patch(
                f"/api/v2/agent/runs/{run_id}/approvals/{approval['id']}",
                headers=auth,
                json={"change_set": edited},
            ),
            client.post(
                f"/api/v2/agent/runs/{run_id}/approve",
                headers=auth,
                json=approve_body,
            ),
        )
    assert sorted([edit_response.status_code, approve_response.status_code]) == [200, 409]

    async with AsyncSessionLocal() as db:
        current = await db.get(AgentApproval, approval["id"])
        assert current.reviewed_change_hash == current.change_hash
        assert current.change_hash == change_hash(current.change_set)
        assert current.review_hash == review_hash(current.review_snapshot)
        if current.status == "approved":
            await advance_run(db, user_id=owner_user_id, run_id=run_id)
        refreshed = await db.get(Task, task.json()["id"])
        if current.status == "pending":
            assert refreshed.scheduled_date == old_date


@pytest.mark.asyncio
async def test_edited_preview_past_deadline_is_review_blocked_in_postgresql(client):
    auth, goal_id = await _account(client)
    source_date = (date.today() + timedelta(days=2)).isoformat()
    created_task = await client.post(
        "/api/v1/tasks",
        headers=auth,
        json={"title": "PG 截止日期审查", "goalId": goal_id, "date": source_date},
    )
    assert created_task.status_code == 201
    created = await client.post(
        "/api/v2/agent/runs",
        headers=auth,
        json={"request": "把任务“PG 截止日期审查”改到明天，执行前确认", "goal_id": goal_id},
    )
    run_id = created.json()["id"]
    stored = await _stored_run(run_id)
    owner_user_id = stored.user_id
    async with AsyncSessionLocal() as db:
        await advance_run(db, user_id=owner_user_id, run_id=run_id)
        goal = await db.get(Goal, goal_id)
        blocked_date = (date.fromisoformat(goal.deadline) + timedelta(days=1)).isoformat()
    detail = (await client.get(f"/api/v2/agent/runs/{run_id}", headers=auth)).json()
    approval = detail["approvals"][0]
    edited_set = approval["change_set"]
    edited_set["operations"][0]["after"] = blocked_date
    edited = await client.patch(
        f"/api/v2/agent/runs/{run_id}/approvals/{approval['id']}",
        headers=auth,
        json={"change_set": edited_set},
    )
    assert edited.status_code == 200, edited.text
    rebound = edited.json()["approvals"][0]
    assert rebound["policy_decision"]["outcome"] == "deny"
    assert "deadline_exceeded" in rebound["policy_decision"]["review_finding_codes"]
    blocked = await client.post(
        f"/api/v2/agent/runs/{run_id}/approve",
        headers=auth,
        json={
            "approval_id": rebound["id"],
            "change_hash": rebound["change_hash"],
            "change_set_version": rebound["change_set_version"],
            "run_state_version": rebound["run_state_version"],
        },
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "review_blocked"


@pytest.mark.asyncio
async def test_edited_preview_high_risk_requires_second_confirmation_in_postgresql(client):
    auth, goal_id = await _account(client)
    source_date = (date.today() + timedelta(days=2)).isoformat()
    overloaded_date = (date.today() + timedelta(days=5)).isoformat()
    moved_task = await client.post(
        "/api/v1/tasks",
        headers=auth,
        json={
            "title": "PG 高风险移动",
            "goalId": goal_id,
            "date": source_date,
            "estimatedMinutes": 30,
        },
    )
    assert moved_task.status_code == 201
    created = await client.post(
        "/api/v2/agent/runs",
        headers=auth,
        json={"request": "把任务“PG 高风险移动”改到明天，执行前确认", "goal_id": goal_id},
    )
    run_id = created.json()["id"]
    stored = await _stored_run(run_id)
    owner_user_id = stored.user_id
    async with AsyncSessionLocal() as db:
        await advance_run(db, user_id=owner_user_id, run_id=run_id)
    detail = (await client.get(f"/api/v2/agent/runs/{run_id}", headers=auth)).json()
    approval = detail["approvals"][0]
    capacity_task = await client.post(
        "/api/v1/tasks",
        headers=auth,
        json={
            "title": "PG 容量占用",
            "goalId": goal_id,
            "date": overloaded_date,
            "estimatedMinutes": 180,
        },
    )
    assert capacity_task.status_code == 201
    edited_set = approval["change_set"]
    edited_set["operations"][0]["after"] = overloaded_date
    edited = await client.patch(
        f"/api/v2/agent/runs/{run_id}/approvals/{approval['id']}",
        headers=auth,
        json={"change_set": edited_set},
    )
    assert edited.status_code == 200, edited.text
    rebound = edited.json()["approvals"][0]
    assert rebound["policy_decision"]["risk"] == "high"
    unconfirmed = await client.post(
        f"/api/v2/agent/runs/{run_id}/approve",
        headers=auth,
        json={"approval_id": rebound["id"], "change_hash": rebound["change_hash"]},
    )
    assert unconfirmed.status_code == 409
    confirmed = await client.post(
        f"/api/v2/agent/runs/{run_id}/approve",
        headers=auth,
        json={
            "approval_id": rebound["id"],
            "change_hash": rebound["change_hash"],
            "change_set_version": rebound["change_set_version"],
            "run_state_version": rebound["run_state_version"],
            "high_risk_confirmed": True,
        },
    )
    assert confirmed.status_code == 200, confirmed.text
    async with AsyncSessionLocal() as db:
        await advance_run(db, user_id=owner_user_id, run_id=run_id)
        completed = await db.get(AgentRun, run_id)
        task = await db.get(Task, moved_task.json()["id"])
        assert completed.status == "completed"
        assert task.scheduled_date == overloaded_date


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


@pytest.mark.asyncio
@pytest.mark.parametrize("aggregate_version", [1, 2])
async def test_delete_undo_restores_full_task_snapshot_and_preserves_version(
    client, aggregate_version
):
    auth, goal_id = await _account(client)
    task = Task(
        id=str(uuid.uuid4()),
        goal_id=goal_id,
        title="完整快照撤销",
        description="保留描述",
        estimated_mins=30,
        actual_mins=41,
        status="completed",
        priority="high",
        scheduled_date=(date.today() + timedelta(days=2)).isoformat(),
        mastery_level="L2",
        type="study",
        kb_refs=["kb-1"],
        version=aggregate_version,
    )
    async with AsyncSessionLocal() as db:
        db.add(task)
        await db.commit()
        task = await db.get(Task, task.id)
        task.version = aggregate_version
        await db.commit()
        task = await db.get(Task, task.id)
        user_id = (await db.execute(select(Goal.user_id).where(Goal.id == goal_id))).scalar_one()
        snapshot = {
            "id": task.id,
            "goal_id": task.goal_id,
            "plan_id": task.plan_id,
            "title": task.title,
            "description": task.description,
            "estimated_mins": task.estimated_mins,
            "actual_mins": task.actual_mins,
            "status": task.status,
            "priority": task.priority,
            "scheduled_date": task.scheduled_date,
            "mastery_level": task.mastery_level,
            "type": task.type,
            "kb_refs": task.kb_refs,
            "stage_label": task.stage_label,
            "sequence_in_plan": task.sequence_in_plan,
            "completed_at": None,
            "version": task.version,
        }
        operation = ChangeOperation(
            entity="task",
            entity_id=task.id,
            field="__delete__",
            before=snapshot,
            after=None,
            label=task.title,
            reason="test",
            precondition={"version": aggregate_version},
        )
        await apply_task_changes(db, user_id, ChangeSet(summary="delete", operations=[operation]))
        await db.commit()
        await undo_task_changes(db, user_id, [operation.model_dump(mode="json")])
        await db.commit()
        restored = await db.get(Task, task.id)
        assert restored is not None
        assert restored.actual_mins == 41
        assert restored.status == "completed"
        assert restored.mastery_level == "L2"
        assert restored.scheduled_date == snapshot["scheduled_date"]
        assert restored.version >= aggregate_version
