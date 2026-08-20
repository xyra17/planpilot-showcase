"""Scheduled episodic memory distillation."""

from __future__ import annotations

from celery.utils.log import get_task_logger

import src.database as database
from src.celery_app import celery_app
from src.intelligence.memory_system import MemoryBuilder
from src.tasks.runtime import run_async

logger = get_task_logger(__name__)


async def _build_memories() -> dict[str, int]:
    processed = 0
    batches = 0
    async with database.AsyncSessionLocal() as db:
        while batches < 100:
            count = await MemoryBuilder.run_batch(db)
            processed += count
            batches += 1
            if count < 200:
                break
    return {"events_scanned": processed, "batches": batches}


async def _with_disposal() -> dict[str, int]:
    try:
        return await _build_memories()
    finally:
        await database.engine.dispose()


@celery_app.task(
    name="src.tasks.memory_tasks.build_learning_memories",
    autoretry_for=(Exception,),
    retry_backoff=True,
    max_retries=3,
)
def build_learning_memories() -> dict[str, int]:
    result = run_async(_with_disposal())
    logger.info("learning_memory_batch result=%s", result)
    return result
