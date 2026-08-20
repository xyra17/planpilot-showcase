"""Periodic Phase 5 feedback and monitoring tasks."""

from src.celery_app import celery_app
from src.database import AsyncSessionLocal, engine
from src.services.feedback_learning_service import (
    compute_delayed_outcomes,
    normalize_learning_events,
)
from src.services.monitoring_service import aggregate_daily_metrics
from src.tasks.runtime import run_async


async def _with_session(operation):
    try:
        async with AsyncSessionLocal() as db:
            return await operation(db)
    finally:
        await engine.dispose()


async def _compute_all_outcome_windows(db):
    next_day = await compute_delayed_outcomes(db, days=1)
    seven_day = await compute_delayed_outcomes(db, days=7)
    return {"1d": next_day, "7d": seven_day}


@celery_app.task(name="src.tasks.phase5_tasks.normalize_agent_feedback")
def normalize_agent_feedback() -> dict[str, int]:
    count = run_async(_with_session(normalize_learning_events))
    return {"created": count}


@celery_app.task(name="src.tasks.phase5_tasks.compute_delayed_agent_outcomes")
def compute_delayed_agent_outcomes() -> dict[str, int]:
    counts = run_async(_with_session(_compute_all_outcome_windows))
    return {"created": counts["1d"] + counts["7d"], **counts}


@celery_app.task(name="src.tasks.phase5_tasks.aggregate_agent_metrics")
def aggregate_agent_metrics() -> dict:
    return run_async(_with_session(aggregate_daily_metrics))
