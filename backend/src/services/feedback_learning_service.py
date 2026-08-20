"""Append-only normalized immediate and delayed Agent learning signals."""

from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.models import (
    AgentFeedbackEvent,
    AgentInvocation,
    AgentTraceSpan,
    DecisionProposal,
    LearningEvent,
    Task,
)

EVENT_TYPE_MAP = {
    "ProposalAccepted": "proposal_accepted",
    "ProposalRejected": "proposal_rejected",
    "ProposalApplied": "proposal_applied",
    "ProposalAdjusted": "proposal_adjusted",
    "ProposalFeedbackRecorded": "proposal_feedback",
}


async def normalize_learning_events(db: AsyncSession, *, limit: int = 500) -> int:
    events = list(
        (
            await db.execute(
                select(LearningEvent)
                .where(LearningEvent.event_type.in_(EVENT_TYPE_MAP))
                .order_by(LearningEvent.created_at)
                .limit(limit)
            )
        ).scalars()
    )
    created = 0
    for event in events:
        feedback_type = EVENT_TYPE_MAP[event.event_type]
        dedupe = f"event:{event.id}:{feedback_type}:v1"
        if await db.scalar(
            select(AgentFeedbackEvent.id).where(AgentFeedbackEvent.dedupe_key == dedupe)
        ):
            continue
        invocation = await db.scalar(
            select(AgentInvocation).where(AgentInvocation.proposal_id == event.aggregate_id)
        )
        db.add(
            AgentFeedbackEvent(
                user_id=event.user_id,
                goal_id=event.goal_id,
                agent_invocation_id=invocation.id if invocation else None,
                proposal_id=event.aggregate_id,
                source_event_id=event.id,
                feedback_type=feedback_type,
                value=event.payload or {},
                reason=(event.payload or {}).get("reason"),
                attribution_window="immediate",
                metric_version="v1",
                dedupe_key=dedupe,
                occurred_at=event.occurred_at,
            )
        )
        if invocation is not None:
            root_span_id = await db.scalar(
                select(AgentTraceSpan.span_id).where(
                    AgentTraceSpan.agent_invocation_id == invocation.id,
                    AgentTraceSpan.parent_span_id.is_(None),
                )
            )
            db.add(
                AgentTraceSpan(
                    trace_id=invocation.trace_id,
                    span_id=uuid.uuid4().hex[:16],
                    parent_span_id=root_span_id,
                    agent_invocation_id=invocation.id,
                    user_id=event.user_id,
                    goal_id=event.goal_id,
                    name="user_action",
                    span_kind="consumer",
                    status="ok",
                    started_at=event.occurred_at,
                    finished_at=event.occurred_at,
                    latency_ms=0,
                    attributes={"feedback_type": feedback_type},
                )
            )
        created += 1
    await db.commit()
    return created


async def compute_delayed_outcomes(db: AsyncSession, *, days: int = 7) -> int:
    cutoff = utc_now() - timedelta(days=days)
    proposals = list(
        (
            await db.execute(
                select(DecisionProposal).where(
                    DecisionProposal.status == "applied",
                    DecisionProposal.applied_at.isnot(None),
                    DecisionProposal.applied_at <= cutoff,
                )
            )
        ).scalars()
    )
    created = 0
    for proposal in proposals:
        dedupe = f"proposal:{proposal.id}:completion_rate_{days}d:v1"
        if await db.scalar(
            select(AgentFeedbackEvent.id).where(AgentFeedbackEvent.dedupe_key == dedupe)
        ):
            continue
        snapshot = proposal.application_snapshot or {}
        after_tasks = (snapshot.get("after") or {}).get("tasks") or {}
        task_ids = [str(value) for value in snapshot.get("target_task_ids") or after_tasks]
        if not task_ids:
            # Compatibility for proposals applied before application snapshots existed.
            changes = proposal.proposed_changes or {}
            task_ids = [
                str(row["task_id"])
                for row in changes.get("task_updates", [])
                if isinstance(row, dict) and row.get("task_id")
            ]
            task_ids.extend(
                str(changes[key])
                for key in ("task_id", "original_task_id")
                if changes.get(key)
            )
        due_at = proposal.applied_at + timedelta(days=days)
        completion_events = list(
            (
                await db.execute(
                    select(LearningEvent).where(
                        LearningEvent.aggregate_type == "task",
                        LearningEvent.aggregate_id.in_(task_ids),
                        LearningEvent.event_type == "TaskCompleted",
                        LearningEvent.occurred_at >= proposal.applied_at,
                        LearningEvent.occurred_at <= due_at,
                    )
                )
            ).scalars()
        ) if task_ids else []
        completed_ids = {row.aggregate_id for row in completion_events}
        tasks = (
            list((await db.execute(select(Task).where(Task.id.in_(task_ids)))).scalars())
            if task_ids
            else []
        )
        completed_ids.update(
            row.id
            for row in tasks
            if row.completed_at is not None
            and proposal.applied_at <= row.completed_at <= due_at
        )
        completion = len(completed_ids) / len(task_ids) if task_ids else None
        baseline_completed = sum(
            details.get("status") == "completed" for details in after_tasks.values()
        )
        baseline = baseline_completed / len(task_ids) if task_ids else None
        invocation = await db.scalar(
            select(AgentInvocation).where(AgentInvocation.proposal_id == proposal.id)
        )
        db.add(
            AgentFeedbackEvent(
                user_id=proposal.user_id,
                goal_id=proposal.goal_id,
                agent_invocation_id=invocation.id if invocation else None,
                proposal_id=proposal.id,
                feedback_type=f"completion_rate_{days}d",
                value={
                    "completion_rate": completion,
                    "baseline_completion_rate": baseline,
                    "completion_delta": (
                        completion - baseline
                        if completion is not None and baseline is not None
                        else None
                    ),
                    "task_count": len(task_ids),
                    "completed_task_ids": sorted(completed_ids),
                    "target_versions": {
                        task_id: details.get("version")
                        for task_id, details in after_tasks.items()
                    },
                    "application_schema_version": snapshot.get("schema_version"),
                },
                attribution_window=f"{days}d",
                metric_version="v1",
                dedupe_key=dedupe,
                occurred_at=utc_now(),
            )
        )
        created += 1
    await db.commit()
    return created


async def user_feedback_history(db: AsyncSession, user_id: str, limit: int = 50) -> list[dict]:
    rows = list(
        (
            await db.execute(
                select(AgentFeedbackEvent)
                .where(AgentFeedbackEvent.user_id == user_id)
                .order_by(AgentFeedbackEvent.occurred_at.desc())
                .limit(limit)
            )
        ).scalars()
    )
    return [
        {
            "id": row.id,
            "proposal_id": row.proposal_id,
            "feedback_type": row.feedback_type,
            "value": row.value,
            "attribution_window": row.attribution_window,
            "occurred_at": row.occurred_at.isoformat(),
        }
        for row in rows
    ]


async def feedback_learning_summary(db: AsyncSession) -> dict:
    total = int(await db.scalar(select(func.count()).select_from(AgentFeedbackEvent)) or 0)
    delayed = int(
        await db.scalar(
            select(func.count())
            .select_from(AgentFeedbackEvent)
            .where(AgentFeedbackEvent.attribution_window != "immediate")
        )
        or 0
    )
    return {"event_count": total, "delayed_outcome_count": delayed, "metric_version": "v1"}
