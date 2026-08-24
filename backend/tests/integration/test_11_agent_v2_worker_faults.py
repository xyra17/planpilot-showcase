import asyncio
import uuid
from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select

from src.core.agent_v2.orchestrator import create_run
from src.core.agent_v2.transitions import claim_run_lease
from src.core.time import utc_now
from tests.integration.database import IntegrationSessionLocal as AsyncSessionLocal
from src.models import AgentRun, AgentStep, User
from src.tasks import agent_runs

pytestmark = pytest.mark.integration


async def _user_and_run(request: str = "检查最近两周执行情况") -> tuple[str, str]:
    token = uuid.uuid4().hex[:10]
    async with AsyncSessionLocal() as db:
        user = User(
            email=f"worker-{token}@test.com",
            username=f"worker-{token}",
            hashed_password="not-used",
        )
        db.add(user)
        await db.commit()
        run = await create_run(
            db,
            user_id=user.id,
            request=request,
            goal_id=None,
            step_budget=10,
            token_budget=10000,
            auto_advance=False,
        )
        return user.id, run.id


@pytest.mark.asyncio
async def test_heartbeat_renews_active_lease():
    user_id, run_id = await _user_and_run()
    async with AsyncSessionLocal() as db:
        token = await claim_run_lease(
            db, user_id=user_id, run_id=run_id, worker_id="heartbeat-test", lease_seconds=2
        )
        before = (await db.get(AgentRun, run_id)).lease_expires_at
    stopped = asyncio.Event()
    with patch.object(agent_runs, "HEARTBEAT_INTERVAL_SECONDS", 0.02):
        heartbeat = asyncio.create_task(agent_runs._heartbeat(run_id, token, stopped))
        await asyncio.sleep(0.08)
        stopped.set()
        await heartbeat
    async with AsyncSessionLocal() as db:
        renewed = await db.get(AgentRun, run_id)
        assert renewed.heartbeat_at is not None
        assert renewed.lease_expires_at > before


@pytest.mark.asyncio
async def test_expired_worker_is_requeued_and_running_step_becomes_retrying():
    user_id, run_id = await _user_and_run()
    async with AsyncSessionLocal() as db:
        token = await claim_run_lease(
            db, user_id=user_id, run_id=run_id, worker_id="interrupted", lease_seconds=90
        )
        run = await db.get(AgentRun, run_id)
        step = (
            await db.execute(
                select(AgentStep)
                .where(AgentStep.run_id == run_id)
                .order_by(AgentStep.step_index)
                .limit(1)
            )
        ).scalar_one()
        step.status = "running"
        run.lease_expires_at = utc_now() - timedelta(seconds=1)
        await db.commit()

    with patch.object(agent_runs, "dispatch_agent_run") as dispatch:
        result = await agent_runs._recover()
    assert result["recovered"] >= 1
    dispatch.assert_any_call(run_id, user_id)
    async with AsyncSessionLocal() as db:
        recovered = await db.get(AgentRun, run_id)
        recovered_step = await db.get(AgentStep, step.id)
        assert recovered.status == "queued"
        assert recovered.lease_token is None
        assert recovered_step.status == "retrying"
        assert token is not None


@pytest.mark.asyncio
async def test_duplicate_worker_delivery_executes_run_once():
    user_id, run_id = await _user_and_run()
    first, second = await asyncio.gather(
        agent_runs._execute(run_id, user_id),
        agent_runs._execute(run_id, user_id),
    )
    statuses = sorted([first["status"], second["status"]])
    assert statuses == ["completed", "not_claimed"]
    async with AsyncSessionLocal() as db:
        run = await db.get(AgentRun, run_id)
        steps = list(
            (
                await db.execute(
                    select(AgentStep)
                    .where(AgentStep.run_id == run_id)
                    .order_by(AgentStep.step_index)
                )
            )
            .scalars()
            .all()
        )
    assert run.status == "completed"
    assert [step.attempts for step in steps] == [1, 1]


@pytest.mark.asyncio
async def test_celery_loop_wrappers_always_dispose_async_engine():
    fake_engine = MagicMock(dispose=AsyncMock())
    with (
        patch.object(agent_runs, "_execute", AsyncMock(side_effect=RuntimeError("worker exit"))),
        patch.object(agent_runs.database, "engine", fake_engine),
    ):
        with pytest.raises(RuntimeError, match="worker exit"):
            await agent_runs._execute_with_disposal("run", "user")
        fake_engine.dispose.assert_awaited_once()

    fake_engine = MagicMock(dispose=AsyncMock())
    with (
        patch.object(agent_runs, "_recover", AsyncMock(return_value={"recovered": 0})),
        patch.object(agent_runs.database, "engine", fake_engine),
    ):
        assert await agent_runs._recover_with_disposal() == {"recovered": 0}
        fake_engine.dispose.assert_awaited_once()


def test_duplicate_celery_dispatch_uses_same_task_identity():
    with patch.object(agent_runs.execute_agent_run, "apply_async") as apply_async:
        agent_runs.dispatch_agent_run("run-1", "user-1")
        agent_runs.dispatch_agent_run("run-1", "user-1")
    assert [call.kwargs["task_id"] for call in apply_async.call_args_list] == [
        "agent-run:run-1",
        "agent-run:run-1",
    ]
