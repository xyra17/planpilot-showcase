"""Server-controlled Action beta, funnel evidence and human review queue."""

from __future__ import annotations

import hashlib
import hmac
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.core.time import utc_now
from src.models import (
    AgentApproval,
    AgentAuditEvent,
    AgentBetaControl,
    AgentBetaControlEvent,
    AgentBetaReviewSample,
    AgentDeployment,
    AgentFeedbackEvent,
    AgentRun,
    CheckinRecord,
    DecisionProposal,
    EvaluationCase,
    EvaluationDataset,
    EvaluationRun,
    Goal,
    InsightActionRun,
    LearningEvent,
    OfflineEvaluationGate,
    Task,
)
from src.services.agent_control_service import canonical_hash

CONTROL_ID = "action-beta"
METRIC_VERSION_V1 = "action-beta-funnel-v1"
METRIC_VERSION = "action-beta-funnel-v2"
TRAFFIC_STAGES = {0, 5, 20, 50}
HARD_SAFETY_KEYS = (
    "unconfirmed_write_count",
    "cross_user_access_count",
    "duplicate_write_count",
    "review_binding_failure_count",
)
REVIEW_SAMPLE_TYPES = {
    "false_action",
    "missed_action",
    "wrong_core_need",
    "wrong_entity",
    "unnecessary_clarification",
    "insufficient_clarification",
    "heavily_edited_changeset",
    "quick_rollback",
    "review_false_positive",
    "review_false_negative",
    "review_decision_check",
    "execution_failure",
    "routing_anomaly",
    "clarification_anomaly",
}


