"""Scheduled data-retention enforcement."""

from celery.utils.log import get_task_logger

import src.database as database
from src.celery_app import celery_app
from src.services.privacy_service import apply_retention_policy
from src.tasks.runtime import run_async

logger = get_task_logger(__name__)


async def _enforce_retention() -> dict[str, int]:
    try:
        async with database.AsyncSessionLocal() as db:
            return await apply_retention_policy(db)
    finally:
        await database.engine.dispose()


@celery_app.task(
    name="src.tasks.privacy_tasks.enforce_data_retention",
    autoretry_for=(Exception,),
    retry_backoff=True,
    max_retries=3,
)
def enforce_data_retention() -> dict[str, int]:
    result = run_async(_enforce_retention())
    logger.info("data_retention result=%s", result)
    return result
