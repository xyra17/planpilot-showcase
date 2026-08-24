"""Scheduled production evidence tasks for Action Beta readiness."""

from src.celery_app import celery_app
from src.database import AsyncSessionLocal, engine
from src.services.beta_evidence_service import (
    cleanup_expired_review_samples,
    normalize_review_samples,
    scan_hard_safety,
)
from src.tasks.runtime import run_async


async def _with_session(operation):
    try:
        async with AsyncSessionLocal() as db:
            return await operation(db)
    finally:
        await engine.dispose()


@celery_app.task(name="src.tasks.beta_readiness_tasks.scan_hard_safety")
def scan_beta_hard_safety() -> dict:
    return run_async(_with_session(scan_hard_safety))


@celery_app.task(name="src.tasks.beta_readiness_tasks.normalize_review_samples")
def normalize_beta_review_samples() -> dict[str, int]:
    count = run_async(_with_session(normalize_review_samples))
    return {"created": count}


@celery_app.task(name="src.tasks.beta_readiness_tasks.cleanup_review_samples")
def cleanup_beta_review_samples() -> dict[str, int]:
    count = run_async(_with_session(cleanup_expired_review_samples))
    return {"deleted": count}