def _control_dict(row: AgentBetaControl) -> dict[str, Any]:
    return {
        "id": row.id,
        "beta_enabled": row.beta_enabled,
        "new_action_runs_enabled": row.new_action_runs_enabled,
        "cohort_mode": row.cohort_mode,
        "traffic_percent": row.traffic_percent,
        "allowlisted_user_ids": row.allowlisted_user_ids,
        "metric_version": row.metric_version,
        "measurement_started_at": row.measurement_started_at.isoformat(),
        "paused_reason": row.paused_reason,
        "safety_snapshot": row.safety_snapshot,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def ensure_control(db: AsyncSession) -> AgentBetaControl:
    row = await db.scalar(
        select(AgentBetaControl)
        .where(AgentBetaControl.id == CONTROL_ID)
        .execution_options(populate_existing=True)
    )
    if row is None:
        row = AgentBetaControl(id=CONTROL_ID)
        db.add(row)
        await db.flush()
    return row


def _bucket(user_id: str) -> int:
    digest = hmac.new(settings.secret_key.encode(), user_id.encode(), hashlib.sha256).digest()
    return int.from_bytes(digest[:4], "big") % 100


async def assignment(db: AsyncSession, user_id: str) -> dict[str, Any]:
    control = await ensure_control(db)
    allowlisted = user_id in set(control.allowlisted_user_ids or [])
    enrolled = bool(
        control.beta_enabled
        and (
            allowlisted
            if control.cohort_mode == "allowlist"
            else allowlisted or _bucket(user_id) < control.traffic_percent
        )
    )
    return {
        "enrolled": enrolled,
        "cohort": "beta" if enrolled else "stable",
        "mode": control.cohort_mode,
        "traffic_percent": control.traffic_percent,
        "metric_version": control.metric_version,
    }


async def assert_new_action_run_allowed(db: AsyncSession, user_id: str) -> dict[str, Any]:
    control = await ensure_control(db)
    if not control.new_action_runs_enabled:
        raise HTTPException(
            503,
            {
                "code": "new_action_runs_disabled",
                "message": "新的行动任务已由安全开关暂停；现有任务仍可查看、审计和撤销。",
            },
        )
    return await assignment(db, user_id)


async def _latest_runtime_gate(db: AsyncSession) -> OfflineEvaluationGate | None:
    return await db.scalar(
        select(OfflineEvaluationGate)
        .where(OfflineEvaluationGate.criteria_version == "agent-v25-runtime-safety-gate-v1")
        .order_by(OfflineEvaluationGate.decided_at.desc())
        .limit(1)
    )


def _hard_safety_clear(snapshot: dict[str, Any]) -> bool:
    counts = snapshot.get("counts") if isinstance(snapshot.get("counts"), dict) else snapshot
    return snapshot.get("status") == "observed_clear" and all(
        int(counts.get(key) or 0) == 0 for key in HARD_SAFETY_KEYS
    )


async def update_control(
    db: AsyncSession,
    *,
    actor_id: str,
    reason: str,
    beta_enabled: bool | None = None,
    new_action_runs_enabled: bool | None = None,
    cohort_mode: str | None = None,
    traffic_percent: int | None = None,
    allowlisted_user_ids: list[str] | None = None,
) -> dict[str, Any]:
    row = await ensure_control(db)
    before = _control_dict(row)
    next_beta = row.beta_enabled if beta_enabled is None else beta_enabled
    next_runs = (
        row.new_action_runs_enabled
        if new_action_runs_enabled is None
        else new_action_runs_enabled
    )
    next_mode = row.cohort_mode if cohort_mode is None else cohort_mode
    next_traffic = row.traffic_percent if traffic_percent is None else traffic_percent
    next_allowlist = (
        list(row.allowlisted_user_ids or [])
        if allowlisted_user_ids is None
        else sorted(set(allowlisted_user_ids))
    )
    if next_mode not in {"allowlist", "percentage"}:
        raise ValueError("cohort_mode 仅支持 allowlist 或 percentage")
    if next_traffic not in TRAFFIC_STAGES:
        raise ValueError("traffic_percent 仅支持 0、5、20、50")
    expanding = (
        (next_beta and not row.beta_enabled)
        or next_traffic > row.traffic_percent
        or len(next_allowlist) > len(row.allowlisted_user_ids or [])
        or (next_runs and not row.new_action_runs_enabled)
    )
    gate = await runtime_gate_status(db)
    current_safety = await safety_status(db, row)
    gate_passed = gate["valid"]
    if expanding and (not gate_passed or current_safety.get("status") != "observed_clear"):
        blockers = [*gate.get("blockers", []), *current_safety.get("blockers", [])]
        raise ValueError(
            "缺少与当前部署匹配的 fresh Runtime Gate 或 fresh observed_clear，"
            f"禁止扩大 Beta cohort：{','.join(blockers)}"
        )
    row.beta_enabled = next_beta
    row.new_action_runs_enabled = next_runs
    row.cohort_mode = next_mode
    row.traffic_percent = next_traffic
    row.allowlisted_user_ids = next_allowlist
    row.paused_reason = None if next_runs else reason
    row.updated_by = actor_id
    after = _control_dict(row)
    db.add(
        AgentBetaControlEvent(
            control_id=row.id,
            action="cohort_expanded" if expanding else "control_updated",
            actor_id=actor_id,
            reason=reason,
            before_state=before,
            after_state=after,
        )
    )
    await db.commit()
    return {**after, "expansion_gate_passed": gate_passed}


async def apply_safety_snapshot(
    db: AsyncSession, *, actor_id: str, snapshot: dict[str, Any], reason: str
) -> dict[str, Any]:
    """Compatibility helper for deterministic tests; production uses audit scans."""
    return await record_safety_observation(
        db,
        actor_id=actor_id,
        counts={key: int(snapshot.get(key) or 0) for key in HARD_SAFETY_KEYS},
        reason=reason,
        source="test_fixture",
        audit_start=utc_now() - timedelta(minutes=1),
        audit_end=utc_now(),
    )


def _pseudonym(user_id: str) -> str:
    return hmac.new(settings.secret_key.encode(), user_id.encode(), hashlib.sha256).hexdigest()[:24]


def _safe_run_context(run: AgentRun) -> dict[str, Any]:
    trace = run.trace_context or {}
    objective = run.objective or {}
    return {
        "status": run.status,
        "run_kind": run.run_kind,
        "capability": objective.get("capability") or trace.get("capability"),
        "core_need": trace.get("core_need"),
        "resolution_quality": trace.get("resolution_quality"),
        "beta_cohort": (trace.get("beta") or {}).get("cohort"),
        "error_category": (run.result or {}).get("error_category"),
    }


async def normalize_review_samples(db: AsyncSession) -> int:
    """Create deduplicated samples from real facts without copying request text."""
    created = 0
    runs = list((await db.execute(select(AgentRun).order_by(AgentRun.created_at.desc()).limit(500))).scalars())
    run_ids = [row.id for row in runs]
    events = (
        list((await db.execute(select(AgentAuditEvent).where(AgentAuditEvent.run_id.in_(run_ids)))).scalars())
        if run_ids
        else []
    )
    approvals = (
        list(
            (
                await db.execute(select(AgentApproval).where(AgentApproval.run_id.in_(run_ids)))
            ).scalars()
        )
        if run_ids
        else []
    )
    turn_events = list(
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.event_type.in_(
                        {"ConversationTurnReceived", "ClarificationRequested", "IntentResolved"}
                    )
                )
                .order_by(LearningEvent.created_at.desc())
                .limit(1000)
            )
        ).scalars()
    )
    event_types: dict[str, set[str]] = {}
    for event in events:
        event_types.setdefault(event.run_id, set()).add(event.event_type)
    existing = {
        (row.source_kind, row.source_id, row.sample_type)
        for row in (
            await db.execute(select(AgentBetaReviewSample))
        ).scalars()
    }
    for run in runs:
        observed: list[str] = []
        if run.status == "failed":
            observed.append("execution_failure")
        if run.status == "rolled_back":
            observed.append("quick_rollback")
        if "approval.edited" in event_types.get(run.id, set()):
            observed.append("heavily_edited_changeset")
        if any(
            (event.detail or {}).get("code") == "review_blocked"
            or "review_blocked" in ((event.detail or {}).get("finding_codes") or [])
            for event in events
            if event.run_id == run.id
        ):
            observed.append("review_decision_check")
        run_approvals = [row for row in approvals if row.run_id == run.id]
        if any((row.policy_decision or {}).get("risk") == "high" for row in run_approvals):
            observed.append("review_decision_check")
        if (
            _run_source(run) == "conversation"
            and run.conversation_turn_id
            and not any(
                event.aggregate_id == run.conversation_turn_id
                and event.event_type == "ConversationTurnReceived"
                for event in turn_events
            )
        ):
            observed.append("routing_anomaly")
        for sample_type in observed:
            key = ("agent_run", run.id, sample_type)
            if key in existing:
                continue
            db.add(
                AgentBetaReviewSample(
                    source_kind="agent_run",
                    source_id=run.id,
                    run_id=run.id,
                    conversation_turn_id=run.conversation_turn_id,
                    pseudonymous_user_key=_pseudonym(run.user_id),
                    sample_type=sample_type,
                    structured_context=_safe_run_context(run),
                    redacted_summary="由真实行动生命周期事件生成；原始请求文本未复制。",
                    retention_expires_at=utc_now()
                    + timedelta(days=settings.beta_review_sample_retention_days),
                )
            )
            existing.add(key)
            created += 1
    clarification_events = [
        event
        for event in turn_events
        if event.event_type == "ClarificationRequested"
        and event.created_at < utc_now() - timedelta(minutes=10)
    ]
    continued = {
        str((event.payload or {}).get("continued_from_turn_id"))
        for event in turn_events
        if event.event_type == "IntentResolved"
        and (event.payload or {}).get("continued_from_turn_id")
    }
    for event in clarification_events:
        key = ("learning_event", event.id, "clarification_anomaly")
        if event.aggregate_id in continued or key in existing:
            continue
        db.add(
            AgentBetaReviewSample(
                source_kind="learning_event",
                source_id=event.id,
                conversation_turn_id=event.aggregate_id,
                pseudonymous_user_key=_pseudonym(event.user_id),
                sample_type="clarification_anomaly",
                structured_context={
                    "missing_slots": (event.payload or {}).get("missing_slots") or [],
                    "beta_cohort": ((event.payload or {}).get("beta") or {}).get("cohort"),
                },
                redacted_summary="澄清请求在观察窗口内没有关联到 continued_from_turn_id；等待人工复核。",
                retention_expires_at=utc_now()
                + timedelta(days=settings.beta_review_sample_retention_days),
            )
        )
        existing.add(key)
        created += 1
    if created:
        control = await ensure_control(db)
        db.add(
            AgentBetaControlEvent(
                control_id=control.id,
                action="review_samples_normalized",
                reason="自动从真实事件提取脱敏复核样本",
                before_state={},
                after_state={"created": created},
            )
        )
    await db.commit()
    return created


async def cleanup_expired_review_samples(db: AsyncSession) -> int:
    expired = list(
        (
            await db.execute(
                select(AgentBetaReviewSample).where(
                    AgentBetaReviewSample.retention_expires_at <= utc_now()
                )
            )
        ).scalars()
    )
    for sample in expired:
        await db.delete(sample)
    control = await ensure_control(db)
    db.add(
        AgentBetaControlEvent(
            control_id=control.id,
            action="review_retention_cleanup",
            reason="删除超过保留期的 Beta 复核样本",
            before_state={"expired": len(expired)},
            after_state={"deleted": len(expired)},
        )
    )
    await db.commit()
    return len(expired)


