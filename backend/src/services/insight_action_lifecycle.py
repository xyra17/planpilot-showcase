"""Canonical lifecycle synchronization for Learning Insight backed Action Runs."""

from __future__ import annotations

from typing import Literal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.events.publisher import emit
from src.models import (
    AgentFeedbackEvent,
    AgentRun,
    DecisionProposal,
    InsightActionRun,
)

LifecycleStatus = Literal[
    "converted",
    "action_approved",
    "applied",
    "action_rejected",
    "action_cancelled",
    "action_failed",
    "rolled_back",
]

TERMINAL_STATUSES = {
    "applied",
    "action_rejected",
    "action_cancelled",
    "action_failed",
    "rolled_back",
}

EVENT_NAMES: dict[LifecycleStatus, str] = {
    "converted": "InsightConverted",
    "action_approved": "ActionApproved",
    "applied": "ActionApplied",
    "action_rejected": "ActionRejected",
    "action_cancelled": "ActionCancelled",
    "action_failed": "ActionFailed",
    "rolled_back": "ActionRolledBack",
}

FEEDBACK_TYPES: dict[LifecycleStatus, str] = {
    "converted": "insight_converted",
    "action_approved": "action_approved",
    "applied": "action_applied",
    "action_rejected": "action_rejected",
    "action_cancelled": "action_cancelled",
    "action_failed": "action_failed",
    "rolled_back": "action_rolled_back",
}


async def active_link(
    db: AsyncSession, insight_id: str, *, lock: bool = False
) -> InsightActionRun | None:
    stmt = select(InsightActionRun).where(
        InsightActionRun.insight_id == insight_id,
        InsightActionRun.is_active.is_(True),
    )
    if lock:
        stmt = stmt.with_for_update()
    return await db.scalar(stmt)


async def next_attempt_number(db: AsyncSession, insight_id: str) -> int:
    value = await db.scalar(
        select(func.max(InsightActionRun.attempt_number)).where(
            InsightActionRun.insight_id == insight_id
        )
    )
    return int(value or 0) + 1


async def _record_feedback(
    db: AsyncSession,
    *,
    proposal: DecisionProposal,
    run: AgentRun,
    lifecycle: LifecycleStatus,
) -> None:
    dedupe = f"agent-v25:{run.id}:{lifecycle}"
    if await db.scalar(
        select(AgentFeedbackEvent.id).where(AgentFeedbackEvent.dedupe_key == dedupe)
    ):
        return
    db.add(
        AgentFeedbackEvent(
            user_id=proposal.user_id,
            goal_id=proposal.goal_id,
            proposal_id=proposal.id,
            run_id=run.id,
            feedback_type=FEEDBACK_TYPES[lifecycle],
            value={"lifecycle": lifecycle, "run_status": run.status},
            attribution_window="immediate",
            metric_version="agent-feedback-v2",
            dedupe_key=dedupe,
            occurred_at=utc_now(),
        )
    )


