"""Repeatable evidence reports for PlanPilot's four core learning claims."""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import timedelta
from statistics import mean
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.core.time import to_user_timezone, utc_now
from src.models import (
    AgentFeedbackEvent,
    DecisionProposal,
    Experiment,
    ExperimentAssignment,
    ExperimentVariant,
    LearnerCognitiveProfile,
    LearningEvent,
    LearningExperimentReport,
    PredictionObservation,
    ProposalFeedback,
    User,
    UserDataConsent,
)

SCHEMA_VERSION = "core-learning-experiment-v1"
MIN_PATTERN_BUCKET = 30
MIN_CALIBRATION_OUTCOMES = 100
MIN_PROPOSAL_OUTCOMES = 50


def _mean(values: list[float]) -> float | None:
    return round(mean(values), 4) if values else None


def _difference_ci(left: list[float], right: list[float]) -> tuple[float | None, list[float] | None]:
    if not left or not right:
        return None, None
    difference = mean(left) - mean(right)
    left_variance = mean((value - mean(left)) ** 2 for value in left)
    right_variance = mean((value - mean(right)) ** 2 for value in right)
    standard_error = math.sqrt(left_variance / len(left) + right_variance / len(right))
    return round(difference, 4), [
        round(difference - 1.96 * standard_error, 4),
        round(difference + 1.96 * standard_error, 4),
    ]


async def _eligible_user_ids(db: AsyncSession) -> set[str]:
    stmt = (
        select(UserDataConsent.user_id)
        .join(User, User.id == UserDataConsent.user_id)
        .where(UserDataConsent.experiments_enabled.is_(True))
    )
    if settings.environment.lower() == "production":
        stmt = stmt.where(
            ~User.email.ilike("%@test.com"),
            ~User.email.ilike("%@example.test"),
            ~User.email.ilike("%@localhost"),
        )
    return set((await db.execute(stmt)).scalars())


async def pattern_experiment(db: AsyncSession, *, window_days: int) -> dict[str, Any]:
    eligible = await _eligible_user_ids(db)
    since = utc_now() - timedelta(days=window_days)
    if not eligible:
        events = []
    else:
        events = list(
            (
                await db.execute(
                    select(LearningEvent).where(
                        LearningEvent.user_id.in_(eligible),
                        LearningEvent.event_type == "CheckinSubmitted",
                        LearningEvent.occurred_at >= since,
                    )
                )
            ).scalars()
        )
    timezones = dict(
        (
            await db.execute(select(User.id, User.timezone).where(User.id.in_(eligible)))
        ).all()
    ) if eligible else {}
    buckets: dict[str, list[float]] = {"afternoon": [], "evening": []}
    for event in events:
        value = (event.payload or {}).get("completion_rate")
        if not isinstance(value, (int, float)):
            continue
        hour = to_user_timezone(event.occurred_at, timezones.get(event.user_id, "UTC")).hour
        if 12 <= hour < 18:
            buckets["afternoon"].append(float(value))
        elif 18 <= hour < 24:
            buckets["evening"].append(float(value))
    difference, confidence_interval = _difference_ci(
        buckets["evening"], buckets["afternoon"]
    )
    sufficient = all(len(values) >= MIN_PATTERN_BUCKET for values in buckets.values())
    status = "insufficient_data"
    if sufficient:
        status = (
            "supported"
            if difference is not None
            and difference >= 0.10
            and confidence_interval is not None
            and confidence_interval[0] > 0
            else "not_supported"
        )
    return {
        "experiment_key": "pattern_validity",
        "status": status,
        "question": "系统能否学习出稳定、可复现的时段完成率差异？",
        "window_days": window_days,
        "buckets": {
            key: {"sample_count": len(values), "completion_rate": _mean(values)}
            for key, values in buckets.items()
        },
        "evening_minus_afternoon": difference,
        "difference_95_ci": confidence_interval,
        "minimum_samples_per_bucket": MIN_PATTERN_BUCKET,
    }


