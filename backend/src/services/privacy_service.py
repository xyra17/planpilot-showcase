"""User-controlled learning-data purposes, portability, and quality checks."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.core.time import utc_now
from src.models import (
    AgentFeedbackEvent,
    AgentInvocation,
    AgentTraceSpan,
    AuthSession,
    CheckinRecord,
    ConsentAuditEvent,
    DataExportAudit,
    DataQualitySnapshot,
    DecisionProposal,
    ExperimentAssignment,
    Goal,
    LearnerCognitiveProfile,
    LearnerPattern,
    LearnerPatternAudit,
    LearnerPatternSuppression,
    LearnerProfile,
    LearningEvent,
    LearningMemory,
    PredictionObservation,
    ProposalFeedback,
    Task,
    User,
    UserDataConsent,
)

POLICY_VERSION = "2026-08"
EXPORT_SCHEMA_VERSION = "planpilot-user-export-v1"
QUALITY_SCHEMA_VERSION = "learning-data-quality-v1"


def consent_dict(row: UserDataConsent) -> dict[str, Any]:
    return {
        "personalization_enabled": row.personalization_enabled,
        "experiments_enabled": row.experiments_enabled,
        "product_analytics_enabled": row.product_analytics_enabled,
        "sensitive_inference_enabled": row.sensitive_inference_enabled,
        "policy_version": row.policy_version,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def get_or_create_consent(db: AsyncSession, user_id: str) -> UserDataConsent:
    row = await db.get(UserDataConsent, user_id)
    if row is None:
        row = UserDataConsent(user_id=user_id, policy_version=POLICY_VERSION)
        db.add(row)
        await db.flush()
    return row


async def experiments_allowed(db: AsyncSession, user_id: str) -> bool:
    row = await db.get(UserDataConsent, user_id)
    return bool(row and row.experiments_enabled)


async def personalization_allowed(db: AsyncSession, user_id: str) -> bool:
    row = await db.get(UserDataConsent, user_id)
    return row is None or row.personalization_enabled


async def evidence_participation_status(
    db: AsyncSession, *, user: User
) -> dict[str, Any]:
    consent = await db.get(UserDataConsent, user.id)
    quality = await db.scalar(
        select(DataQualitySnapshot)
        .where(DataQualitySnapshot.user_id == user.id)
        .order_by(DataQualitySnapshot.sampled_at.desc())
        .limit(1)
    )
    test_domain = user.email.lower().endswith(("@test.com", "@example.test", "@localhost"))
    cohort = (
        "real_user"
        if settings.environment.lower() == "production" and not test_domain
        else "internal_or_test"
    )
    return {
        "cohort": cohort,
        "environment": settings.environment,
        "experiments_enabled": bool(consent and consent.experiments_enabled),
        "product_analytics_enabled": bool(consent and consent.product_analytics_enabled),
        "quality_score": round(quality.quality_score, 4) if quality else None,
        "quality_schema_version": quality.schema_version if quality else None,
        "quality_sampled_at": quality.sampled_at.isoformat() if quality else None,
        "eligible_for_real_evidence": bool(
            cohort == "real_user"
            and consent
            and consent.experiments_enabled
            and quality
            and quality.quality_score >= 0.8
        ),
    }


async def update_consent(
    db: AsyncSession,
    *,
    user_id: str,
    changes: dict[str, bool],
    request_id: str | None,
    erase_derived_data: bool,
) -> dict[str, Any]:
    if request_id:
        prior = await db.scalar(
            select(ConsentAuditEvent).where(ConsentAuditEvent.request_id == request_id)
        )
        if prior is not None:
            return consent_dict(await get_or_create_consent(db, user_id))

    row = await get_or_create_consent(db, user_id)
    personalization_was_enabled = row.personalization_enabled
    for key, value in changes.items():
        setattr(row, key, value)
    row.policy_version = POLICY_VERSION
    row.updated_at = utc_now()
    await db.flush()

    purposes = {
        "personalization_enabled": row.personalization_enabled,
        "experiments_enabled": row.experiments_enabled,
        "product_analytics_enabled": row.product_analytics_enabled,
        "sensitive_inference_enabled": row.sensitive_inference_enabled,
    }
    db.add(
        ConsentAuditEvent(
            user_id=user_id,
            purposes=purposes,
            policy_version=POLICY_VERSION,
            source="account_settings",
            request_id=request_id,
            occurred_at=utc_now(),
        )
    )
    if not row.experiments_enabled:
        await db.execute(delete(ExperimentAssignment).where(ExperimentAssignment.user_id == user_id))
    erased = False
    if personalization_was_enabled and not row.personalization_enabled and erase_derived_data:
        await erase_personalization_derivatives(db, user_id)
        erased = True
    result = {**consent_dict(row), "derived_data_erased": erased}
    await db.commit()
    return result


async def erase_personalization_derivatives(db: AsyncSession, user_id: str) -> None:
    """Erase recomputable inferences, preserving user-authored source records."""
    for model in (
        LearnerProfile,
        LearnerPattern,
        LearnerPatternAudit,
        LearnerPatternSuppression,
        LearnerCognitiveProfile,
        LearningMemory,
        PredictionObservation,
    ):
        await db.execute(delete(model).where(model.user_id == user_id))


def _json_value(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


def _public_row(row: Any, *, omit: set[str] | None = None) -> dict[str, Any]:
    blocked = {"hashed_password", "refresh_token_hash", "token"} | (omit or set())
    return {
        column.key: _json_value(getattr(row, column.key))
        for column in row.__table__.columns
        if column.key not in blocked
    }


async def build_user_export(db: AsyncSession, user: User) -> dict[str, Any]:
    goals = list((await db.execute(select(Goal).where(Goal.user_id == user.id))).scalars())
    goal_ids = [row.id for row in goals]
    tasks = list(
        (await db.execute(select(Task).where(Task.goal_id.in_(goal_ids)))).scalars()
    ) if goal_ids else []
    owned_models = {
        "checkins": CheckinRecord,
        "learning_events": LearningEvent,
        "learner_profiles": LearnerProfile,
        "learner_patterns": LearnerPattern,
        "learner_pattern_audits": LearnerPatternAudit,
        "learner_pattern_suppressions": LearnerPatternSuppression,
        "cognitive_profiles": LearnerCognitiveProfile,
        "learning_memories": LearningMemory,
        "proposals": DecisionProposal,
        "proposal_feedback": ProposalFeedback,
        "prediction_observations": PredictionObservation,
        "agent_feedback_events": AgentFeedbackEvent,
        "consent_history": ConsentAuditEvent,
    }
    sections: dict[str, list[dict[str, Any]]] = {
        "goals": [_public_row(row) for row in goals],
        "tasks": [_public_row(row) for row in tasks],
    }
    for name, model in owned_models.items():
        rows = list(
            (await db.execute(select(model).where(model.user_id == user.id))).scalars()
        )
        sections[name] = [_public_row(row) for row in rows]

    consent = await get_or_create_consent(db, user.id)
    account = _public_row(user, omit={"is_admin", "is_active"})
    payload = {
        "schema_version": EXPORT_SCHEMA_VERSION,
        "generated_at": utc_now().isoformat(),
        "account": account,
        "consent": consent_dict(consent),
        "data": sections,
    }
    counts = {name: len(rows) for name, rows in sections.items()}
    db.add(
        DataExportAudit(
            user_id=user.id,
            schema_version=EXPORT_SCHEMA_VERSION,
            section_counts=counts,
            requested_at=utc_now(),
        )
    )
    await db.commit()
    return payload


async def generate_quality_report(
    db: AsyncSession, *, user_id: str, window_days: int = 90
) -> dict[str, Any]:
    now = utc_now()
    window_start = now - timedelta(days=window_days)
    goals = list((await db.execute(select(Goal.id).where(Goal.user_id == user_id))).scalars())
    tasks = list(
        (await db.execute(select(Task).where(Task.goal_id.in_(goals)))).scalars()
    ) if goals else []
    events = list(
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.user_id == user_id,
                    LearningEvent.occurred_at >= window_start,
                )
            )
        ).scalars()
    )
    completed_ids = {row.id for row in tasks if row.status == "completed"}
    completion_event_ids = {
        row.aggregate_id for row in events if row.event_type == "TaskCompleted"
    }
    completion_coverage = (
        len(completed_ids & completion_event_ids) / len(completed_ids) if completed_ids else 1.0
    )
    active_days = len({row.occurred_at.date() for row in events})

    predictions = list(
        (
            await db.execute(
                select(PredictionObservation).where(PredictionObservation.user_id == user_id)
            )
        ).scalars()
    )
    matured_predictions = [
        row for row in predictions if row.outcome_due_at and row.outcome_due_at <= now
    ]
    unresolved_predictions = sum(row.actual_outcome is None for row in matured_predictions)

    applied = list(
        (
            await db.execute(
                select(DecisionProposal).where(
                    DecisionProposal.user_id == user_id,
                    DecisionProposal.status == "applied",
                )
            )
        ).scalars()
    )
    feedback_events = list(
        (
            await db.execute(
                select(AgentFeedbackEvent).where(AgentFeedbackEvent.user_id == user_id)
            )
        ).scalars()
    )
    delayed_keys = {row.dedupe_key for row in feedback_events if row.attribution_window != "immediate"}
    due_windows = 0
    captured_windows = 0
    for proposal in applied:
        for days in (1, 7):
            if proposal.applied_at and proposal.applied_at <= now - timedelta(days=days):
                due_windows += 1
                prefix = f"proposal:{proposal.id}:completion_rate_{days}d:"
                captured_windows += any(key.startswith(prefix) for key in delayed_keys)
    proposal_outcome_coverage = captured_windows / due_windows if due_windows else 1.0

    checks = {
        "minimum_event_volume": len(events) >= 30,
        "minimum_active_days": active_days >= 14,
        "completion_event_coverage": completion_coverage >= 0.95,
        "prediction_outcomes_current": unresolved_predictions == 0,
        "proposal_outcome_coverage": proposal_outcome_coverage >= 0.95,
    }
    score = sum(checks.values()) / len(checks)
    report = {
        "schema_version": QUALITY_SCHEMA_VERSION,
        "window_days": window_days,
        "window_start": window_start.isoformat(),
        "window_end": now.isoformat(),
        "metrics": {
            "event_count": len(events),
            "active_days": active_days,
            "task_count": len(tasks),
            "completed_task_count": len(completed_ids),
            "completion_event_coverage": round(completion_coverage, 4),
            "matured_prediction_count": len(matured_predictions),
            "unresolved_prediction_count": unresolved_predictions,
            "applied_proposal_count": len(applied),
            "due_proposal_outcome_windows": due_windows,
            "proposal_outcome_coverage": round(proposal_outcome_coverage, 4),
        },
        "checks": checks,
        "quality_score": round(score, 4),
        "experiment_readiness": {
            "pattern": active_days >= 14 and len(events) >= 30,
            "prediction_calibration": sum(row.actual_outcome is not None for row in predictions) >= 100,
            "proposal_utility": captured_windows >= 50,
            "personalization_lift": active_days >= 14 and len(events) >= 30,
        },
    }
    db.add(
        DataQualitySnapshot(
            user_id=user_id,
            schema_version=QUALITY_SCHEMA_VERSION,
            window_days=window_days,
            quality_score=round(score, 4),
            report=report,
            sampled_at=now,
        )
    )
    await db.commit()
    return report


async def apply_retention_policy(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """Apply documented purpose-specific retention windows in one transaction."""
    now = now or utc_now()
    policies = (
        (
            "expired_auth_sessions",
            AuthSession,
            AuthSession.expires_at
            < now - timedelta(days=settings.expired_session_retention_days),
        ),
        (
            "agent_trace_spans",
            AgentTraceSpan,
            AgentTraceSpan.created_at
            < now - timedelta(days=settings.agent_observability_retention_days),
        ),
        (
            "agent_invocations",
            AgentInvocation,
            AgentInvocation.created_at
            < now - timedelta(days=settings.agent_observability_retention_days),
        ),
        (
            "prediction_observations",
            PredictionObservation,
            PredictionObservation.predicted_at
            < now - timedelta(days=settings.prediction_retention_days),
        ),
        (
            "learning_events",
            LearningEvent,
            LearningEvent.occurred_at
            < now - timedelta(days=settings.learning_event_retention_days),
        ),
        (
            "data_quality_snapshots",
            DataQualitySnapshot,
            DataQualitySnapshot.sampled_at
            < now - timedelta(days=settings.data_quality_retention_days),
        ),
        (
            "data_export_audits",
            DataExportAudit,
            DataExportAudit.requested_at
            < now - timedelta(days=settings.export_audit_retention_days),
        ),
    )
    counts: dict[str, int] = {}
    for name, model, predicate in policies:
        result = await db.execute(delete(model).where(predicate))
        counts[name] = int(result.rowcount or 0)
    await db.commit()
    return counts
