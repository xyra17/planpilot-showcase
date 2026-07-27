import asyncio
from datetime import datetime, timedelta, timezone

from celery.utils.log import get_task_logger
from sqlalchemy import select, update

from src.celery_app import celery_app
from src.core.agent_v2.orchestrator import advance_run, claim_queued_run
from src.database import AsyncSessionLocal
from src.models import AgentRun

logger = get_task_logger(__name__)


async def _execute(run_id: str, user_id: str) -> dict[str, str]:
    async with AsyncSessionLocal() as db:
        if not await claim_queued_run(db, user_id=user_id, run_id=run_id):
            return {"run_id": run_id, "status": "not_claimed"}
        run = await advance_run(db, user_id=user_id, run_id=run_id)
        return {"run_id": run.id, "status": run.status}


@celery_app.task(
    name="src.tasks.agent_runs.execute_agent_run",
    autoretry_for=(Exception,),
    retry_backoff=True,
    max_retries=2,
)
def execute_agent_run(run_id: str, user_id: str) -> dict[str, str]:
    return asyncio.run(_execute(run_id, user_id))


def dispatch_agent_run(run_id: str, user_id: str) -> None:
    execute_agent_run.apply_async(args=[run_id, user_id], task_id=f"agent-run:{run_id}")


async def _recover() -> dict[str, int]:
    stale_before = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=5)
    async with AsyncSessionLocal() as db:
        await db.execute(
            update(AgentRun)
            .where(
                AgentRun.status == "executing",
                AgentRun.updated_at < stale_before,
            )
            .values(status="queued")
        )
        await db.commit()
        rows = (
            await db.execute(
                select(AgentRun.id, AgentRun.user_id).where(AgentRun.status == "queued")
            )
        ).all()
    for run_id, user_id in rows:
        dispatch_agent_run(run_id, user_id)
    return {"dispatched": len(rows)}


@celery_app.task(name="src.tasks.agent_runs.recover_agent_runs")
def recover_agent_runs() -> dict[str, int]:
    result = asyncio.run(_recover())
    logger.info("Agent run recovery: %s", result)
    return result