async def prediction_experiment(db: AsyncSession, *, window_days: int) -> dict[str, Any]:
    eligible = await _eligible_user_ids(db)
    since = utc_now() - timedelta(days=window_days)
    rows = list(
        (
            await db.execute(
                select(PredictionObservation).where(
                    PredictionObservation.user_id.in_(eligible),
                    PredictionObservation.predicted_at >= since,
                    PredictionObservation.actual_outcome.isnot(None),
                )
            )
        ).scalars()
    ) if eligible else []
    brier = (
        mean(
            (row.predicted_probability - float(bool(row.actual_outcome))) ** 2
            for row in rows
        )
        if rows
        else None
    )
    bins: list[dict[str, Any]] = []
    weighted_error = 0.0
    for index in range(10):
        lower, upper = index / 10, (index + 1) / 10
        members = [
            row
            for row in rows
            if lower <= row.predicted_probability < upper
            or (index == 9 and row.predicted_probability == 1)
        ]
        if not members:
            continue
        predicted = mean(row.predicted_probability for row in members)
        observed = mean(float(bool(row.actual_outcome)) for row in members)
        weighted_error += abs(predicted - observed) * len(members)
        bins.append(
            {
                "range": [lower, upper],
                "sample_count": len(members),
                "predicted_rate": round(predicted, 4),
                "observed_rate": round(observed, 4),
                "absolute_gap": round(abs(predicted - observed), 4),
            }
        )
    ece = weighted_error / len(rows) if rows else None
    status = "insufficient_data"
    if len(rows) >= MIN_CALIBRATION_OUTCOMES:
        status = "supported" if brier is not None and brier <= 0.22 and ece <= 0.05 else "not_supported"
    return {
        "experiment_key": "prediction_calibration",
        "status": status,
        "question": "0.72 的失败风险是否长期对应约 72% 的实际失败？",
        "window_days": window_days,
        "outcome_count": len(rows),
        "brier_score": round(brier, 6) if brier is not None else None,
        "expected_calibration_error": round(ece, 6) if ece is not None else None,
        "reliability_bins": bins,
        "thresholds": {"minimum_outcomes": MIN_CALIBRATION_OUTCOMES, "max_brier": 0.22, "max_ece": 0.05},
    }


async def proposal_utility_experiment(db: AsyncSession, *, window_days: int) -> dict[str, Any]:
    eligible = await _eligible_user_ids(db)
    since = utc_now() - timedelta(days=window_days)
    proposals = list(
        (
            await db.execute(
                select(DecisionProposal).where(
                    DecisionProposal.user_id.in_(eligible),
                    DecisionProposal.created_at >= since,
                )
            )
        ).scalars()
    ) if eligible else []
    proposal_ids = [row.id for row in proposals]
    feedback_rows = list(
        (
            await db.execute(
                select(ProposalFeedback).where(ProposalFeedback.proposal_id.in_(proposal_ids))
            )
        ).scalars()
    ) if proposal_ids else []
    outcomes = list(
        (
            await db.execute(
                select(AgentFeedbackEvent).where(
                    AgentFeedbackEvent.proposal_id.in_(proposal_ids),
                    AgentFeedbackEvent.feedback_type.in_(
                        ["completion_rate_1d", "completion_rate_7d"]
                    ),
                )
            )
        ).scalars()
    ) if proposal_ids else []
    by_window: dict[str, list[float]] = defaultdict(list)
    deltas: dict[str, list[float]] = defaultdict(list)
    for row in outcomes:
        value = row.value or {}
        if value.get("completion_rate") is not None:
            by_window[row.attribution_window].append(float(value["completion_rate"]))
        if value.get("completion_delta") is not None:
            deltas[row.attribution_window].append(float(value["completion_delta"]))
    reviewed = [row for row in proposals if row.status in {"accepted", "applied", "rejected"}]
    accepted = [row for row in reviewed if row.status in {"accepted", "applied"}]
    helpful = [row for row in feedback_rows if row.outcome == "helpful"]
    seven_day_samples = len(by_window["7d"])
    seven_day_delta = _mean(deltas["7d"])
    status = "insufficient_data"
    if seven_day_samples >= MIN_PROPOSAL_OUTCOMES:
        status = "supported" if seven_day_delta is not None and seven_day_delta > 0.05 else "not_supported"
    return {
        "experiment_key": "proposal_utility",
        "status": status,
        "question": "建议被接受后，次日和七日结果是否真的改善？",
        "window_days": window_days,
        "proposal_count": len(proposals),
        "accept_rate": round(len(accepted) / len(reviewed), 4) if reviewed else None,
        "helpful_rate": round(len(helpful) / len(feedback_rows), 4) if feedback_rows else None,
        "next_day": {
            "sample_count": len(by_window["1d"]),
            "completion_rate": _mean(by_window["1d"]),
            "mean_delta": _mean(deltas["1d"]),
        },
        "seven_day": {
            "sample_count": seven_day_samples,
            "completion_rate": _mean(by_window["7d"]),
            "mean_delta": seven_day_delta,
        },
        "minimum_seven_day_outcomes": MIN_PROPOSAL_OUTCOMES,
        "interpretation": "accept_rate 仅表示采用，不作为有效性结论。",
    }