async def sync_run_lifecycle(
    db: AsyncSession,
    *,
    run: AgentRun,
    lifecycle: LifecycleStatus,
    approval_id: str | None = None,
    change_set_id: str | None = None,
    detail: dict | None = None,
) -> InsightActionRun | None:
    link = await db.scalar(
        select(InsightActionRun).where(InsightActionRun.run_id == run.id).with_for_update()
    )
    if link is None:
        return None
    proposal = await db.scalar(
        select(DecisionProposal).where(DecisionProposal.id == link.insight_id).with_for_update()
    )
    if proposal is None:
        return None

    now = utc_now()
    previous = link.status
    link.status = lifecycle
    link.is_active = lifecycle not in TERMINAL_STATUSES
    link.change_set_id = change_set_id or link.change_set_id
    link.approval_id = approval_id or link.approval_id
    link.history = [
        *(link.history or []),
        {
            "from": previous,
            "to": lifecycle,
            "at": now.isoformat(),
            "detail": detail or {},
        },
    ]
    proposal.lifecycle_status = lifecycle
    proposal.converted_run_id = run.id
    proposal.updated_at = now
    if lifecycle == "action_approved":
        proposal.status = "accepted"
        proposal.reviewed_at = now
    elif lifecycle == "applied":
        proposal.status = "applied"
        proposal.applied_at = now
        proposal.application_snapshot = {
            "schema_version": "action-run-v2",
            "run_id": run.id,
            "change_set_id": link.change_set_id,
            "approval_id": link.approval_id,
            "applied_at": now.isoformat(),
        }
    elif lifecycle == "rolled_back":
        proposal.status = "pending"
        proposal.applied_at = None
    elif lifecycle in {"action_rejected", "action_cancelled"}:
        proposal.status = "pending"
    elif lifecycle == "action_failed" and previous != "applied":
        proposal.status = "pending"

    await emit(
        db,
        user_id=proposal.user_id,
        goal_id=proposal.goal_id,
        aggregate_type="insight_action",
        aggregate_id=link.id,
        event_type=EVENT_NAMES[lifecycle],
        source="ai_agent"
        if lifecycle in {"converted", "applied", "action_failed"}
        else "user_action",
        correlation_id=run.id,
        idempotency_key=f"insight-action:{run.id}:{lifecycle}",
        payload={
            "insight_id": proposal.id,
            "run_id": run.id,
            "lifecycle": lifecycle,
            "change_set_id": link.change_set_id,
            "approval_id": link.approval_id,
            **(detail or {}),
        },
    )
    await _record_feedback(db, proposal=proposal, run=run, lifecycle=lifecycle)
    return link


async def mark_preview_ready(
    db: AsyncSession,
    *,
    run: AgentRun,
    change_set_id: str,
    approval_id: str,
) -> None:
    link = await db.scalar(
        select(InsightActionRun).where(InsightActionRun.run_id == run.id).with_for_update()
    )
    if link is None:
        return
    link.change_set_id = change_set_id
    link.approval_id = approval_id
    run.preview_ready_at = utc_now()
    run.trace_context = {
        **(run.trace_context or {}),
        "insight_id": link.insight_id,
        "change_set_id": change_set_id,
        "approval_id": approval_id,
    }
    proposal = await db.get(DecisionProposal, link.insight_id)
    if proposal:
        await emit(
            db,
            user_id=proposal.user_id,
            goal_id=proposal.goal_id,
            aggregate_type="insight_action",
            aggregate_id=link.id,
            event_type="ActionPreviewReady",
            source="ai_agent",
            correlation_id=run.id,
            idempotency_key=f"insight-action:{run.id}:preview:{change_set_id}",
            payload={
                "insight_id": link.insight_id,
                "run_id": run.id,
                "change_set_id": change_set_id,
                "approval_id": approval_id,
            },
        )


async def reactivate_failed_run(db: AsyncSession, *, run: AgentRun) -> None:
    link = await db.scalar(
        select(InsightActionRun).where(InsightActionRun.run_id == run.id).with_for_update()
    )
    if link is None:
        return
    other = await active_link(db, link.insight_id, lock=True)
    if other and other.run_id != run.id:
        raise HTTPException(409, "该学习洞察已经有另一个活跃行动方案")
    proposal = await db.scalar(
        select(DecisionProposal).where(DecisionProposal.id == link.insight_id).with_for_update()
    )
    if proposal and proposal.status == "applied":
        raise HTTPException(409, "已应用的学习洞察不能重试旧行动")
    now = utc_now()
    link.is_active = True
    link.status = "converted"
    link.history = [
        *(link.history or []),
        {
            "from": "action_failed",
            "to": "converted",
            "at": now.isoformat(),
            "detail": {"retry": True},
        },
    ]
    if proposal:
        proposal.lifecycle_status = "converted"
        proposal.status = "pending"
        proposal.updated_at = now
