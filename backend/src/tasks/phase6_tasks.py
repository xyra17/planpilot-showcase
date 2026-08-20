"""Periodic Phase 6 real-outcome and calibration tasks."""

from src.celery_app import celery_app
from src.database import AsyncSessionLocal, engine
from src.services.calibration_service import calculate_calibration, capture_actual_outcomes
from src.services.canary_observation_service import normalize_canary_observations
from src.tasks.runtime import run_async


async def _with_session(operation):
    try:
        async with AsyncSessionLocal() as db:
            return await operation(db)
    finally:
        await engine.dispose()


@celery_app.task(name="src.tasks.phase6_tasks.capture_prediction_outcomes")
def capture_prediction_outcomes() -> dict[str, int]:
    count = run_async(_with_session(capture_actual_outcomes))
    return {"updated": count}


@celery_app.task(name="src.tasks.phase6_tasks.calculate_prediction_calibration")
def calculate_prediction_calibration() -> dict:
    return run_async(_with_session(calculate_calibration))


@celery_app.task(name="src.tasks.phase6_tasks.normalize_canary_observations")
def normalize_canary_observation_facts() -> dict[str, int]:
    count = run_async(_with_session(normalize_canary_observations))
    return {"created": count}