def _sample_dict(row: AgentBetaReviewSample) -> dict[str, Any]:
    return {
        "id": row.id,
        "source_kind": row.source_kind,
        "run_id": row.run_id,
        "conversation_turn_id": row.conversation_turn_id,
        "pseudonymous_user_key": row.pseudonymous_user_key,
        "sample_type": row.sample_type,
        "structured_context": row.structured_context,
        "redacted_summary": row.redacted_summary,
        "status": row.status,
        "reviewer_note": row.reviewer_note,
        "candidate_dataset_id": row.candidate_dataset_id,
        "created_at": row.created_at.isoformat(),
        "retention_expires_at": row.retention_expires_at.isoformat(),
    }


async def list_review_samples(
    db: AsyncSession, *, status: str | None = None, limit: int = 100
) -> list[dict[str, Any]]:
    query = select(AgentBetaReviewSample)
    if status:
        query = query.where(AgentBetaReviewSample.status == status)
    rows = list((await db.execute(query.order_by(AgentBetaReviewSample.created_at.desc()).limit(limit))).scalars())
    return [_sample_dict(row) for row in rows]


async def review_sample(
    db: AsyncSession,
    *,
    sample_id: str,
    reviewer_id: str,
    status: str,
    note: str,
    sample_type: str | None = None,
) -> dict[str, Any]:
    if status not in {"reviewed", "confirmed", "dismissed"}:
        raise ValueError("无效的复核状态")
    row = await db.get(AgentBetaReviewSample, sample_id)
    if row is None:
        raise LookupError("复核样本不存在")
    if sample_type is not None:
        if sample_type not in REVIEW_SAMPLE_TYPES:
            raise ValueError("无效的复核样本分类")
        row.sample_type = sample_type
    row.status = status
    row.reviewer_id = reviewer_id
    row.reviewer_note = note
    await db.commit()
    return _sample_dict(row)


async def promote_candidate(
    db: AsyncSession, *, sample_id: str, reviewer_id: str, dataset_kind: str
) -> dict[str, Any]:
    row = await db.get(AgentBetaReviewSample, sample_id)
    if row is None:
        raise LookupError("复核样本不存在")
    if row.status != "confirmed":
        raise ValueError("仅人工确认的样本可以进入候选评测集")
    if row.candidate_dataset_id:
        dataset = await db.get(EvaluationDataset, row.candidate_dataset_id)
        return {"dataset_id": dataset.id, "status": dataset.status, "version": dataset.version}
    if dataset_kind not in {"intent-routing", "action-changeset"}:
        raise ValueError("未知候选评测集类型")
    dataset = await db.scalar(
        select(EvaluationDataset).where(
            EvaluationDataset.name == dataset_kind,
            EvaluationDataset.version == "v1.2",
        )
    )
    if dataset is None:
        dataset = EvaluationDataset(
            name=dataset_kind,
            version="v1.2",
            description="Beta 真实事件经人工确认形成的候选集；冻结前需去重、脱敏和版本审阅。",
            source_type="confirmed-beta-review",
            split="candidate",
            status="candidate",
            case_count=0,
            content_hash=canonical_hash([]),
            created_by=reviewer_id,
        )
        db.add(dataset)
        await db.flush()
    case = EvaluationCase(
        dataset_id=dataset.id,
        case_key=f"beta-{row.id}",
        category=row.sample_type,
        input_context=row.structured_context,
        expected_output={"reviewer_note": row.reviewer_note or "confirmed"},
        reference_evidence={"source_kind": row.source_kind, "source_id": row.source_id},
        safety_expectations={},
        label_source="confirmed-human-beta-review",
        label_confidence=1.0,
    )
    db.add(case)
    await db.flush()
    dataset.case_count += 1
    hashes = list(
        (
            await db.execute(
                select(EvaluationCase.case_key).where(EvaluationCase.dataset_id == dataset.id)
            )
        ).scalars()
    )
    dataset.content_hash = canonical_hash(sorted(hashes))
    row.candidate_dataset_id = dataset.id
    await db.commit()
    return {"dataset_id": dataset.id, "status": dataset.status, "version": dataset.version}


def _rate(numerator: int, denominator: int) -> float | None:
    if not denominator:
        return None
    if numerator < 0 or numerator > denominator:
        raise ValueError(f"无效指标口径：{numerator}/{denominator}")
    return round(numerator / denominator, 4)


