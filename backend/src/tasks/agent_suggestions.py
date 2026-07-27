import asyncio
from datetime import date, datetime, timezone

from celery.utils.log import get_task_logger
from sqlalchemy import distinct, select

from src.celery_app import celery_app
from src.core.agent_v2.orchestrator import create_run
from src.database import AsyncSessionLocal
from src.models import AgentRun, Goal, Task
from src.tasks.agent_runs import dispatch_agent_run

logger = get_task_logger(__name__)
SUGGESTION_PREFIX = "主动检查最近 14 天"


async def _generate_all() -> dict[str, int]:
    today_start = datetime.combine(
        date.today(), datetime.min.time(), tzinfo=timezone.utc
    ).replace(tzinfo=None)
    created = 0
    async with AsyncSessionLocal() as db:
        user_ids = (
            await db.execute(
                select(distinct(Goal.user_id))
                .join(Task, Task.goal_id == Goal.id)
                .where(
                    Goal.status == "active",
                    Task.status != "completed",
                    Task.scheduled_date < date.today().isoformat(),
                )
            )
        ).scalars().all()
        for user_id in user_ids:
            exists = (
                await db.execute(
                    select(AgentRun.id).where(
                        AgentRun.user_id == user_id,
                        AgentRun.request_text.startswith(SUGGESTION_PREFIX),
                        AgentRun.created_at >= today_start,
                    )
                )
            ).scalar_one_or_none()
            if exists:
                continue
            run = await create_run(
                db,
                user_id=user_id,
                request=(
                    f"{SUGGESTION_PREFIX}的执行情况，如有落后任务则生成下周调整建议；"
                    "只生成建议，任何修改都必须由我确认。"
                ),
                goal_id=None,
                step_budget=10,
                token_budget=12000,
                auto_advance=False,
            )
            dispatch_agent_run(run.id, user_id)
            created += 1
    return {"created": created}


@celery_app.task(
    name="src.tasks.agent_suggestions.generate_agent_suggestions",
    autoretry_for=(Exception,),
    retry_backoff=True,
    max_retries=2,
)
def generate_agent_suggestions() -> dict[str, int]:
    """Create at most one approval-gated suggestion per eligible user and day."""
    result = asyncio.run(_generate_all())
    logger.info("Agent proactive suggestions: %s", result)
    return result
