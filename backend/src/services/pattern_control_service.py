"""User-controlled lifecycle, correction, and audit for learner patterns."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.events.publisher import emit
from src.intelligence.decision_context import DecisionContextBuilder
from src.intelligence.event_processor import process_event
from src.models import (
    Goal,
    LearnerPattern,
    LearnerPatternAudit,
    LearnerPatternSuppression,
    LearningEvent,
    PatternEvidence,
)


class PatternControlError(ValueError):
    pass


class PatternControlNotFound(LookupError):
    pass


def _snapshot(pattern: LearnerPattern) -> dict[str, Any]:
    return {
        "status": pattern.status,
        "scope": pattern.scope,
        "goal_id": pattern.goal_id,
        "user_review_status": pattern.user_review_status,
        "user_override": pattern.user_override or {},
        "user_reviewed_at": pattern.user_reviewed_at.isoformat() if pattern.user_reviewed_at else None,
        "paused_at": pattern.paused_at.isoformat() if pattern.paused_at else None,
    }


def _public_pattern(pattern: LearnerPattern, evidence: dict[str, Any] | None = None) -> dict[str, Any]:
    override = pattern.user_override or {}
    evidence = evidence or {}
    return {
        "id": pattern.id,
        "goal_id": pattern.goal_id,
        "scope": pattern.scope,
        "pattern_type": pattern.pattern_type,
        "status": pattern.status,
        "confidence": round(pattern.confidence, 4),
        "evidence_count": pattern.evidence_count,
        "explanation": override.get("summary") or DecisionContextBuilder._explain_pattern(pattern),
        "user_review_status": pattern.user_review_status,
        "user_reviewed_at": pattern.user_reviewed_at.isoformat() if pattern.user_reviewed_at else None,
        "paused_at": pattern.paused_at.isoformat() if pattern.paused_at else None,
        "first_observed_at": pattern.first_observed_at.isoformat(),
        "last_confirmed_at": pattern.last_confirmed_at.isoformat() if pattern.last_confirmed_at else None,
        "pattern_value": pattern.pattern_value or {},
        "evidence": evidence.get("items", []),
        "evidence_summary": {
            "supporting_count": evidence.get("supporting_count", 0),
            "opposing_count": evidence.get("opposing_count", 0),
            "neutral_count": evidence.get("neutral_count", 0),
            "excluded_count": evidence.get("excluded_count", 0),
            "first_observed_at": pattern.first_observed_at.isoformat(),
            "last_observed_at": evidence.get("last_observed_at"),
        },
    }


async def list_patterns(
    db: AsyncSession, *, user_id: str, goal_id: str | None = None
) -> list[dict[str, Any]]:
    stmt = select(LearnerPattern).where(LearnerPattern.user_id == user_id)
    if goal_id:
        owned = await db.scalar(select(Goal.id).where(Goal.id == goal_id, Goal.user_id == user_id))
        if owned is None:
            raise PatternControlNotFound("goal does not exist")
        stmt = stmt.where(or_(LearnerPattern.goal_id == goal_id, LearnerPattern.goal_id.is_(None)))
    rows = list((await db.execute(stmt.order_by(LearnerPattern.updated_at.desc()))).scalars())
    evidence = await DecisionContextBuilder._load_pattern_evidence(db, rows)
    return [_public_pattern(row, evidence.get(row.id)) for row in rows]


async def list_audits(
    db: AsyncSession, *, user_id: str, pattern_id: str | None = None, limit: int = 30
) -> list[dict[str, Any]]:
    stmt = select(LearnerPatternAudit).where(LearnerPatternAudit.user_id == user_id)
    if pattern_id:
        stmt = stmt.where(LearnerPatternAudit.pattern_id == pattern_id)
    rows = list(
        (await db.execute(stmt.order_by(LearnerPatternAudit.created_at.desc()).limit(limit))).scalars()
    )
    return [
        {
            "id": row.id,
            "pattern_id": row.pattern_id,
            "action": row.action,
            "actor_type": row.actor_type,
            "reason": row.reason,
            "before_state": row.before_state,
            "after_state": row.after_state,
            "reversible": row.reversible and row.undone_at is None,
            "undone_at": row.undone_at.isoformat() if row.undone_at else None,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]


async def apply_action(
    db: AsyncSession,
    *,
    user_id: str,
    pattern_id: str,
    action: str,
    reason: str | None = None,
    summary: str | None = None,
    scope: str | None = None,
    goal_id: str | None = None,
) -> dict[str, Any]:
    pattern = await db.scalar(
        select(LearnerPattern).where(
            LearnerPattern.id == pattern_id, LearnerPattern.user_id == user_id
        )
    )
    if pattern is None:
        raise PatternControlNotFound("learning observation does not exist")
    if action not in {"confirm", "correct", "set_scope", "pause", "restore", "forget"}:
        raise PatternControlError("unsupported learning observation action")
    before = _snapshot(pattern)
    now = utc_now()
    reversible = action != "forget"

    if action == "confirm":
        pattern.user_review_status = "confirmed"
        pattern.user_reviewed_at = now
    elif action == "correct":
        normalized = (summary or "").strip()
        if len(normalized) < 2 or len(normalized) > 300:
            raise PatternControlError("corrected summary must contain 2 to 300 characters")
        pattern.user_override = {**(pattern.user_override or {}), "summary": normalized}
        pattern.user_review_status = "corrected"
        pattern.user_reviewed_at = now
    elif action == "set_scope":
        if scope not in {"user", "goal"}:
            raise PatternControlError("scope must be user or goal")
        if scope == "goal":
            if not goal_id or not await db.scalar(
                select(Goal.id).where(Goal.id == goal_id, Goal.user_id == user_id)
            ):
                raise PatternControlError("a valid owned goal is required for goal scope")
            pattern.goal_id = goal_id
        else:
            pattern.goal_id = None
        pattern.scope = scope
        pattern.user_reviewed_at = now
    elif action == "pause":
        if pattern.status == "paused":
            raise PatternControlError("learning observation is already paused")
        pattern.status = "paused"
        pattern.paused_at = now
        pattern.user_review_status = "paused"
        pattern.user_reviewed_at = now
    elif action == "restore":
        if pattern.status != "paused":
            raise PatternControlError("only paused learning observations can be restored")
        pattern.status = "active" if pattern.confidence >= 0.5 else "candidate"
        pattern.paused_at = None
        pattern.user_review_status = "restored"
        pattern.user_reviewed_at = now

    after = {"deleted": True} if action == "forget" else _snapshot(pattern)
    audit = LearnerPatternAudit(
        pattern_id=pattern.id,
        user_id=user_id,
        action=action,
        actor_type="user",
        reason=(reason or "").strip()[:500] or None,
        before_state=before if reversible else {"pattern_type": pattern.pattern_type, "scope": pattern.scope},
        after_state=after,
        reversible=reversible,
        created_at=now,
    )
    db.add(audit)
    if action == "forget":
        suppression = await db.scalar(
            select(LearnerPatternSuppression).where(
                LearnerPatternSuppression.user_id == user_id,
                LearnerPatternSuppression.pattern_type == pattern.pattern_type,
                LearnerPatternSuppression.scope == pattern.scope,
                (
                    LearnerPatternSuppression.goal_id == pattern.goal_id
                    if pattern.goal_id is not None
                    else LearnerPatternSuppression.goal_id.is_(None)
                ),
            )
        )
        if suppression is None:
            db.add(
                LearnerPatternSuppression(
                    user_id=user_id,
                    pattern_type=pattern.pattern_type,
                    scope=pattern.scope,
                    goal_id=pattern.goal_id,
                    reason=(reason or "user_requested_forget").strip()[:500],
                    created_at=now,
                )
            )
        await db.delete(pattern)
        await db.commit()
        return {"pattern_id": pattern_id, "deleted": True, "audit_id": audit.id}
    await db.commit()
    await db.refresh(pattern)
    return {"pattern": _public_pattern(pattern), "audit_id": audit.id, "deleted": False}


async def record_delay_attribution(
    db: AsyncSession,
    *,
    user_id: str,
    pattern_id: str,
    evidence_id: str,
    reason_code: str,
    note: str | None = None,
) -> dict[str, Any]:
    """Record a user correction for one concrete overdue observation.

    The overdue event remains immutable. The attribution event only changes whether
    that observation participates in the adjusted delay-pattern projection.
    """
    allowed_reasons = {
        "business_trip",
        "illness_or_care",
        "temporary_capacity",
        "other_external",
        "unexplained",
    }
    if reason_code not in allowed_reasons:
        raise PatternControlError("unsupported delay attribution reason")
    pattern = await db.scalar(
        select(LearnerPattern).where(
            LearnerPattern.id == pattern_id,
            LearnerPattern.user_id == user_id,
            LearnerPattern.pattern_type == "delay_pattern",
        )
    )
    if pattern is None:
        raise PatternControlNotFound("延期观察不存在")
    evidence = await db.scalar(
        select(PatternEvidence).where(
            PatternEvidence.id == evidence_id,
            PatternEvidence.pattern_id == pattern_id,
        )
    )
    if evidence is None or evidence.learning_event_id is None:
        raise PatternControlNotFound("延期证据不存在")
    source_event = await db.get(LearningEvent, evidence.learning_event_id)
    if source_event is None or source_event.event_type != "TaskCompleted":
        raise PatternControlError("只能纠正具体的任务延期记录")
    payload = source_event.payload or {}
    if int(payload.get("days_overdue") or 0) <= 0:
        raise PatternControlError("按时完成记录不能标记为延期中断")

    attribution = "external_interruption" if reason_code != "unexplained" else "unexplained"
    now = utc_now()
    before_confidence = pattern.confidence
    before_pattern_value = pattern.pattern_value or {}
    event = await emit(
        db,
        user_id=user_id,
        goal_id=source_event.goal_id,
        aggregate_type="task",
        aggregate_id=source_event.aggregate_id,
        event_type="DelayAttributionRecorded",
        payload={
            "target_event_id": source_event.id,
            "target_evidence_id": evidence.id,
            "task_id": source_event.aggregate_id,
            "task_title": payload.get("title"),
            "days_overdue": payload.get("days_overdue"),
            "attribution": attribution,
            "reason_code": reason_code,
            "note": (note or "").strip()[:500] or None,
        },
        occurred_at=now,
    )
    await db.flush()
    await process_event(db, event)
    pattern.user_review_status = "corrected"
    pattern.user_reviewed_at = now
    audit = LearnerPatternAudit(
        pattern_id=pattern.id,
        user_id=user_id,
        action="correct_evidence",
        actor_type="user",
        reason=(note or reason_code).strip()[:500],
        before_state={
            "confidence": before_confidence,
            "pattern_value": before_pattern_value,
            "evidence_id": evidence.id,
        },
        after_state={
            "attribution": attribution,
            "reason_code": reason_code,
            "evidence_id": evidence.id,
        },
        reversible=False,
        created_at=now,
    )
    db.add(audit)
    await db.commit()
    await db.refresh(pattern)
    evidence_summary = await DecisionContextBuilder._load_pattern_evidence(db, [pattern])
    return {
        "pattern": _public_pattern(pattern, evidence_summary.get(pattern.id)),
        "audit_id": audit.id,
        "evidence_id": evidence.id,
        "attribution": attribution,
    }


async def undo_action(
    db: AsyncSession, *, user_id: str, audit_id: str
) -> dict[str, Any]:
    audit = await db.scalar(
        select(LearnerPatternAudit).where(
            LearnerPatternAudit.id == audit_id, LearnerPatternAudit.user_id == user_id
        )
    )
    if audit is None:
        raise PatternControlNotFound("audit entry does not exist")
    if not audit.reversible or audit.undone_at is not None:
        raise PatternControlError("this action cannot be undone")
    pattern = await db.scalar(
        select(LearnerPattern).where(
            LearnerPattern.id == audit.pattern_id, LearnerPattern.user_id == user_id
        )
    )
    if pattern is None:
        raise PatternControlNotFound("learning observation no longer exists")
    current = _snapshot(pattern)
    before = audit.before_state or {}
    pattern.status = before.get("status", pattern.status)
    pattern.scope = before.get("scope", pattern.scope)
    pattern.goal_id = before.get("goal_id")
    pattern.user_review_status = before.get("user_review_status")
    pattern.user_override = before.get("user_override") or {}
    pattern.user_reviewed_at = (
        datetime.fromisoformat(before["user_reviewed_at"])
        if before.get("user_reviewed_at") else None
    )
    pattern.paused_at = (
        datetime.fromisoformat(before["paused_at"]) if before.get("paused_at") else None
    )
    audit.undone_at = utc_now()
    db.add(
        LearnerPatternAudit(
            pattern_id=pattern.id,
            user_id=user_id,
            action="undo",
            actor_type="user",
            reason=f"undo:{audit.id}",
            before_state=current,
            after_state=_snapshot(pattern),
            reversible=False,
            created_at=utc_now(),
        )
    )
    await db.commit()
    await db.refresh(pattern)
    return {"pattern": _public_pattern(pattern), "undone_audit_id": audit.id}
