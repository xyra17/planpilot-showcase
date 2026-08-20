"""Scheduled LearningEvent consumption and LearnerPattern decay."""

from __future__ import annotations

from datetime import datetime

from celery.utils.log import get_task_logger
from sqlalchemy import select

import src.database as database
from src.celery_app import celery_app
from src.core.time import utc_now
from src.intelligence.event_processor import BATCH_SIZE, run_batch
from src.intelligence.pattern_update_engine import (
    ARCHIVED_CONFIDENCE_THRESHOLD,
    DECAYED_TO_ACTIVE_CONFIDENCE,
    PatternUpdateEngine,
)
from src.models import LearnerPattern
from src.tasks.runtime import run_async

logger = get_task_logger(__name__)
MAX_BATCHES_PER_RUN = 100


async def _process_events() -> dict[str, int]:
    processed = 0
    batches = 0
    async with database.AsyncSessionLocal() as db:
        while batches < MAX_BATCHES_PER_RUN:
            count = await run_batch(db, batch_size=BATCH_SIZE)
            processed += count
            batches += 1
            if count < BATCH_SIZE:
                break
    return {"events_processed": processed, "batches": batches}


async def _decay_patterns(now: datetime | None = None) -> dict[str, int]:
    now = now or utc_now()
    changed = decayed = archived = 0
    async with database.AsyncSessionLocal() as db:
        patterns = list(
            (
                await db.execute(
                    select(LearnerPattern).where(LearnerPattern.status.in_(["active", "decayed"]))
                )
            )
            .scalars()
            .all()
        )
        for pattern in patterns:
            old_confidence = pattern.confidence
            new_confidence = PatternUpdateEngine.apply_decay(pattern, now)
            if new_confidence == old_confidence:
                continue
            pattern.confidence = new_confidence
            pattern.updated_at = now
            changed += 1
            if pattern.status == "active" and new_confidence < DECAYED_TO_ACTIVE_CONFIDENCE:
                pattern.status = "decayed"
                decayed += 1
            if pattern.status == "decayed" and new_confidence < ARCHIVED_CONFIDENCE_THRESHOLD:
                pattern.status = "archived"
                archived += 1
        await db.commit()
    return {"patterns_changed": changed, "decayed": decayed, "archived": archived}


async def _with_disposal(coro):
    try:
        return await coro
    finally:
        await database.engine.dispose()


@celery_app.task(
    name="src.tasks.pattern_tasks.process_learning_events",
    autoretry_for=(Exception,),
    retry_backoff=True,
    max_retries=3,
)
def process_learning_events() -> dict[str, int]:
    result = run_async(_with_disposal(_process_events()))
    logger.info("pattern_event_batch result=%s", result)
    return result


@celery_app.task(
    name="src.tasks.pattern_tasks.decay_learner_patterns",
    autoretry_for=(Exception,),
    retry_backoff=True,
    max_retries=2,
)
def decay_learner_patterns() -> dict[str, int]:
    result = run_async(_with_disposal(_decay_patterns()))
    logger.info("pattern_decay_batch result=%s", result)
    return result
