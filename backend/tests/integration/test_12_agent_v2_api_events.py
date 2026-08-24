import json
import uuid
from dataclasses import replace
from datetime import date, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from src.api.agent_v2 import _event_cursor, _stream_run_events
from src.core.agent_v2.orchestrator import advance_run, approve_run, create_run
from src.core.agent_v2.registry import build_registry
from tests.integration.database import IntegrationSessionLocal as AsyncSessionLocal
from src.models import AgentApproval, AgentAuditEvent, AgentRun, AgentStep, Goal

pytestmark = pytest.mark.integration


async def _account(client, prefix: str):
    token = uuid.uuid4().hex[:10]
    registered = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"{prefix}-{token}@test.com",
            "username": f"{prefix}-{token}",
            "password": "testpass123",
        },
    )
    assert registered.status_code == 201, registered.text
    auth = {"Authorization": f"Bearer {registered.cookies.get('pp_access')}"}
    goal = await client.post(
        "/api/v1/goals",
        headers=auth,
        json={
            "type": "skill",
            "title": f"{prefix} goal",
            "deadline": (date.today() + timedelta(days=180)).isoformat(),
        },
    )
    assert goal.status_code == 201, goal.text
    return auth, goal.json()["id"]


@pytest.mark.asyncio
async def test_recoverable_write_conflict_replans_and_completes_after_new_approval(client):
    auth, goal_id = await _account(client, "replan")
    task = await client.post(
        "/api/v1/tasks",
        headers=auth,
        json={
            "title": "需要重规划",
            "goalId": goal_id,
            "date": (date.today() - timedelta(days=2)).isoformat(),
        },
    )
    assert task.status_code == 201, task.text
    registry = build_registry()
    original = registry.get("tasks.apply_changes")
    invocations = 0

    async def conflict_once(db, context, payload):
        nonlocal invocations
        invocations += 1
        if invocations == 1:
            raise HTTPException(409, "模拟审批后数据变化")
        return await original.handler(db, context, payload)

    registry._tools[original.name] = replace(original, handler=conflict_once)
    async with AsyncSessionLocal() as db:
        user_id = (await db.execute(select(Goal.user_id).where(Goal.id == goal_id))).scalar_one()
        run = await create_run(
            db,
            user_id=user_id,
            request="检查逾期任务并重新安排到下周，修改前让我确认",
            goal_id=goal_id,
            step_budget=12,
            token_budget=20000,
            registry=registry,
            auto_advance=False,
        )
        await advance_run(db, user_id=user_id, run_id=run.id, registry=registry)
        approval = (
            await db.execute(
                select(AgentApproval).where(
                    AgentApproval.run_id == run.id, AgentApproval.status == "pending"
                )
            )
        ).scalar_one()
        await approve_run(
            db,
            user_id=user_id,
            run_id=run.id,
            approval_id=approval.id,
            expected_hash=approval.change_hash,
            change_set_version=approval.change_set_version,
            run_state_version=approval.run_state_version,
            auto_advance=False,
        )
        replanned = await advance_run(db, user_id=user_id, run_id=run.id, registry=registry)
        assert replanned.status == "waiting_approval"
        assert replanned.plan_version == 2
        second = (
            await db.execute(
                select(AgentApproval).where(
                    AgentApproval.run_id == run.id, AgentApproval.status == "pending"
                )
            )
        ).scalar_one()
        await approve_run(
            db,
            user_id=user_id,
            run_id=run.id,
            approval_id=second.id,
            expected_hash=second.change_hash,
            change_set_version=second.change_set_version,
            run_state_version=second.run_state_version,
            auto_advance=False,
        )
        completed = await advance_run(db, user_id=user_id, run_id=run.id, registry=registry)
        assert completed.status == "completed"
        versions = set(
            (
                await db.execute(select(AgentStep.plan_version).where(AgentStep.run_id == run.id))
            ).scalars()
        )
        event_types = set(
            (
                await db.execute(
                    select(AgentAuditEvent.event_type).where(AgentAuditEvent.run_id == run.id)
                )
            ).scalars()
        )
    assert versions == {1, 2}
    assert "run.replanned" in event_types
    assert invocations == 2


@pytest.mark.asyncio
async def test_event_cursor_is_monotonic_private_and_reconnectable(client):
    auth, goal_id = await _account(client, "events")
    created = await client.post(
        "/api/v2/agent/runs",
        headers=auth,
        json={"request": "检查最近两周执行情况", "goal_id": goal_id},
    )
    assert created.status_code == 201, created.text
    run_id = created.json()["id"]
    async with AsyncSessionLocal() as db:
        run = await db.get(AgentRun, run_id)
        await advance_run(db, user_id=run.user_id, run_id=run_id)

    listed = await client.get(f"/api/v2/agent/runs/{run_id}/events", headers=auth)
    assert listed.status_code == 200, listed.text
    events = listed.json()["events"]
    sequences = [event["sequence"] for event in events]
    assert sequences == sorted(set(sequences))
    assert len(sequences) >= 3
    cursor = sequences[len(sequences) // 2]
    incremental = await client.get(
        f"/api/v2/agent/runs/{run_id}/events?after={cursor}", headers=auth
    )
    assert all(event["sequence"] > cursor for event in incremental.json()["events"])
    assert incremental.json()["next_cursor"] == sequences[-1]

    other_auth, _other_goal = await _account(client, "other-events")
    hidden = await client.get(f"/api/v2/agent/runs/{run_id}/events", headers=other_auth)
    assert hidden.status_code == 404

    class ConnectedRequest:
        async def is_disconnected(self):
            return False

    stream = _stream_run_events(ConnectedRequest(), run_id, cursor)
    assert await anext(stream) == ": connected\n\n"
    frame = await anext(stream)
    await stream.aclose()
    lines = dict(line.split(": ", 1) for line in frame.strip().splitlines() if ": " in line)
    payload = json.loads(lines["data"])
    assert lines["event"] == "agent.audit.v1"
    assert int(lines["id"]) == payload["sequence"] > cursor
    assert _event_cursor(2, str(cursor)) == max(2, cursor)
    with pytest.raises(HTTPException) as error:
        _event_cursor(None, "invalid")
    assert error.value.status_code == 400
