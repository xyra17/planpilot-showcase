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
    AgentRun,
    AgentStep,
    AgentTraceSpan,
    DecisionProposal,
    InsightActionRun,
    LearningEvent,
    Task,
)

EVENT_TYPE_MAP = {
    "ProposalAccepted": "proposal_accepted",
    "ProposalRejected": "proposal_rejected",
    "ProposalApplied": "proposal_applied",
    "ProposalAdjusted": "proposal_adjusted",
    "ProposalFeedbackRecorded": "proposal_feedback",
    "InsightConverted": "insight_converted",
    "ActionApproved": "action_approved",
    "ActionApplied": "action_applied",
    "ProposalAppliedByActionRun": "action_applied",
    "ActionRejected": "action_rejected",
    "ActionCancelled": "action_cancelled",
    "ActionFailed": "action_failed",
    "ActionRolledBack": "action_rolled_back",
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
        run_id = str(event.correlation_id) if event.correlation_id else None
        proposal_id = str((event.payload or {}).get("insight_id") or event.aggregate_id)
        if run_id and await db.scalar(
            select(AgentFeedbackEvent.id).where(
                AgentFeedbackEvent.run_id == run_id,
                AgentFeedbackEvent.feedback_type == feedback_type,
            )
        ):
            continue
        dedupe = f"event:{event.id}:{feedback_type}:v1"
        if await db.scalar(
            select(AgentFeedbackEvent.id).where(AgentFeedbackEvent.dedupe_key == dedupe)
        ):
            continue
        invocation = await db.scalar(
            select(AgentInvocation).where(AgentInvocation.proposal_id == proposal_id)
        )
        db.add(
            AgentFeedbackEvent(
                user_id=event.user_id,
                goal_id=event.goal_id,
                agent_invocation_id=invocation.id if invocation else None,
                proposal_id=proposal_id,
                run_id=run_id,
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
    links = list(
        (
            await db.execute(
                select(InsightActionRun, DecisionProposal, AgentRun)
                .join(DecisionProposal, DecisionProposal.id == InsightActionRun.insight_id)
                .join(AgentRun, AgentRun.id == InsightActionRun.run_id)
                .where(
                    InsightActionRun.status == "applied",
                    DecisionProposal.applied_at.isnot(None),
                    DecisionProposal.applied_at <= cutoff,
                )
            )
        ).all()
    )
    created = 0
    for link, proposal, run in links:
        dedupe = f"run:{run.id}:completion_rate_{days}d:v2"
        if await db.scalar(
            select(AgentFeedbackEvent.id).where(AgentFeedbackEvent.dedupe_key == dedupe)
        ):
            continue
        apply_step = await db.scalar(
            select(AgentStep)
            .where(
                AgentStep.run_id == run.id,
                AgentStep.tool_name == "tasks.apply_changes",
                AgentStep.status == "completed",
            )
            .order_by(AgentStep.plan_version.desc())
        )
        operations = (
            list((apply_step.output_data or {}).get("undo_operations", [])) if apply_step else []
        )
        task_operations = [row for row in operations if row.get("entity") == "task"]
        task_ids = sorted(
            {str(row.get("entity_id")) for row in task_operations if row.get("entity_id")}
        )
        due_at = proposal.applied_at + timedelta(days=days)
        completion_events = (
            list(
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
            )
            if task_ids
            else []
        )
        completed_ids = {row.aggregate_id for row in completion_events}
        tasks = (
            list((await db.execute(select(Task).where(Task.id.in_(task_ids)))).scalars())
            if task_ids
            else []
        )
        completed_ids.update(
            row.id
            for row in tasks
            if row.completed_at is not None and proposal.applied_at <= row.completed_at <= due_at
        )
        completion = len(completed_ids) / len(task_ids) if task_ids else None
        baseline_completed = sum(
            row.get("field") == "status" and row.get("before") == "completed"
            for row in task_operations
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
                run_id=run.id,
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
                    "change_set_id": link.change_set_id,
                    "operation_count": len(task_operations),
                    "application_schema_version": "action-run-v2",
                },
                attribution_window=f"{days}d",
                metric_version="v2",
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