async def personalization_experiment(
    db: AsyncSession, *, experiment_id: str | None
) -> dict[str, Any]:
    experiment = await db.get(Experiment, experiment_id) if experiment_id else None
    if experiment is None:
        return {
            "experiment_key": "personalization_lift",
            "status": "not_configured",
            "question": "Learner Model 个性化是否带来长期净收益？",
            "experiment_id": experiment_id,
            "metrics": ["completion", "recovery", "mastery", "retention", "overload"],
        }
    variants = list(
        (
            await db.execute(
                select(ExperimentVariant).where(
                    ExperimentVariant.experiment_id == experiment.id
                )
            )
        ).scalars()
    )
    assignments = list(
        (
            await db.execute(
                select(ExperimentAssignment).where(
                    ExperimentAssignment.experiment_id == experiment.id
                )
            )
        ).scalars()
    )
    by_variant: dict[str, list[ExperimentAssignment]] = defaultdict(list)
    for assignment in assignments:
        by_variant[assignment.variant_id].append(assignment)
    results: list[dict[str, Any]] = []
    for variant in variants:
        assigned = by_variant[variant.id]
        user_ids = [row.user_id for row in assigned]
        assignment_times = {row.user_id: row.assigned_at for row in assigned}
        earliest = min((row.assigned_at for row in assigned), default=utc_now())
        events = list(
            (
                await db.execute(
                    select(LearningEvent).where(
                        LearningEvent.user_id.in_(user_ids),
                        LearningEvent.occurred_at >= earliest,
                    )
                )
            ).scalars()
        ) if user_ids else []
        events = [
            row
            for row in events
            if row.occurred_at >= assignment_times[row.user_id]
        ]
        completed = [row for row in events if row.event_type == "TaskCompleted"]
        skipped = [row for row in events if row.event_type == "TaskSkipped"]
        rescheduled = [row for row in events if row.event_type == "TaskRescheduled"]
        mastery = [row for row in events if row.event_type == "MasteryRecorded"]
        high_mastery = [
            row for row in mastery if (row.payload or {}).get("to_level") in {"L3", "L4"}
        ]
        retention = list(
            (
                await db.execute(
                    select(LearnerCognitiveProfile.retention_rate).where(
                        LearnerCognitiveProfile.user_id.in_(user_ids),
                        LearnerCognitiveProfile.retention_rate.isnot(None),
                    )
                )
            ).scalars()
        ) if user_ids else []
        outcomes = len(completed) + len(skipped)
        activity = max(1, outcomes + len(rescheduled))
        results.append(
            {
                "variant_id": variant.id,
                "key": variant.key,
                "is_control": variant.is_control,
                "user_count": len(user_ids),
                "completion": round(len(completed) / outcomes, 4) if outcomes else None,
                "recovery": round(
                    sum(int((row.payload or {}).get("days_overdue") or 0) > 0 for row in completed)
                    / len(completed),
                    4,
                ) if completed else None,
                "mastery": round(len(high_mastery) / len(mastery), 4) if mastery else None,
                "retention": _mean([float(value) for value in retention]),
                "overload": round((len(skipped) + len(rescheduled)) / activity, 4),
            }
        )
    control = next((row for row in results if row["is_control"]), None)
    treatment = next((row for row in results if not row["is_control"]), None)
    uplifts = {
        metric: (
            round(treatment[metric] - control[metric], 4)
            if treatment
            and control
            and treatment[metric] is not None
            and control[metric] is not None
            else None
        )
        for metric in ("completion", "recovery", "mastery", "retention", "overload")
    }
    sample_sufficient = bool(
        control
        and treatment
        and min(control["user_count"], treatment["user_count"])
        >= experiment.minimum_sample_size
    )
    status = "insufficient_data"
    if sample_sufficient:
        status = (
            "supported"
            if uplifts["completion"] is not None
            and uplifts["completion"] > 0.03
            and uplifts["overload"] is not None
            and uplifts["overload"] <= 0.05
            else "not_supported"
        )
    return {
        "experiment_key": "personalization_lift",
        "status": status,
        "question": "Learner Model 个性化是否提升长期结果且不增加过载？",
        "experiment_id": experiment.id,
        "minimum_users_per_variant": experiment.minimum_sample_size,
        "variants": results,
        "treatment_minus_control": uplifts,
        "guardrail": {"max_overload_uplift": 0.05},
    }