def _legacy_rate(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def _percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    values = sorted(values)
    return round(values[min(len(values) - 1, int((len(values) - 1) * fraction))], 1)


async def funnel_overview_v1(
    db: AsyncSession,
    *,
    start: datetime | None = None,
    end: datetime | None = None,
    beta_only: bool = False,
    capability: str | None = None,
    resolution_quality: str | None = None,
) -> dict[str, Any]:
    run_query = select(AgentRun)
    event_query = select(LearningEvent).where(
        LearningEvent.event_type.in_({
            "ConversationTurnReceived", "NeedFrameResolved", "ClarificationRequested", "IntentResolved"
        })
    )
    if start:
        run_query = run_query.where(AgentRun.created_at >= start)
        event_query = event_query.where(LearningEvent.created_at >= start)
    if end:
        run_query = run_query.where(AgentRun.created_at < end)
        event_query = event_query.where(LearningEvent.created_at < end)
    runs = list((await db.execute(run_query)).scalars())
    turn_events = list((await db.execute(event_query)).scalars())

    def run_matches(run: AgentRun) -> bool:
        trace = run.trace_context or {}
        if beta_only and (trace.get("beta") or {}).get("cohort") != "beta":
            return False
        if capability and (run.objective or {}).get("capability") != capability and trace.get("capability") != capability:
            return False
        return not resolution_quality or trace.get("resolution_quality") == resolution_quality

    runs = [row for row in runs if run_matches(row)]
    def event_matches(event: LearningEvent) -> bool:
        frame = event.payload.get("need_frame") or {}
        if capability and frame.get("action_intent", {}).get("capability") != capability:
            return False
        return not resolution_quality or frame.get("resolution_quality") == resolution_quality

    turn_events = [row for row in turn_events if event_matches(row)]
    if beta_only:
        turn_events = [row for row in turn_events if (row.payload.get("beta") or {}).get("cohort") == "beta"]
    run_ids = [row.id for row in runs]
    approvals = list((await db.execute(select(AgentApproval).where(AgentApproval.run_id.in_(run_ids)))).scalars()) if run_ids else []
    audits = list((await db.execute(select(AgentAuditEvent).where(AgentAuditEvent.run_id.in_(run_ids)))).scalars()) if run_ids else []
    audit_types = [row.event_type for row in audits]
    proposal_query = select(DecisionProposal).where(
        DecisionProposal.proposal_type.notin_({"GOAL_PLAN_CREATE", "CHECKIN_RECORD"})
    )
    feedback_query = select(AgentFeedbackEvent).where(
        AgentFeedbackEvent.feedback_type == "completion_rate_7d"
    )
    if start:
        proposal_query = proposal_query.where(DecisionProposal.created_at >= start)
        feedback_query = feedback_query.where(AgentFeedbackEvent.occurred_at >= start)
    if end:
        proposal_query = proposal_query.where(DecisionProposal.created_at < end)
        feedback_query = feedback_query.where(AgentFeedbackEvent.occurred_at < end)
    proposals = list((await db.execute(proposal_query)).scalars())
    proposal_ids = [row.id for row in proposals]
    converted = set(
        (
            await db.execute(
                select(InsightActionRun.insight_id).where(InsightActionRun.insight_id.in_(proposal_ids))
            )
        ).scalars()
    ) if proposal_ids else set()
    outcomes_7d = len(list((await db.execute(feedback_query)).scalars()))
    counts = {
        "conversation_turn_received": sum(row.event_type == "ConversationTurnReceived" for row in turn_events),
        "need_frame_resolved": sum(row.event_type == "NeedFrameResolved" for row in turn_events),
        "clarification_requested": sum(row.event_type == "ClarificationRequested" for row in turn_events),
        "intent_resolved": sum(row.event_type == "IntentResolved" for row in turn_events),
        "action_run_created": len(runs),
        "preview_ready": sum(row.preview_ready_at is not None for row in runs),
        "changeset_edited": audit_types.count("approval.edited"),
        "approved": sum(row.status == "approved" for row in approvals),
        "rejected": sum(row.status == "rejected" for row in approvals),
        "cancelled": audit_types.count("run.cancelled"),
        "completed": sum(row.status in {"completed", "rolled_back"} for row in runs),
        "failed": sum(row.status == "failed" for row in runs),
        "rolled_back": sum(row.status == "rolled_back" for row in runs),
        "outcome_7d": outcomes_7d,
    }
    latencies = [
        (row.preview_ready_at - row.input_received_at).total_seconds() * 1000
        for row in runs
        if row.preview_ready_at and row.input_received_at
    ]
    decided = counts["approved"] + counts["rejected"] + counts["cancelled"]
    net_success = counts["completed"] - counts["rolled_back"]
    control = await ensure_control(db)
    safety = {key: int((control.safety_snapshot or {}).get(key) or 0) for key in HARD_SAFETY_KEYS}
    need_distribution: dict[str, int] = {}
    quality_distribution: dict[str, int] = {}
    for event in turn_events:
        frame = event.payload.get("need_frame") or {}
        need = frame.get("core_need")
        quality = frame.get("resolution_quality")
        if need:
            need_distribution[str(need)] = need_distribution.get(str(need), 0) + 1
        if quality:
            quality_distribution[str(quality)] = quality_distribution.get(str(quality), 0) + 1
    return {
        "metric_version": METRIC_VERSION_V1,
        "filters": {"beta_only": beta_only, "capability": capability, "resolution_quality": resolution_quality},
        "sample_size": counts["conversation_turn_received"],
        "insufficient_data": counts["conversation_turn_received"] < 30,
        "counts": counts,
        "rates": {
            "routing_rate": _legacy_rate(counts["action_run_created"], counts["conversation_turn_received"]),
            "clarification_rate": _legacy_rate(counts["clarification_requested"], counts["conversation_turn_received"]),
            "clarification_completion_rate": _legacy_rate(counts["intent_resolved"], counts["clarification_requested"]),
            "preview_edit_rate": _legacy_rate(counts["changeset_edited"], counts["preview_ready"]),
            "approval_rate": _legacy_rate(counts["approved"], decided),
            "execution_success_rate": _legacy_rate(net_success, counts["approved"]),
            "undo_rate": _legacy_rate(counts["rolled_back"], counts["completed"]),
            "insight_conversion_rate": _legacy_rate(len(converted), len(proposals)),
            "rejection_rate": _legacy_rate(counts["rejected"], decided),
            "cancellation_rate": _legacy_rate(counts["cancelled"], decided),
        },
        "distributions": {
            "core_need": need_distribution,
            "resolution_quality": quality_distribution,
        },
        "latency": {"preview_p50_ms": _percentile(latencies, 0.5), "preview_p95_ms": _percentile(latencies, 0.95)},
        "safety": safety,
        "expansion_blocked": not _hard_safety_clear(safety),
    }


def _action_intent(value: dict[str, Any]) -> dict[str, Any]:
    frame = value.get("need_frame") or {}
    return (
        frame.get("action_intent")
        or value.get("action_intent")
        or (value.get("trace_context") or {}).get("action_intent")
        or {}
    )


def _capability_and_quality(value: dict[str, Any]) -> tuple[str | None, str | None]:
    intent = _action_intent(value)
    return intent.get("capability"), intent.get("resolution_quality")


def _run_source(run: AgentRun) -> str:
    trace = run.trace_context or {}
    explicit = trace.get("source")
    if run.insight_id or explicit in {"learning_insight", "insight"}:
        return "insight"
    if run.run_kind in {"suggestion", "scheduler"} or explicit == "scheduler":
        return "scheduler"
    if run.run_kind in {"internal", "system"} or explicit == "internal":
        return "internal"
    if explicit == "api":
        return "api"
    if run.conversation_turn_id and run.run_kind == "user":
        return "conversation"
    return "legacy_unattributed"


def _cohort_matches(actual: str | None, requested: str) -> bool:
    return requested == "all" or actual == requested


def _metric(
    numerator: int,
    denominator: int,
) -> dict[str, int | float | None]:
    return {
        "numerator": numerator,
        "denominator": denominator,
        "value": _rate(numerator, denominator),
    }


async def funnel_overview(
    db: AsyncSession,
    *,
    start: datetime | None = None,
    end: datetime | None = None,
    beta_only: bool | None = True,
    cohort: str | None = None,
    source: str = "conversation",
    capability: str | None = None,
    resolution_quality: str | None = None,
) -> dict[str, Any]:
    """Compute v2 only from attributable, same-window persisted facts.

    v1 remains available through ``funnel_overview_v1`` for read-only history.
    """
    control = await ensure_control(db)
    requested_cohort = cohort or ("beta" if beta_only is not False else "all")
    if requested_cohort not in {"beta", "stable", "all"}:
        raise ValueError("cohort 仅支持 beta、stable 或 all")
    if source not in {
        "conversation",
        "insight",
        "scheduler",
        "api",
        "internal",
        "legacy_unattributed",
        "all",
    }:
        raise ValueError("无效 source funnel")
    measurement_start = start or control.measurement_started_at
    measurement_end = end or utc_now()
    if measurement_end <= measurement_start:
        raise ValueError("measurement end 必须晚于 start")

    turn_events = list(
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.created_at >= measurement_start,
                    LearningEvent.created_at < measurement_end,
                    LearningEvent.event_type.in_(
                        {
                            "ConversationTurnReceived",
                            "NeedFrameResolved",
                            "ClarificationRequested",
                            "IntentResolved",
                        }
                    ),
                )
            )
        ).scalars()
    )
    events_by_turn: dict[str, list[LearningEvent]] = {}
    for event in turn_events:
        events_by_turn.setdefault(event.aggregate_id, []).append(event)

    valid_turns: dict[str, dict[str, Any]] = {}
    for turn_id, events in events_by_turn.items():
        received = next(
            (item for item in events if item.event_type == "ConversationTurnReceived"), None
        )
        if received is None:
            continue
        event_cohort = (received.payload.get("beta") or {}).get("cohort")
        if not _cohort_matches(event_cohort, requested_cohort):
            continue
        frames = [
            item
            for item in events
            if item.event_type
            in {"NeedFrameResolved", "ClarificationRequested", "IntentResolved"}
        ]
        capability_value: str | None = None
        quality_value: str | None = None
        for frame_event in reversed(frames):
            capability_value, quality_value = _capability_and_quality(frame_event.payload or {})
            if capability_value or quality_value:
                break
        if capability and capability_value != capability:
            continue
        if resolution_quality and quality_value != resolution_quality:
            continue
        valid_turns[turn_id] = {
            "cohort": event_cohort,
            "capability": capability_value,
            "resolution_quality": quality_value,
            "events": events,
        }

    all_runs = list(
        (
            await db.execute(
                select(AgentRun).where(
                    AgentRun.created_at >= measurement_start,
                    AgentRun.created_at < measurement_end,
                )
            )
        ).scalars()
    )

    source_funnel = {
        key: 0
        for key in (
            "conversation",
            "insight",
            "scheduler",
            "api",
            "internal",
            "legacy_unattributed",
        )
    }
    eligible_runs: list[AgentRun] = []
    for run in all_runs:
        run_source = _run_source(run)
        run_cohort = ((run.trace_context or {}).get("beta") or {}).get("cohort")
        if not _cohort_matches(run_cohort, requested_cohort):
            continue
        source_funnel[run_source] += 1
        if source != "all" and run_source != source:
            continue
        run_capability, run_quality = _capability_and_quality(run.trace_context or {})
        if capability and run_capability != capability:
            continue
        if resolution_quality and run_quality != resolution_quality:
            continue
        eligible_runs.append(run)

    if source == "conversation":
        selected_runs = [
            run
            for run in eligible_runs
            if run.conversation_turn_id in valid_turns
        ]
    else:
        selected_runs = eligible_runs
    run_ids = {run.id for run in selected_runs}
    routed_turn_ids = {
        str(run.conversation_turn_id)
        for run in selected_runs
        if run.conversation_turn_id in valid_turns
    }

    approvals = (
        list(
            (
                await db.execute(
                    select(AgentApproval).where(AgentApproval.run_id.in_(run_ids))
                )
            ).scalars()
        )
        if run_ids
        else []
    )
    audits = (
        list(
            (
                await db.execute(
                    select(AgentAuditEvent).where(AgentAuditEvent.run_id.in_(run_ids))
                )
            ).scalars()
        )
        if run_ids
        else []
    )
    approved_runs = {row.run_id for row in approvals if row.status == "approved"}
    rejected_runs = {row.run_id for row in approvals if row.status == "rejected"}
    cancelled_runs = {
        row.run_id for row in audits if row.event_type in {"run.cancelled", "approval.cancelled"}
    }
    edited_runs = {row.run_id for row in audits if row.event_type == "approval.edited"}
    completed_runs = {run.id for run in selected_runs if run.status == "completed"}
    failed_runs = {run.id for run in selected_runs if run.status == "failed"}
    rolled_back_runs = {run.id for run in selected_runs if run.status == "rolled_back"}
    preview_runs = {run.id for run in selected_runs if run.preview_ready_at is not None}
    decision_runs = approved_runs | rejected_runs | cancelled_runs

    clarification_turns = {
        event.aggregate_id
        for event in turn_events
        if event.event_type == "ClarificationRequested" and event.aggregate_id in valid_turns
    }
    completed_clarifications = {
        str((event.payload or {}).get("continued_from_turn_id"))
        for event in turn_events
        if event.event_type == "IntentResolved"
        and (event.payload or {}).get("continued_from_turn_id") in clarification_turns
        and _cohort_matches(
            ((event.payload or {}).get("beta") or {}).get("cohort"), requested_cohort
        )
    }

    feedback = (
        list(
            (
                await db.execute(
                    select(AgentFeedbackEvent).where(
                        AgentFeedbackEvent.run_id.in_(run_ids),
                        AgentFeedbackEvent.feedback_type == "completion_rate_7d",
                        AgentFeedbackEvent.occurred_at >= measurement_start,
                        AgentFeedbackEvent.occurred_at < measurement_end,
                    )
                )
            ).scalars()
        )
        if run_ids
        else []
    )
    outcome_run_ids = {row.run_id for row in feedback if row.run_id in completed_runs}

    proposal_query = select(DecisionProposal).where(
        DecisionProposal.created_at >= measurement_start,
        DecisionProposal.created_at < measurement_end,
        DecisionProposal.proposal_type.notin_({"GOAL_PLAN_CREATE", "CHECKIN_RECORD"}),
    )
    proposals = list((await db.execute(proposal_query)).scalars())
    proposals = [
        proposal
        for proposal in proposals
        if _cohort_matches(
            ((proposal.agent_trace or {}).get("beta") or {}).get("cohort"),
            requested_cohort,
        )
    ]
    proposal_ids = {row.id for row in proposals}
    insight_links = (
        list(
            (
                await db.execute(
                    select(InsightActionRun).where(
                        InsightActionRun.insight_id.in_(proposal_ids)
                    )
                )
            ).scalars()
        )
        if proposal_ids
        else []
    )
    converted_insights = {
        link.insight_id
        for link in insight_links
        if link.run_id in {
            run.id
            for run in all_runs
            if _cohort_matches(
                ((run.trace_context or {}).get("beta") or {}).get("cohort"),
                requested_cohort,
            )
        }
    }

    latencies = [
        (run.preview_ready_at - run.input_received_at).total_seconds() * 1000
        for run in selected_runs
        if run.preview_ready_at and run.input_received_at
    ]
    routing_denominator = len(valid_turns) if source == "conversation" else 0
    routing_numerator = len(routed_turn_ids) if source == "conversation" else 0
    counts = {
        "conversation_turn_received": len(valid_turns),
        "need_frame_resolved": sum(
            any(event.event_type == "NeedFrameResolved" for event in row["events"])
            for row in valid_turns.values()
        ),
        "clarification_requested": len(clarification_turns),
        "clarification_completed": len(completed_clarifications),
        "intent_resolved": sum(
            any(event.event_type == "IntentResolved" for event in row["events"])
            for row in valid_turns.values()
        ),
        "routed_conversations": routing_numerator,
        "action_run_created": len(selected_runs),
        "preview_ready": len(preview_runs),
        "changeset_edited": len(edited_runs),
        "approved": len(approved_runs),
        "rejected": len(rejected_runs),
        "cancelled": len(cancelled_runs),
        "completed": len(completed_runs),
        "failed": len(failed_runs),
        "rolled_back": len(rolled_back_runs),
        "outcome_7d": len(outcome_run_ids),
        "coach_insights": len(proposal_ids),
        "converted_insights": len(converted_insights),
    }
    rate_details = {
        "routing_rate": _metric(routing_numerator, routing_denominator),
        "clarification_rate": _metric(len(clarification_turns), len(valid_turns)),
        "clarification_completion_rate": _metric(
            len(completed_clarifications), len(clarification_turns)
        ),
        "preview_edit_rate": _metric(len(edited_runs), len(preview_runs)),
        "approval_rate": _metric(len(approved_runs), len(decision_runs)),
        "rejection_rate": _metric(len(rejected_runs), len(decision_runs)),
        "cancellation_rate": _metric(len(cancelled_runs), len(decision_runs)),
        "execution_success_rate": _metric(
            len(completed_runs & approved_runs), len(approved_runs)
        ),
        "undo_rate": _metric(
            len(rolled_back_runs), len(completed_runs | rolled_back_runs)
        ),
        "insight_conversion_rate": _metric(len(converted_insights), len(proposal_ids)),
        "outcome_7d_rate": _metric(len(outcome_run_ids), len(completed_runs)),
    }
    rates = {key: value["value"] for key, value in rate_details.items()}
    for value in rates.values():
        if value is not None and not 0 <= value <= 1:
            raise AssertionError("action-beta-funnel-v2 rate 超出 0～1")

    need_distribution: dict[str, int] = {}
    quality_distribution: dict[str, int] = {}
    for turn in valid_turns.values():
        if turn["capability"]:
            need_distribution[turn["capability"]] = (
                need_distribution.get(turn["capability"], 0) + 1
            )
        if turn["resolution_quality"]:
            quality_distribution[turn["resolution_quality"]] = (
                quality_distribution.get(turn["resolution_quality"], 0) + 1
            )

    return {
        "metric_version": METRIC_VERSION,
        "measurement_start": measurement_start.isoformat(),
        "measurement_end": measurement_end.isoformat(),
        "cohort": requested_cohort,
        "source": source,
        "filters": {
            "capability": capability,
            "resolution_quality": resolution_quality,
        },
        "sample_size": routing_denominator if source == "conversation" else len(selected_runs),
        "insufficient_data": (
            routing_denominator if source == "conversation" else len(selected_runs)
        )
        < 30,
        "counts": counts,
        "rates": rates,
        "rate_details": rate_details,
        "source_funnel": source_funnel,
        "distributions": {
            "core_need": need_distribution,
            "resolution_quality": quality_distribution,
        },
        "latency": {
            "preview_p50_ms": _percentile(latencies, 0.5),
            "preview_p95_ms": _percentile(latencies, 0.95),
        },
        "safety": dict(control.safety_snapshot or {}),
        "expansion_blocked": True,
    }


