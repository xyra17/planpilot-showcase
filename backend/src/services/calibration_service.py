"""Persist heuristic predictions and calibrate them against real outcomes."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import local_midnight_as_utc, utc_now
from src.models import (
    LearningEvent,
    PredictionCalibrationSnapshot,
    PredictionObservation,
    Task,
    User,
)
from src.services.agent_control_service import canonical_hash

FAILURE_ALGORITHM_VERSION = "failure-heuristic-v1"


async def record_task_failure_prediction(
    db: AsyncSession,
    *,
    user_id: str,
    goal_id: str,
    task: Task,
    probability: float,
    features: dict[str, Any],
    predicted_at: datetime | None = None,
) -> PredictionObservation:
    due_date = date.fromisoformat(task.scheduled_date)
    prediction_key = canonical_hash(
        {
            "type": "task_failure",
            "algorithm": FAILURE_ALGORITHM_VERSION,
            "task_id": task.id,
            "scheduled_date": task.scheduled_date,
        }
    )
    existing = await db.scalar(
        select(PredictionObservation).where(PredictionObservation.prediction_key == prediction_key)
    )
    if existing is not None:
        return existing
    user = await db.get(User, user_id)
    timezone_name = user.timezone if user is not None else "UTC"
    row = PredictionObservation(
        user_id=user_id,
        goal_id=goal_id,
        task_id=task.id,
        prediction_type="task_failure",
        algorithm_version=FAILURE_ALGORITHM_VERSION,
        predicted_probability=probability,
        feature_snapshot=features,
        target_id=task.id,
        target_version=task.version,
        target_scheduled_date=task.scheduled_date,
        prediction_key=prediction_key,
        predicted_at=predicted_at or utc_now(),
        outcome_due_at=local_midnight_as_utc(due_date + timedelta(days=1), timezone_name),
    )
    db.add(row)
    await db.flush()
    return row


async def capture_actual_outcomes(db: AsyncSession) -> int:
    now = utc_now()
    rows = list(
        (
            await db.execute(
                select(PredictionObservation).where(
                    PredictionObservation.prediction_type == "task_failure",
                    PredictionObservation.actual_outcome.is_(None),
                    PredictionObservation.outcome_due_at <= now,
                )
            )
        ).scalars()
    )
    for observation in rows:
        target_id = observation.target_id or observation.task_id
        completion_event = await db.scalar(
            select(LearningEvent)
            .where(
                LearningEvent.aggregate_type == "task",
                LearningEvent.aggregate_id == target_id,
                LearningEvent.event_type == "TaskCompleted",
                LearningEvent.occurred_at <= observation.outcome_due_at,
            )
            .order_by(LearningEvent.occurred_at.desc())
        )
        task = await db.get(Task, observation.task_id) if observation.task_id else None
        completed_by_due = completion_event is not None or bool(
            task
            and task.status == "completed"
            and task.completed_at
            and task.completed_at <= observation.outcome_due_at
        )
        observation.actual_outcome = not completed_by_due
        observation.actual_value = 1.0 if observation.actual_outcome else 0.0
        observation.outcome_source = (
            "learning_event" if completion_event is not None else "task_snapshot_at_due"
        )
        observation.outcome_event_id = completion_event.id if completion_event else None
        observation.outcome_recorded_at = now
    await db.commit()
    return len(rows)


async def calculate_calibration(
    db: AsyncSession,
    *,
    prediction_type: str = "task_failure",
    algorithm_version: str = FAILURE_ALGORITHM_VERSION,
    days: int = 90,
) -> dict[str, Any]:
    today = date.today()
    window_start = datetime.combine(today - timedelta(days=days - 1), time.min)
    window_end = datetime.combine(today + timedelta(days=1), time.min)
    observations = list(
        (
            await db.execute(
                select(PredictionObservation).where(
                    PredictionObservation.prediction_type == prediction_type,
                    PredictionObservation.algorithm_version == algorithm_version,
                    PredictionObservation.predicted_at >= window_start,
                    PredictionObservation.predicted_at < window_end,
                )
            )
        ).scalars()
    )
    outcomes = [row for row in observations if row.actual_outcome is not None]
    brier = (
        sum((row.predicted_probability - float(bool(row.actual_outcome))) ** 2 for row in outcomes)
        / len(outcomes)
        if outcomes
        else None
    )
    buckets: list[dict[str, Any]] = []
    weighted_error = 0.0
    for index in range(10):
        lower = index / 10
        upper = (index + 1) / 10
        members = [
            row
            for row in outcomes
            if lower <= row.predicted_probability < upper
            or (index == 9 and row.predicted_probability == 1.0)
        ]
        if not members:
            continue
        predicted = sum(row.predicted_probability for row in members) / len(members)
        observed = sum(bool(row.actual_outcome) for row in members) / len(members)
        weighted_error += abs(predicted - observed) * len(members)
        buckets.append(
            {
                "lower": lower,
                "upper": upper,
                "count": len(members),
                "predicted_rate": round(predicted, 4),
                "observed_rate": round(observed, 4),
            }
        )
    ece = weighted_error / len(outcomes) if outcomes else None
    status = (
        "calibration_ready"
        if len(outcomes) >= 500
        else "analysis_ready"
        if len(outcomes) >= 100
        else "insufficient_data"
    )
    snapshot = await db.scalar(
        select(PredictionCalibrationSnapshot).where(
            PredictionCalibrationSnapshot.prediction_type == prediction_type,
            PredictionCalibrationSnapshot.algorithm_version == algorithm_version,
            PredictionCalibrationSnapshot.window_start == window_start,
            PredictionCalibrationSnapshot.window_end == window_end,
        )
    )
    if snapshot is None:
        snapshot = PredictionCalibrationSnapshot(
            prediction_type=prediction_type,
            algorithm_version=algorithm_version,
            window_start=window_start,
            window_end=window_end,
            calculated_at=utc_now(),
        )
        db.add(snapshot)
    snapshot.sample_count = len(observations)
    snapshot.outcome_count = len(outcomes)
    snapshot.brier_score = round(brier, 6) if brier is not None else None
    snapshot.expected_calibration_error = round(ece, 6) if ece is not None else None
    snapshot.buckets = buckets
    snapshot.status = status
    snapshot.calculated_at = utc_now()
    await db.commit()
    return calibration_to_dict(snapshot)


def calibration_to_dict(row: PredictionCalibrationSnapshot) -> dict[str, Any]:
    return {
        "prediction_type": row.prediction_type,
        "algorithm_version": row.algorithm_version,
        "sample_count": row.sample_count,
        "outcome_count": row.outcome_count,
        "outcome_coverage": (
            round(row.outcome_count / row.sample_count, 4) if row.sample_count else None
        ),
        "brier_score": row.brier_score,
        "expected_calibration_error": row.expected_calibration_error,
        "buckets": row.buckets,
        "status": row.status,
        "calculated_at": row.calculated_at.isoformat(),
    }


async def calibration_overview(db: AsyncSession) -> dict[str, Any]:
    row = await db.scalar(
        select(PredictionCalibrationSnapshot)
        .where(PredictionCalibrationSnapshot.prediction_type == "task_failure")
        .order_by(PredictionCalibrationSnapshot.calculated_at.desc())
    )
    if row is None:
        return {
            "prediction_type": "task_failure",
            "algorithm_version": FAILURE_ALGORITHM_VERSION,
            "sample_count": 0,
            "outcome_count": 0,
            "outcome_coverage": None,
            "brier_score": None,
            "expected_calibration_error": None,
            "buckets": [],
            "status": "insufficient_data",
            "calculated_at": None,
        }
    return calibration_to_dict(row)