async def run_core_experiments(
    db: AsyncSession, *, window_days: int = 90, experiment_id: str | None = None
) -> dict[str, Any]:
    reports = [
        await pattern_experiment(db, window_days=window_days),
        await prediction_experiment(db, window_days=window_days),
        await proposal_utility_experiment(db, window_days=window_days),
        await personalization_experiment(db, experiment_id=experiment_id),
    ]
    generated_at = utc_now()
    for report in reports:
        db.add(
            LearningExperimentReport(
                experiment_key=report["experiment_key"],
                scope_key=experiment_id or "global",
                schema_version=SCHEMA_VERSION,
                status=report["status"],
                parameters={
                    "window_days": window_days,
                    "experiment_id": experiment_id,
                    "environment": settings.environment,
                    "data_origin": "consented_learning_data",
                    "synthetic_data_allowed": settings.environment.lower() != "production",
                },
                result=report,
                generated_at=generated_at,
            )
        )
    await db.commit()
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at.isoformat(),
        "reports": reports,
        "all_supported": all(row["status"] == "supported" for row in reports),
    }


async def list_reports(db: AsyncSession, *, limit: int = 40) -> list[dict[str, Any]]:
    rows = list(
        (
            await db.execute(
                select(LearningExperimentReport)
                .order_by(LearningExperimentReport.generated_at.desc())
                .limit(limit)
            )
        ).scalars()
    )
    return [
        {
            "id": row.id,
            "experiment_key": row.experiment_key,
            "scope_key": row.scope_key,
            "status": row.status,
            "schema_version": row.schema_version,
            "parameters": row.parameters,
            "result": row.result,
            "generated_at": row.generated_at.isoformat(),
        }
        for row in rows
    ]


async def latest_public_snapshot(db: AsyncSession) -> dict[str, Any]:
    """Return only the latest aggregate result for each core learning claim."""
    rows = list(
        (
            await db.execute(
                select(LearningExperimentReport)
                .where(
                    LearningExperimentReport.experiment_key.in_(
                        [
                            "pattern_validity",
                            "prediction_calibration",
                            "proposal_utility",
                            "personalization_lift",
                        ]
                    )
                )
                .order_by(LearningExperimentReport.generated_at.desc())
            )
        ).scalars()
    )
    latest: dict[str, LearningExperimentReport] = {}
    for row in rows:
        latest.setdefault(row.experiment_key, row)
    latest_generated_at = max(
        (row.generated_at for row in latest.values()), default=None
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": latest_generated_at.isoformat() if latest_generated_at else None,
        "reports": [
            {
                "experiment_key": key,
                "status": row.status,
                "result": row.result,
                "provenance": {
                    "schema_version": row.schema_version,
                    "environment": (row.parameters or {}).get("environment", "unknown"),
                    "data_origin": (row.parameters or {}).get("data_origin", "unknown"),
                    "window_days": (row.parameters or {}).get("window_days"),
                    "synthetic_data_allowed": (row.parameters or {}).get(
                        "synthetic_data_allowed", True
                    ),
                    "stale": (utc_now() - row.generated_at).days > 7,
                },
                "generated_at": row.generated_at.isoformat(),
            }
            for key, row in latest.items()
        ],
    }
