"""PMF evidence and a single auditable production-readiness decision workflow."""

from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.models import (
    DataQualitySnapshot,
    LearningEvent,
    ProductFeedbackSignal,
    ProductionReadinessDecision,
    ProductValidationSnapshot,
    User,
    UserDataConsent,
)
from src.services import canary_service, core_experiment_service

PMF_SCHEMA_VERSION = "product-validation-v1"
READINESS_SCHEMA_VERSION = "production-readiness-v1"
MIN_PMF_SURVEYS = 40
MIN_BEHAVIORAL_COHORT = 40


async def record_pmf_survey(
    db: AsyncSession,
    *,
    user_id: str,
    disappointment: str,
    primary_value: str,
    request_id: str,
) -> dict[str, Any]:
    consent = await db.get(UserDataConsent, user_id)
    if consent is None or not consent.product_analytics_enabled:
        raise PermissionError("提交产品研究反馈前需启用产品分析同意")
    existing = await db.scalar(
        select(ProductFeedbackSignal).where(ProductFeedbackSignal.request_id == request_id)
    )
    if existing is None:
        existing = ProductFeedbackSignal(
            user_id=user_id,
            signal_type="pmf_survey",
            value={
                "disappointment": disappointment,
                "primary_value": primary_value,
                "survey_version": "sean-ellis-v1",
            },
            request_id=request_id,
            occurred_at=utc_now(),
        )
        db.add(existing)
        await db.commit()
    return {
        "id": existing.id,
        "signal_type": existing.signal_type,
        "value": existing.value,
        "occurred_at": existing.occurred_at.isoformat(),
    }


async def generate_product_validation(db: AsyncSession) -> dict[str, Any]:
    now = utc_now()
    eligible_users = list(
        (
            await db.execute(
                select(User)
                .join(UserDataConsent, UserDataConsent.user_id == User.id)
                .where(UserDataConsent.product_analytics_enabled.is_(True))
            )
        ).scalars()
    )
    user_ids = [row.id for row in eligible_users]
    events = list(
        (
            await db.execute(
                select(LearningEvent).where(LearningEvent.user_id.in_(user_ids))
            )
        ).scalars()
    ) if user_ids else []
    events_by_user: dict[str, list[LearningEvent]] = defaultdict(list)
    for event in events:
        events_by_user[event.user_id].append(event)

    activation_cohort = [row for row in eligible_users if row.created_at <= now - timedelta(days=7)]
    activated = 0
    for user in activation_cohort:
        deadline = user.created_at + timedelta(days=7)
        completed = {
            event.aggregate_id
            for event in events_by_user[user.id]
            if event.event_type == "TaskCompleted"
            and user.created_at <= event.occurred_at <= deadline
        }
        activated += len(completed) >= 3

    retention_cohort = [row for row in eligible_users if row.created_at <= now - timedelta(days=28)]
    retained = 0
    for user in retention_cohort:
        start = user.created_at + timedelta(days=22)
        end = user.created_at + timedelta(days=35)
        retained += any(start <= event.occurred_at <= end for event in events_by_user[user.id])

    surveys = list(
        (
            await db.execute(
                select(ProductFeedbackSignal)
                .where(
                    ProductFeedbackSignal.user_id.in_(user_ids),
                    ProductFeedbackSignal.signal_type == "pmf_survey",
                )
                .order_by(ProductFeedbackSignal.occurred_at.desc())
            )
        ).scalars()
    ) if user_ids else []
    latest_surveys: dict[str, ProductFeedbackSignal] = {}
    for survey in surveys:
        latest_surveys.setdefault(survey.user_id, survey)
    very_disappointed = sum(
        (row.value or {}).get("disappointment") == "very_disappointed"
        for row in latest_surveys.values()
    )

    recent_events = [event for event in events if event.occurred_at >= now - timedelta(days=28)]
    task_outcomes = sum(
        event.event_type in {"TaskCompleted", "TaskSkipped"} for event in recent_events
    )
    overload_events = sum(
        event.event_type in {"TaskSkipped", "TaskRescheduled"} for event in recent_events
    )
    activation_rate = activated / len(activation_cohort) if activation_cohort else None
    retention_rate = retained / len(retention_cohort) if retention_cohort else None
    pmf_rate = very_disappointed / len(latest_surveys) if latest_surveys else None
    overload_rate = overload_events / max(1, task_outcomes + overload_events)

    latest_quality: dict[str, DataQualitySnapshot] = {}
    quality_rows = list(
        (
            await db.execute(
                select(DataQualitySnapshot)
                .where(DataQualitySnapshot.user_id.in_(user_ids))
                .order_by(DataQualitySnapshot.sampled_at.desc())
            )
        ).scalars()
    ) if user_ids else []
    for row in quality_rows:
        latest_quality.setdefault(row.user_id, row)
    quality_ready_rate = (
        sum(row.quality_score >= 0.8 for row in latest_quality.values()) / len(latest_quality)
        if latest_quality
        else None
    )

    sufficient = (
        len(latest_surveys) >= MIN_PMF_SURVEYS
        and len(activation_cohort) >= MIN_BEHAVIORAL_COHORT
        and len(retention_cohort) >= MIN_BEHAVIORAL_COHORT
    )
    thresholds = {
        "very_disappointed_rate": 0.40,
        "activation_rate": 0.40,
        "week4_retention_rate": 0.25,
        "max_overload_rate": 0.25,
        "minimum_surveys": MIN_PMF_SURVEYS,
        "minimum_behavioral_cohort": MIN_BEHAVIORAL_COHORT,
    }
    status = "insufficient_data"
    if sufficient:
        status = (
            "supported"
            if pmf_rate is not None
            and pmf_rate >= thresholds["very_disappointed_rate"]
            and activation_rate is not None
            and activation_rate >= thresholds["activation_rate"]
            and retention_rate is not None
            and retention_rate >= thresholds["week4_retention_rate"]
            and overload_rate <= thresholds["max_overload_rate"]
            else "not_supported"
        )
    report = {
        "schema_version": PMF_SCHEMA_VERSION,
        "status": status,
        "generated_at": now.isoformat(),
        "consented_user_count": len(eligible_users),
        "metrics": {
            "survey_count": len(latest_surveys),
            "very_disappointed_rate": round(pmf_rate, 4) if pmf_rate is not None else None,
            "activation_cohort": len(activation_cohort),
            "activation_rate": round(activation_rate, 4) if activation_rate is not None else None,
            "week4_retention_cohort": len(retention_cohort),
            "week4_retention_rate": round(retention_rate, 4) if retention_rate is not None else None,
            "overload_rate_28d": round(overload_rate, 4),
            "quality_ready_rate": (
                round(quality_ready_rate, 4) if quality_ready_rate is not None else None
            ),
        },
        "thresholds": thresholds,
    }
    db.add(
        ProductValidationSnapshot(
            schema_version=PMF_SCHEMA_VERSION,
            status=status,
            report=report,
            generated_at=now,
        )
    )
    await db.commit()
    return report


