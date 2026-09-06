import asyncio
import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from sqlalchemy import func, select

from src.core.agent_v2.orchestrator import approve_run, change_hash, review_hash
from src.core.time import utc_now
from src.models import AgentApproval, AgentAuditEvent, AgentRun, AgentStep, User
from src.tasks import agent_runs
from tests.integration.database import IntegrationSessionLocal as AsyncSessionLocal

pytestmark = [pytest.mark.integration, pytest.mark.soak]


async def _create_user() -> str:
    token = uuid.uuid4().hex[:10]
    async with AsyncSessionLocal() as db:
        user = User(
            email=f"soak-{token}@test.com",
            username=f"soak-{token}",
            hashed_password="not-used",
        )
        db.add(user)
        await db.commit()
        return user.id


async def _approval_fixture(user_id: str, round_number: int) -> tuple[str, str, str]:
    run_id = str(uuid.uuid4())
    step_id = str(uuid.uuid4())
    approval_id = str(uuid.uuid4())
    payload = {"version": 1, "summary": f"round {round_number}", "operations": []}
    review = {"risk": "medium", "outcome": "allow", "review_finding_codes": []}
    async with AsyncSessionLocal() as db:
        run = AgentRun(
            id=run_id,
            user_id=user_id,
            request_text=f"approval soak {round_number}",
            status="waiting_approval",
            state_version=0,
        )
        db.add(run)
        await db.flush()
        step = AgentStep(
            id=step_id,
            run_id=run_id,
            step_index=0,
            step_key="v1:apply",
            plan_version=1,
            agent_role="main",
            tool_name="tasks.apply_changes",
            status="waiting_approval",
            state_version=0,
        )
        db.add(step)
        await db.flush()
        db.add(
            AgentApproval(
                id=approval_id,
                run_id=run_id,
                step_id=step_id,
                status="pending",
                change_set=payload,
                change_hash=change_hash(payload),
                change_set_version=1,
                run_state_version=0,
                review_snapshot=review,
                reviewed_change_hash=change_hash(payload),
                review_hash=review_hash(review),
                policy_decision=review,
            )
        )
        await db.commit()
    return run_id, approval_id, change_hash(payload)


async def _approve_once(user_id: str, run_id: str, approval_id: str, digest: str) -> bool:
    async with AsyncSessionLocal() as db:
        _run, changed = await approve_run(
            db,
            user_id=user_id,
            run_id=run_id,
            approval_id=approval_id,
            expected_hash=digest,
            change_set_version=1,
            run_state_version=0,
            auto_advance=False,
        )
        return changed


@pytest.mark.asyncio
async def test_one_hundred_rounds_of_twenty_concurrent_approvals():
    user_id = await _create_user()
    for round_number in range(100):
        run_id, approval_id, digest = await _approval_fixture(user_id, round_number)
        changed = await asyncio.gather(
            *[_approve_once(user_id, run_id, approval_id, digest) for _ in range(20)]
        )
        assert changed.count(True) == 1
        assert changed.count(False) == 19
        async with AsyncSessionLocal() as db:
            event_count = (
                await db.execute(
                    select(func.count())
                    .select_from(AgentAuditEvent)
                    .where(
                        AgentAuditEvent.run_id == run_id,
                        AgentAuditEvent.event_type == "approval.approved",
                    )
                )
            ).scalar_one()
            assert event_count == 1


@pytest.mark.asyncio
async def test_one_hundred_expired_workers_recover_without_duplicate_state_changes():
    user_id = await _create_user()
    run_ids: list[str] = []
    async with AsyncSessionLocal() as db:
        for index in range(100):
            run_id = str(uuid.uuid4())
            run_ids.append(run_id)
            run = AgentRun(
                id=run_id,
                user_id=user_id,
                request_text=f"recovery soak {index}",
                status="executing",
                state_version=1,
                worker_id=f"dead-{index}",
                lease_token=str(uuid.uuid4()),
                heartbeat_at=utc_now() - timedelta(minutes=3),
                lease_expires_at=utc_now() - timedelta(minutes=2),
            )
            db.add(run)
            await db.flush()
            db.add(
                AgentStep(
                    id=str(uuid.uuid4()),
                    run_id=run_id,
                    step_index=0,
                    step_key="v1:read",
                    plan_version=1,
                    agent_role="learning_analyst",
                    tool_name="context.load",
                    status="running",
                    state_version=1,
                )
            )
            await db.flush()
        await db.commit()

    with patch.object(agent_runs, "dispatch_agent_run") as dispatch:
        result = await agent_runs._recover()
    # Recovery is intentionally global; earlier reliability scenarios may leave
    # another expired run in the shared integration database. Verify this
    # scenario's 100 runs below instead of assuming an otherwise empty queue.
    assert result["recovered"] >= 100
    dispatched_ids = {call.args[0] for call in dispatch.call_args_list}
    assert set(run_ids).issubset(dispatched_ids)
    async with AsyncSessionLocal() as db:
        runs = list(
            (await db.execute(select(AgentRun).where(AgentRun.id.in_(run_ids)))).scalars().all()
        )
        steps = list(
            (await db.execute(select(AgentStep).where(AgentStep.run_id.in_(run_ids))))
            .scalars()
            .all()
        )
        recovery_events = (
            await db.execute(
                select(func.count())
                .select_from(AgentAuditEvent)
                .where(
                    AgentAuditEvent.run_id.in_(run_ids),
                    AgentAuditEvent.event_type == "run.transitioned",
                )
            )
        ).scalar_one()
    assert len(runs) == len(steps) == 100
    assert all(run.status == "queued" and run.lease_token is None for run in runs)
    assert all(step.status == "retrying" for step in steps)
    assert recovery_events == 100