async def current_migration_head(db: AsyncSession) -> str | None:
    try:
        return await db.scalar(text("SELECT version_num FROM alembic_version LIMIT 1"))
    except Exception:
        return None


async def current_deployment_binding(db: AsyncSession) -> dict[str, Any]:
    deployment = await db.scalar(
        select(AgentDeployment)
        .where(
            AgentDeployment.status == "active",
            AgentDeployment.environment == settings.environment,
        )
        .order_by(AgentDeployment.revision.desc())
        .limit(1)
    )
    if deployment is None:
        deployment = await db.scalar(
            select(AgentDeployment)
            .where(AgentDeployment.status == "active")
            .order_by(AgentDeployment.deployed_at.desc())
            .limit(1)
        )
    dataset = await db.scalar(
        select(EvaluationDataset)
        .where(
            EvaluationDataset.name == "action-runtime-safety-v1",
            EvaluationDataset.status == "frozen",
        )
        .order_by(EvaluationDataset.created_at.desc())
        .limit(1)
    )
    migration_head = await current_migration_head(db)
    values = {
        "deployment_id": deployment.id if deployment else None,
        "deployed_revision": deployment.revision if deployment else None,
        "migration_head": migration_head,
        "dataset_hash": dataset.content_hash if dataset else None,
        "runtime_digest": runtime_code_digest(),
    }
    values["deployment_fingerprint"] = canonical_hash(values)
    return values


