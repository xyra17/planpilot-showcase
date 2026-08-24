from datetime import date, datetime, timezone

from celery.utils.log import get_task_logger
from sqlalchemy import select

from src.celery_app import celery_app
from src.database import AsyncSessionLocal
from src.models import DecisionProposal, Goal, Task
from src.services import proposal_service
from src.tasks.runtime import run_async

logger = get_task_logger(__name__)
SUGGESTION_SOURCE = "scheduled_insight"


async def _generate_all() -> dict[str, int]:
    today_start = datetime.combine(date.today(), datetime.min.time(), tzinfo=timezone.utc).replace(
        tzinfo=None
    )
    created = 0
    async with AsyncSessionLocal() as db:
        candidates = (
            await db.execute(
                select(Goal.user_id, Goal.id)
                .join(Task, Task.goal_id == Goal.id)
                .where(
                    Goal.status == "active",
                    Task.status != "completed",
                    Task.scheduled_date < date.today().isoformat(),
                )
                .distinct()
            )
        ).all()
        for user_id, goal_id in candidates:
            exists = (
                await db.execute(
                    select(DecisionProposal.id).where(
                        DecisionProposal.user_id == user_id,
                        DecisionProposal.goal_id == goal_id,
                        DecisionProposal.source == SUGGESTION_SOURCE,
                        DecisionProposal.created_at >= today_start,
                    )
                )
            ).scalar_one_or_none()
            if exists:
                continue
            proposals = await proposal_service.generate_proposal(
                user_id,
                db,
                goal_id=goal_id,
                source=SUGGESTION_SOURCE,
            )
            created += len(proposals)
    return {"created": created}


@celery_app.task(
    name="src.tasks.agent_suggestions.generate_agent_suggestions",
    autoretry_for=(Exception,),
    retry_backoff=True,
    max_retries=2,
)
def generate_agent_suggestions() -> dict[str, int]:
    """Create learning insights, never premature waiting-approval action Runs."""
    result = run_async(_generate_all())
    logger.info("Agent proactive suggestions: %s", result)
    return result
