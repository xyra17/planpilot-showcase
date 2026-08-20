"""Normalize real canary exposure, decision and delayed outcome facts."""

from __future__ import annotations

from collections import Counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import (
    AgentFeedbackEvent,
    AgentInvocation,
    CanaryObservation,
    CanaryRelease,
    ExperimentAssignment,
    ExperimentExposure,
)


async def normalize_canary_observations(db: AsyncSession) -> int:
    created = 0
    exposures = list(
        (
            await db.execute(
                select(ExperimentExposure, ExperimentAssignment, AgentInvocation, CanaryRelease)
                .join(
                    ExperimentAssignment,
                    ExperimentExposure.assignment_id == ExperimentAssignment.id,
                )
                .join(AgentInvocation, ExperimentExposure.agent_invocation_id == AgentInvocation.id)
                .join(
                    CanaryRelease, CanaryRelease.experiment_id == ExperimentAssignment.experiment_id
                )
            )
        ).all()
    )
    for exposure, assignment, invocation, release in exposures:
        dedupe = f"canary:exposure:{exposure.id}:v1"
        if await db.scalar(
            select(CanaryObservation.id).where(CanaryObservation.dedupe_key == dedupe)
        ):
            continue
        db.add(
            CanaryObservation(
                canary_release_id=release.id,
                experiment_id=release.experiment_id,
                variant_id=assignment.variant_id,
                user_id=invocation.user_id,
                agent_invocation_id=invocation.id,
                proposal_id=invocation.proposal_id,
                observation_type="exposure",
                metric_name="agent_invocation",
                metric_value={
                    "success": invocation.success,
                    "fallback": invocation.fallback,
                    "latency_ms": invocation.latency_ms,
                    "total_tokens": invocation.total_tokens,
                    "estimated_cost": invocation.estimated_cost,
                },
                attribution_window="immediate",
                dedupe_key=dedupe,
                occurred_at=exposure.exposed_at,
            )
        )
        created += 1
    feedback_rows = list(
        (
            await db.execute(
                select(AgentFeedbackEvent, AgentInvocation, CanaryRelease)
                .join(AgentInvocation, AgentFeedbackEvent.agent_invocation_id == AgentInvocation.id)
                .join(CanaryRelease, CanaryRelease.experiment_id == AgentInvocation.experiment_id)
                .where(AgentInvocation.variant_id.isnot(None))
            )
        ).all()
    )
    for feedback, invocation, release in feedback_rows:
        dedupe = f"canary:feedback:{feedback.id}:v1"
        if await db.scalar(
            select(CanaryObservation.id).where(CanaryObservation.dedupe_key == dedupe)
        ):
            continue
        delayed = feedback.attribution_window != "immediate"
        db.add(
            CanaryObservation(
                canary_release_id=release.id,
                experiment_id=release.experiment_id,
                variant_id=invocation.variant_id,
                user_id=feedback.user_id,
                agent_invocation_id=invocation.id,
                proposal_id=feedback.proposal_id,
                observation_type="outcome" if delayed else "decision",
                metric_name=feedback.feedback_type,
                metric_value=feedback.value or {},
                attribution_window=feedback.attribution_window,
                dedupe_key=dedupe,
                occurred_at=feedback.occurred_at,
            )
        )
        created += 1
    await db.commit()
    return created


async def observation_summary(db: AsyncSession, release_id: str) -> dict[str, Any]:
    rows = list(
        (
            await db.execute(
                select(CanaryObservation).where(CanaryObservation.canary_release_id == release_id)
            )
        ).scalars()
    )
    counts = Counter(row.observation_type for row in rows)
    outcomes = [
        float(row.metric_value["completion_rate"])
        for row in rows
        if row.observation_type == "outcome" and row.metric_value.get("completion_rate") is not None
    ]
    return {
        "total": len(rows),
        "exposures": counts["exposure"],
        "decisions": counts["decision"],
        "outcomes": counts["outcome"],
        "outcome_coverage": round(counts["outcome"] / counts["exposure"], 4)
        if counts["exposure"]
        else None,
        "average_completion_after_advice": round(sum(outcomes) / len(outcomes), 4)
        if outcomes
        else None,
    }
