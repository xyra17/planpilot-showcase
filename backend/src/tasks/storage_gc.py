"""Scheduled cleanup of storage objects no longer referenced by the database."""

from datetime import timedelta

from celery.utils.log import get_task_logger

import src.database as database
from src.celery_app import celery_app
from src.services.storage_gc_service import collect_orphaned_storage
from src.tasks.runtime import run_async

logger = get_task_logger(__name__)


async def _collect_orphans(*, dry_run: bool = False, grace_hours: int = 48) -> dict[str, int]:
    try:
        async with database.AsyncSessionLocal() as db:
            return await collect_orphaned_storage(db, dry_run=dry_run, grace_period=timedelta(hours=grace_hours))
    finally:
        await database.engine.dispose()


@celery_app.task(
    name="src.tasks.storage_gc.collect_orphaned_storage",
    autoretry_for=(Exception,),
    retry_backoff=True,
    max_retries=3,
)
def collect_orphaned_storage_task(*, dry_run: bool = False, grace_hours: int = 48) -> dict[str, int]:
    result = run_async(_collect_orphans(dry_run=dry_run, grace_hours=grace_hours))
    logger.info("storage_gc result=%s", result)
    return result