def runtime_code_digest() -> str:
    configured = os.environ.get("PLANPILOT_RUNTIME_DIGEST")
    if configured:
        return configured
    backend_root = Path(__file__).resolve().parents[2]
    paths = [
        *sorted((backend_root / "src/core/agent_v2").glob("*.py")),
        backend_root / "src/services/agent_v25_runtime_gate.py",
        backend_root / "src/services/evaluation_v2_service.py",
        backend_root / "src/services/beta_evidence_service.py",
        backend_root / "evals/action-runtime-safety-v1.json",
    ]
    digest = hashlib.sha256()
    for path in paths:
        digest.update(str(path.relative_to(backend_root)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _parse_time(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


async def runtime_gate_status(db: AsyncSession) -> dict[str, Any]:
    gate = await _latest_runtime_gate(db)
    binding = await current_deployment_binding(db)
    if gate is None:
        return {
            "status": "missing",
            "valid": False,
            "blockers": ["runtime_gate_missing"],
            "current_binding": binding,
        }
    proof = (gate.criteria or {}).get("deployment_binding") or {}
    metrics = gate.metrics_snapshot or {}
    violations = metrics.get("violations") or {
        "unconfirmed_write_count": metrics.get("unconfirmed_write_violations", 0),
        "cross_user_access_count": metrics.get("cross_user_write_violations", 0),
        "duplicate_write_count": metrics.get("duplicate_write_violations", 0),
        "review_binding_failure_count": metrics.get("review_binding_failures", 0),
    }
    blockers: list[str] = []
    if gate.status != "passed":
        blockers.append("runtime_gate_failed")
    if float(metrics.get("critical_safety_pass_rate") or 0) != 1.0:
        blockers.append("critical_safety_not_100_percent")
    if any(int(violations.get(key) or 0) > 0 for key in HARD_SAFETY_KEYS):
        blockers.append("runtime_gate_violations")
    expires_at = _parse_time(proof.get("expires_at"))
    if expires_at is None or expires_at <= utc_now():
        blockers.append("runtime_gate_expired")
    for key in (
        "deployment_id",
        "deployed_revision",
        "migration_head",
        "dataset_hash",
        "runtime_digest",
        "deployment_fingerprint",
    ):
        if not proof.get(key) or proof.get(key) != binding.get(key):
            blockers.append(f"runtime_gate_{key}_mismatch")
    return {
        "id": gate.id,
        "status": "valid" if not blockers else "invalid",
        "gate_status": gate.status,
        "valid": not blockers,
        "blockers": blockers,
        "critical_safety_pass_rate": metrics.get("critical_safety_pass_rate"),
        "violations": violations,
        "dataset_hash": gate.dataset_hash,
        "proof": proof,
        "current_binding": binding,
        "decided_at": gate.decided_at.isoformat(),
        "expires_at": proof.get("expires_at"),
    }


async def safety_status(db: AsyncSession, control: AgentBetaControl | None = None) -> dict[str, Any]:
    control = control or await ensure_control(db)
    snapshot = dict(control.safety_snapshot or {})
    if not snapshot or snapshot.get("status") not in {
        "unknown",
        "stale",
        "observed_clear",
        "violated",
    }:
        return {
            "status": "unknown",
            "counts": None,
            "observed_at": None,
            "expires_at": None,
            "source": None,
            "blockers": ["safety_observation_missing"],
        }
    if snapshot.get("status") == "violated":
        return {**snapshot, "blockers": ["hard_safety_violation"]}
    binding = await current_deployment_binding(db)
    expires_at = _parse_time(snapshot.get("expires_at"))
    stale_reasons: list[str] = []
    if expires_at is None or expires_at <= utc_now():
        stale_reasons.append("safety_observation_expired")
    for key in ("deployed_revision", "migration_head", "dataset_hash", "runtime_digest"):
        if not snapshot.get(key) or snapshot.get(key) != binding.get(key):
            stale_reasons.append(f"safety_{key}_mismatch")
    if stale_reasons:
        return {**snapshot, "status": "stale", "blockers": stale_reasons}
    if snapshot.get("status") == "observed_clear" and _hard_safety_clear(snapshot):
        return {**snapshot, "blockers": []}
    return {**snapshot, "status": "unknown", "blockers": ["safety_scan_incomplete"]}


async def record_safety_observation(
    db: AsyncSession,
    *,
    actor_id: str | None,
    counts: dict[str, int],
    reason: str,
    source: str,
    audit_start: datetime,
    audit_end: datetime,
) -> dict[str, Any]:
    control = await ensure_control(db)
    before = _control_dict(control)
    normalized = {key: int(counts.get(key) or 0) for key in HARD_SAFETY_KEYS}
    binding = await current_deployment_binding(db)
    gate = await _latest_runtime_gate(db)
    violated = any(value > 0 for value in normalized.values())
    observed_at = utc_now()
    snapshot = {
        "status": "violated" if violated else "observed_clear",
        "counts": normalized,
        "observed_at": observed_at.isoformat(),
        "expires_at": (
            observed_at + timedelta(hours=settings.beta_safety_observation_ttl_hours)
        ).isoformat(),
        "source": source,
        "source_gate_id": gate.id if gate else None,
        "audit_window": {
            "start": audit_start.isoformat(),
            "end": audit_end.isoformat(),
        },
        **binding,
        "metric_version": "action-beta-safety-v2",
    }
    control.safety_snapshot = snapshot
    if violated:
        control.new_action_runs_enabled = False
        control.paused_reason = reason
    control.updated_by = actor_id
    after = _control_dict(control)
    db.add(
        AgentBetaControlEvent(
            control_id=control.id,
            action="safety_stop" if violated else "safety_observed",
            actor_id=actor_id,
            reason=reason,
            before_state=before,
            after_state=after,
        )
    )
    await db.commit()
    return await safety_status(db, control)


async def _operation_owned_by_run_user(
    db: AsyncSession, *, user_id: str, operation: dict[str, Any]
) -> bool:
    entity = operation.get("entity")
    entity_id = operation.get("entity_id")
    if not entity_id:
        return False
    if entity == "goal":
        goal = await db.get(Goal, entity_id)
        return bool(goal and goal.user_id == user_id)
    if entity == "checkin":
        checkin = await db.get(CheckinRecord, entity_id)
        return bool(checkin and checkin.user_id == user_id)
    if entity == "task":
        owner_id = await db.scalar(
            select(Goal.user_id).join(Task, Task.goal_id == Goal.id).where(Task.id == entity_id)
        )
        if owner_id is None:
            snapshot = operation.get("after") or operation.get("before") or {}
            goal_id = snapshot.get("goal_id") if isinstance(snapshot, dict) else None
            if goal_id:
                owner_id = await db.scalar(select(Goal.user_id).where(Goal.id == goal_id))
        return owner_id == user_id
    return False


async def scan_hard_safety(
    db: AsyncSession,
    *,
    actor_id: str | None = None,
    source: str = "automatic_audit_scan",
    audit_start: datetime | None = None,
    audit_end: datetime | None = None,
) -> dict[str, Any]:
    """Derive production safety counts from durable execution and approval facts."""
    from src.core.agent_v2.orchestrator import change_hash, review_hash

    audit_end = audit_end or utc_now()
    if audit_start is None:
        control = await ensure_control(db)
        audit_start = max(
            control.measurement_started_at,
            audit_end - timedelta(hours=settings.beta_safety_scan_lookback_hours),
        )
    events = list(
        (
            await db.execute(
                select(AgentAuditEvent).where(
                    AgentAuditEvent.created_at >= audit_start,
                    AgentAuditEvent.created_at < audit_end,
                    AgentAuditEvent.event_type == "executor.completed",
                )
            )
        ).scalars()
    )
    run_ids = {event.run_id for event in events}
    runs = {
        run.id: run
        for run in (
            (
                await db.execute(select(AgentRun).where(AgentRun.id.in_(run_ids)))
            ).scalars()
            if run_ids
            else []
        )
    }
    approvals = list(
        (
            await db.execute(select(AgentApproval).where(AgentApproval.run_id.in_(run_ids)))
        ).scalars()
    ) if run_ids else []
    approvals_by_run: dict[str, list[AgentApproval]] = {}
    for approval in approvals:
        approvals_by_run.setdefault(approval.run_id, []).append(approval)

    unconfirmed = 0
    cross_user = 0
    duplicates = 0
    review_binding = 0
    event_groups: dict[tuple[str, str | None], int] = {}
    for event in events:
        key = (event.run_id, event.step_id)
        event_groups[key] = event_groups.get(key, 0) + 1
        matching = [
            row
            for row in approvals_by_run.get(event.run_id, [])
            if row.status == "approved"
            and row.decided_at is not None
            and row.decided_at <= event.created_at
            and (event.step_id is None or row.step_id == event.step_id)
        ]
        if not matching:
            unconfirmed += 1
            continue
        run = runs.get(event.run_id)
        approval = matching[-1]
        if run is not None:
            operations = (approval.change_set or {}).get("operations") or []
            for operation in operations:
                if not await _operation_owned_by_run_user(
                    db, user_id=run.user_id, operation=operation
                ):
                    cross_user += 1
                    break
    duplicates = sum(max(0, count - 1) for count in event_groups.values())
    for approval in approvals:
        if approval.status != "approved":
            continue
        change_matches = approval.change_hash == change_hash(approval.change_set or {})
        review_matches = approval.review_hash == review_hash(approval.review_snapshot or {})
        if (
            not approval.reviewed_change_hash
            or approval.reviewed_change_hash != approval.change_hash
            or not approval.review_hash
            or not change_matches
            or not review_matches
        ):
            review_binding += 1
    counts = {
        "unconfirmed_write_count": unconfirmed,
        "cross_user_access_count": cross_user,
        "duplicate_write_count": duplicates,
        "review_binding_failure_count": review_binding,
    }
    return await record_safety_observation(
        db,
        actor_id=actor_id,
        counts=counts,
        reason="硬安全审计扫描完成" if not any(counts.values()) else "硬安全审计发现违规",
        source=source,
        audit_start=audit_start,
        audit_end=audit_end,
    )


async def persist_runtime_gate_proof(
    db: AsyncSession,
    *,
    actor: str,
    validation_result: dict[str, Any],
    started_at: datetime,
    validation_gate_id: str | None = None,
) -> dict[str, Any]:
    """Import an isolated-PostgreSQL result without importing its business writes."""
    from src.services.agent_control_service import ensure_baseline
    from src.services.evaluation_v2_service import (
        AGENT_V25_GATE_CRITERIA,
        ensure_agent_v25_datasets,
        gate_to_dict,
    )

    datasets = await ensure_agent_v25_datasets(db)
    dataset = next(row for row in datasets if row.name == "action-runtime-safety-v1")
    runtime = await ensure_baseline(db)
    binding = await current_deployment_binding(db)
    validation_metrics = dict(validation_result.get("metrics") or {})
    results = validation_result.get("results") or {}
    violations = {
        "unconfirmed_write_count": int(
            validation_metrics.get("unconfirmed_write_violations") or 0
        ),
        "cross_user_access_count": int(
            validation_metrics.get("cross_user_write_violations") or 0
        ),
        "duplicate_write_count": int(
            validation_metrics.get("duplicate_write_violations") or 0
        ),
        "review_binding_failure_count": int(
            not bool((results.get("expired-changeset-01") or {}).get("passed", True))
        ),
    }
    decided_at = utc_now()
    expires_at = decided_at + timedelta(hours=settings.beta_runtime_gate_ttl_hours)
    proof = {
        **binding,
        "proof_version": "runtime-deployment-proof-v1",
        "validation_gate_id": validation_gate_id,
        "started_at": started_at.isoformat(),
        "decided_at": decided_at.isoformat(),
        "expires_at": expires_at.isoformat(),
        "evaluator_version": "agent-v25-postgresql-v1",
        "runtime_version": "action-runtime-v2.5.1",
    }
    passed = bool(
        validation_result.get("status") == "passed"
        and float(validation_metrics.get("critical_safety_pass_rate") or 0) == 1.0
        and all(value == 0 for value in violations.values())
        and dataset.content_hash == validation_result.get("dataset_hash", dataset.content_hash)
        and all(
            binding.get(key) is not None
            for key in ("deployment_id", "migration_head", "runtime_digest")
        )
    )
    run = EvaluationRun(
        dataset_id=dataset.id,
        prompt_version_id=runtime.prompt.id,
        model_config_id=runtime.model.id,
        policy_version_id=runtime.policy.id,
        status="completed",
        seed=42,
        summary_metrics={**validation_metrics, "violations": violations},
        created_by=actor,
        started_at=started_at,
        finished_at=decided_at,
    )
    db.add(run)
    await db.flush()
    gate = OfflineEvaluationGate(
        evaluation_run_id=run.id,
        status="passed" if passed else "failed",
        criteria_version="agent-v25-runtime-safety-gate-v1",
        criteria={**AGENT_V25_GATE_CRITERIA, "deployment_binding": proof},
        metrics_snapshot={**validation_metrics, "violations": violations},
        failures=list(validation_result.get("failures") or []),
        dataset_hash=dataset.content_hash,
        decided_by=actor,
        decided_at=decided_at,
    )
    db.add(gate)
    await db.commit()
    return gate_to_dict(gate, run)


async def beta_overview(db: AsyncSession) -> dict[str, Any]:
    control = await ensure_control(db)
    metrics = await funnel_overview(db, beta_only=True, source="conversation")
    pending = await db.scalar(
        select(AgentBetaReviewSample.id).where(AgentBetaReviewSample.status == "pending").limit(1)
    )
    gate = await runtime_gate_status(db)
    safety = await safety_status(db, control)
    metrics["safety"] = safety
    metrics["expansion_blocked"] = not (gate["valid"] and safety["status"] == "observed_clear")
    return {
        "control": _control_dict(control),
        "metrics": metrics,
        "review_queue_has_pending": pending is not None,
        "runtime_gate": gate,
        "safety": safety,
        "evidence_state": "infrastructure_ready_no_beta_conclusion",
    }
