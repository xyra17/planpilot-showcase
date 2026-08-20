"""Scheduled LearnerProfile rebuilds."""

from __future__ import annotations

from celery.utils.log import get_task_logger

import src.database as database
from src.celery_app import celery_app
from src.intelligence.cognitive_model import CognitiveProfileBuilder
from src.intelligence.profile_builder import ProfileBuilder
from src.tasks.runtime import run_async

logger = get_task_logger(__name__)


async def _rebuild_profiles() -> dict[str, int]:
    async with database.AsyncSessionLocal() as db:
        users = await ProfileBuilder.run_batch(db)
        cognitive_users = await CognitiveProfileBuilder.run_batch(db)
        await db.commit()
    return {"users_rebuilt": users, "cognitive_users_rebuilt": cognitive_users}


async def _rebuild_profiles_with_disposal() -> dict[str, int]:
    try:
        return await _rebuild_profiles()
    finally:
        # Release task-scoped pooled connections before the next worker job.
        await database.engine.dispose()


@celery_app.task(
    name="src.tasks.profile_tasks.rebuild_learner_profiles",
    autoretry_for=(Exception,),
    retry_backoff=True,
    max_retries=2,
)
def rebuild_learner_profiles() -> dict[str, int]:
    result = run_async(_rebuild_profiles_with_disposal())
    logger.info("learner_profile_batch result=%s", result)
    return result