async def evaluate_production_readiness(
    db: AsyncSession,
    *,
    actor: str,
    canary_release_id: str | None,
    personalization_experiment_id: str | None,
    window_days: int,
    enforce_rollback: bool = False,
) -> dict[str, Any]:
    core = await core_experiment_service.run_core_experiments(
        db,
        window_days=window_days,
        experiment_id=personalization_experiment_id,
    )
    product = await generate_product_validation(db)
    canary = (
        await canary_service.get_canary(db, canary_release_id)
        if canary_release_id
        else None
    )
    decision, reason_codes = readiness_decision(core=core, product=product, canary=canary)
    enforced = False
    if decision == "rollback" and enforce_rollback and canary_release_id and canary:
        if canary["status"] in {"running", "paused"}:
            await canary_service.rollback_canary(
                db,
                canary_release_id,
                actor,
                "自动发布决策触发：" + ", ".join(reason_codes),
            )
            enforced = True
    generated_at = utc_now()
    evidence = {
        "schema_version": READINESS_SCHEMA_VERSION,
        "core_experiments": core,
        "product_validation": product,
        "canary": canary,
        "rollback_enforced": enforced,
    }
    row = ProductionReadinessDecision(
        decision=decision,
        reason_codes=reason_codes,
        evidence=evidence,
        canary_release_id=canary_release_id,
        actor=actor,
        generated_at=generated_at,
    )
    db.add(row)
    await db.commit()
    return {
        "id": row.id,
        "decision": decision,
        "reason_codes": reason_codes,
        "evidence": evidence,
        "generated_at": generated_at.isoformat(),
    }


def readiness_decision(
    *, core: dict[str, Any], product: dict[str, Any], canary: dict[str, Any] | None
) -> tuple[str, list[str]]:
    """Pure precedence rule: safety rollback > evidence hold > go."""
    blockers: list[str] = []
    rollback_reasons: list[str] = []
    if not core["all_supported"]:
        blockers.append("core_experiments_not_supported")
    if product["status"] != "supported":
        blockers.append(f"product_validation_{product['status']}")
    if canary is None:
        blockers.append("canary_missing")
    else:
        canary_blockers = list(canary.get("advance_blockers") or [])
        rollback_reasons.extend(
            reason
            for reason in canary_blockers
            if reason in {"critical_safety_incident", "error_rate", "fallback_rate"}
        )
        if canary["status"] == "rolled_back":
            rollback_reasons.append("canary_already_rolled_back")
        if canary["status"] not in {"running", "completed"}:
            blockers.append(f"canary_status_{canary['status']}")
        if canary["current_stage"] != "100":
            blockers.append("canary_not_at_100_percent")
        blockers.extend(f"canary_{reason}" for reason in canary_blockers)

    decision = "rollback" if rollback_reasons else "hold" if blockers else "go"
    return decision, list(dict.fromkeys(rollback_reasons + blockers))


async def list_decisions(db: AsyncSession, *, limit: int = 30) -> list[dict[str, Any]]:
    rows = list(
        (
            await db.execute(
                select(ProductionReadinessDecision)
                .order_by(ProductionReadinessDecision.generated_at.desc())
                .limit(limit)
            )
        ).scalars()
    )
    return [
        {
            "id": row.id,
            "decision": row.decision,
            "reason_codes": row.reason_codes,
            "canary_release_id": row.canary_release_id,
            "actor": row.actor,
            "generated_at": row.generated_at.isoformat(),
        }
        for row in rows
    ]
