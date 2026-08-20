"""Proposal outcome feedback and closed-loop pattern accuracy metrics."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.events.publisher import emit
from src.intelligence.pattern_feedback import apply_pattern_signal
from src.models import DecisionProposal, LearnerPattern, ProposalFeedback
from src.services.proposal_service import ProposalConflict, ProposalNotFound

OUTCOME_WEIGHTS = {"helpful": 1.0, "neutral": 0.5, "unhelpful": 0.0}
CONFIDENCE_CONTRIBUTIONS = {"helpful": 0.05, "neutral": 0.0, "unhelpful": -0.08}


class FeedbackCreate(BaseModel):
    outcome: Literal["helpful", "neutral", "unhelpful"]
    rating: int | None = Field(default=None, ge=1, le=5)
    comment: str | None = Field(default=None, max_length=2000)
    observed_metrics: dict[str, Any] = Field(default_factory=dict)


async def record_feedback(
    user_id: str,
    proposal_id: str,
    body: FeedbackCreate,
    db: AsyncSession,
) -> dict[str, Any]:
    proposal = (
        await db.execute(
            select(DecisionProposal).where(
                DecisionProposal.id == proposal_id,
                DecisionProposal.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if proposal is None:
        raise ProposalNotFound("proposal does not exist")
    if proposal.status != "applied":
        raise ProposalConflict("feedback can only be recorded after proposal apply")
    existing = (
        await db.execute(
            select(ProposalFeedback).where(ProposalFeedback.proposal_id == proposal_id)
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise ProposalConflict("feedback has already been recorded")

    feedback = ProposalFeedback(
        proposal_id=proposal.id,
        user_id=user_id,
        outcome=body.outcome,
        rating=body.rating,
        comment=body.comment,
        observed_metrics=body.observed_metrics,
    )
    db.add(feedback)
    event = await emit(
        db,
        user_id=user_id,
        goal_id=proposal.goal_id,
        aggregate_type="proposal",
        aggregate_id=proposal.id,
        event_type="ProposalFeedbackRecorded",
        payload={
            "outcome": body.outcome,
            "rating": body.rating,
            "proposal_type": proposal.proposal_type,
        },
    )
    await db.flush()

    contribution = CONFIDENCE_CONTRIBUTIONS[body.outcome]
    await apply_pattern_signal(
        db,
        user_id=user_id,
        pattern_ids=proposal.evidence_references or [],
        event=event,
        contribution=contribution,
        source="proposal_feedback",
        meta={"proposal_id": proposal.id, "outcome": body.outcome},
    )

    await db.commit()
    await db.refresh(feedback)
    return feedback_to_dict(feedback)


async def get_feedback_summary(
    user_id: str,
    db: AsyncSession,
    *,
    goal_id: str | None = None,
) -> dict[str, Any]:
    proposal_stmt = select(DecisionProposal).where(DecisionProposal.user_id == user_id)
    if goal_id:
        proposal_stmt = proposal_stmt.where(DecisionProposal.goal_id == goal_id)
    proposals = list((await db.execute(proposal_stmt)).scalars().all())
    proposal_ids = [proposal.id for proposal in proposals]
    feedback_rows = (
        list(
            (
                await db.execute(
                    select(ProposalFeedback).where(ProposalFeedback.proposal_id.in_(proposal_ids))
                )
            )
            .scalars()
            .all()
        )
        if proposal_ids
        else []
    )

    accepted = sum(proposal.status in {"accepted", "applied"} for proposal in proposals)
    rejected = sum(proposal.status == "rejected" for proposal in proposals)
    applied = sum(proposal.status == "applied" for proposal in proposals)
    reviewed = accepted + rejected
    outcome_counts = {
        outcome: sum(row.outcome == outcome for row in feedback_rows) for outcome in OUTCOME_WEIGHTS
    }
    accuracy = (
        sum(OUTCOME_WEIGHTS[row.outcome] for row in feedback_rows) / len(feedback_rows)
        if feedback_rows
        else None
    )

    proposal_by_id = {proposal.id: proposal for proposal in proposals}
    pattern_scores: dict[str, list[float]] = {}
    for feedback in feedback_rows:
        proposal = proposal_by_id.get(feedback.proposal_id)
        if not proposal:
            continue
        for pattern_id in proposal.evidence_references or []:
            pattern_scores.setdefault(pattern_id, []).append(OUTCOME_WEIGHTS[feedback.outcome])
    patterns = (
        list(
            (
                await db.execute(
                    select(LearnerPattern).where(
                        LearnerPattern.id.in_(pattern_scores),
                        LearnerPattern.user_id == user_id,
                    )
                )
            )
            .scalars()
            .all()
        )
        if pattern_scores
        else []
    )
    pattern_map = {pattern.id: pattern for pattern in patterns}
    per_pattern = [
        {
            "pattern_id": pattern_id,
            "pattern_type": (
                pattern_map[pattern_id].pattern_type if pattern_id in pattern_map else "unknown"
            ),
            "accuracy": round(sum(scores) / len(scores), 4),
            "feedback_count": len(scores),
            "current_confidence": (
                round(pattern_map[pattern_id].confidence, 4) if pattern_id in pattern_map else None
            ),
        }
        for pattern_id, scores in pattern_scores.items()
    ]
    return {
        "total_proposals": len(proposals),
        "pending_count": sum(proposal.status == "pending" for proposal in proposals),
        "accepted_count": accepted,
        "rejected_count": rejected,
        "applied_count": applied,
        "accept_rate": round(accepted / reviewed, 4) if reviewed else None,
        "reject_rate": round(rejected / reviewed, 4) if reviewed else None,
        "apply_rate": round(applied / accepted, 4) if accepted else None,
        "feedback_count": len(feedback_rows),
        "outcomes": outcome_counts,
        "pattern_accuracy": round(accuracy, 4) if accuracy is not None else None,
        "patterns": per_pattern,
    }


def feedback_to_dict(feedback: ProposalFeedback) -> dict[str, Any]:
    return {
        "id": feedback.id,
        "proposal_id": feedback.proposal_id,
        "outcome": feedback.outcome,
        "rating": feedback.rating,
        "comment": feedback.comment,
        "observed_metrics": feedback.observed_metrics or {},
        "created_at": feedback.created_at.isoformat() if feedback.created_at else None,
    }
