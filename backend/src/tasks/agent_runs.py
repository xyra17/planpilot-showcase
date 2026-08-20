import asyncio
import os
import socket
import uuid

from celery.utils.log import get_task_logger
from sqlalchemy import select

import src.database as database
from src.celery_app import celery_app
from src.core.agent_v2.orchestrator import advance_run
from src.core.agent_v2.transitions import (
    claim_run_lease,
    renew_run_lease,
    transition_run,
    transition_step,
)
from src.core.time import utc_now
from src.models import AgentRun, AgentStep
from src.tasks.runtime import run_async

logger = get_task_logger(__name__)
HEARTBEAT_INTERVAL_SECONDS = 30


async def _heartbeat(run_id: str, lease_token: str, stopped: asyncio.Event) -> None:
    while not stopped.is_set():
        try:
            await asyncio.wait_for(stopped.wait(), timeout=HEARTBEAT_INTERVAL_SECONDS)
            return
        except TimeoutError:
            pass
        async with database.AsyncSessionLocal() as heartbeat_db:
            if not await renew_run_lease(heartbeat_db, run_id=run_id, lease_token=lease_token):
                stopped.set()
                return


async def _execute(run_id: str, user_id: str) -> dict[str, str]:
    worker_id = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
    async with database.AsyncSessionLocal() as db:
        lease_token = await claim_run_lease(db, user_id=user_id, run_id=run_id, worker_id=worker_id)
        if not lease_token:
            return {"run_id": run_id, "status": "not_claimed"}
        stopped = asyncio.Event()
        heartbeat = asyncio.create_task(_heartbeat(run_id, lease_token, stopped))
        try:
            run = await advance_run(db, user_id=user_id, run_id=run_id, lease_token=lease_token)
            return {"run_id": run.id, "status": run.status}
        finally:
            stopped.set()
            await heartbeat


async def _execute_with_disposal(run_id: str, user_id: str) -> dict[str, str]:
    try:
        return await _execute(run_id, user_id)
    finally:
        # Release task-scoped pooled connections before the next worker job.
        await database.engine.dispose()


@celery_app.task(
    name="src.tasks.agent_runs.execute_agent_run",
    autoretry_for=(Exception,),
    retry_backoff=True,
    max_retries=2,
)
def execute_agent_run(run_id: str, user_id: str) -> dict[str, str]:
    return run_async(_execute_with_disposal(run_id, user_id))


def dispatch_agent_run(run_id: str, user_id: str) -> None:
    execute_agent_run.apply_async(args=[run_id, user_id], task_id=f"agent-run:{run_id}")


async def _recover() -> dict[str, int]:
    now = utc_now()
    async with database.AsyncSessionLocal() as db:
        expired = list(
            (
                await db.execute(
                    select(AgentRun).where(
                        AgentRun.status == "executing", AgentRun.lease_expires_at < now
                    )
                )
            )
            .scalars()
            .all()
        )
        for run in expired:
            running_steps = list(
                (
                    await db.execute(
                        select(AgentStep).where(
                            AgentStep.run_id == run.id,
                            AgentStep.status == "running",
                        )
                    )
                )
                .scalars()
                .all()
            )
            for step in running_steps:
                await transition_step(
                    db,
                    step,
                    "retrying",
                    actor="recovery",
                    detail={"reason": "lease_expired"},
                )
            await transition_run(
                db,
                run,
                "queued",
                actor="recovery",
                detail={"reason": "lease_expired"},
                lease_token=run.lease_token,
            )
        await db.commit()
        rows = (
            await db.execute(
                select(AgentRun.id, AgentRun.user_id).where(AgentRun.status == "queued")
            )
        ).all()
    for run_id, user_id in rows:
        dispatch_agent_run(run_id, user_id)
    return {"recovered": len(expired), "dispatched": len(rows)}


async def _recover_with_disposal() -> dict[str, int]:
    try:
        return await _recover()
    finally:
        await database.engine.dispose()


@celery_app.task(name="src.tasks.agent_runs.recover_agent_runs")
def recover_agent_runs() -> dict[str, int]:
    result = run_async(_recover_with_disposal())
    logger.info("Agent run recovery: %s", result)
    return result
