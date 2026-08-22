"""Learner Model, Decision Context, Proposal and Feedback APIs."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.intelligence.adaptive_planner import AdaptivePlanOptimizer
from src.models import User
from src.services import (
    core_experiment_service,
    feedback_service,
    learner_service,
    pattern_control_service,
    privacy_service,
    proposal_service,
)
from src.services.feedback_service import FeedbackCreate
from src.services.proposal_service import ProposalAdjustment, ProposalReject

router = APIRouter(prefix="/api/v1/learner", tags=["learner"])


class GoalScopeBody(BaseModel):
    goal_id: str | None = None


class PatternActionBody(BaseModel):
    action: Literal["confirm", "correct", "set_scope", "pause", "restore", "forget"]
    reason: str | None = None
    summary: str | None = None
    scope: Literal["user", "goal"] | None = None
    goal_id: str | None = None


async def _require_personalization(db: AsyncSession, user_id: str) -> None:
    if not await privacy_service.personalization_allowed(db, user_id):
        raise HTTPException(403, "个性化学习已关闭；可在隐私设置中重新启用")


@router.post("/profile/rebuild")
async def rebuild_profile(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _require_personalization(db, current_user.id)
    return await learner_service.rebuild_profile(current_user.id, db)


@router.get("/profile")
async def get_profile(
    goal_id: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _require_personalization(db, current_user.id)
    try:
        return await learner_service.get_profile(current_user.id, db, goal_id=goal_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/cognitive-profile")
async def get_cognitive_profile(
    goal_id: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _require_personalization(db, current_user.id)
    try:
        return await learner_service.get_cognitive_profile(current_user.id, db, goal_id=goal_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/memories")
async def get_memories(
    goal_id: str | None = Query(default=None),
    query: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=12, ge=1, le=50),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _require_personalization(db, current_user.id)
    try:
        return await learner_service.get_memories(
            current_user.id, db, goal_id=goal_id, query=query, limit=limit
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/adaptive-plan/{goal_id}/assessment")
async def assess_adaptive_plan(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _require_personalization(db, current_user.id)
    try:
        return await AdaptivePlanOptimizer.assess_goal(db, current_user.id, goal_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/adaptive-plan/{goal_id}/proposal", status_code=201)
async def generate_adaptive_plan(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _require_personalization(db, current_user.id)
    try:
        return await AdaptivePlanOptimizer.generate_proposal(db, current_user.id, goal_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except proposal_service.ProposalValidation as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/decision-context")
async def get_decision_context(
    goal_id: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _require_personalization(db, current_user.id)
    try:
        return await learner_service.get_decision_context(current_user.id, db, goal_id=goal_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/validation-status")
async def get_validation_status(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    snapshot = await core_experiment_service.latest_public_snapshot(db)
    snapshot["viewer_evidence"] = await privacy_service.evidence_participation_status(
        db, user=current_user
    )
    return snapshot


@router.get("/patterns/manage")
async def list_managed_patterns(
    goal_id: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    await _require_personalization(db, current_user.id)
    try:
        return await pattern_control_service.list_patterns(
            db, user_id=current_user.id, goal_id=goal_id
        )
    except pattern_control_service.PatternControlNotFound as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/patterns/{pattern_id}/actions")
async def apply_pattern_action(
    pattern_id: str,
    body: PatternActionBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _require_personalization(db, current_user.id)
    try:
        return await pattern_control_service.apply_action(
            db,
            user_id=current_user.id,
            pattern_id=pattern_id,
            **body.model_dump(),
        )
    except pattern_control_service.PatternControlNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except pattern_control_service.PatternControlError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/pattern-audits")
async def list_pattern_audits(
    pattern_id: str | None = Query(default=None),
    limit: int = Query(default=30, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    return await pattern_control_service.list_audits(
        db, user_id=current_user.id, pattern_id=pattern_id, limit=limit
    )


@router.post("/pattern-audits/{audit_id}/undo")
async def undo_pattern_action(
    audit_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _require_personalization(db, current_user.id)
    try:
        return await pattern_control_service.undo_action(
            db, user_id=current_user.id, audit_id=audit_id
        )
    except pattern_control_service.PatternControlNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except pattern_control_service.PatternControlError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/proposals")
async def list_proposals(
    goal_id: str | None = Query(default=None),
    status: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    return await proposal_service.list_proposals(
        current_user.id, db, goal_id=goal_id, status=status
    )


@router.post("/proposals/generate")
async def generate_proposal(
    body: GoalScopeBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    await _require_personalization(db, current_user.id)
    try:
        return await proposal_service.generate_proposal(current_user.id, db, goal_id=body.goal_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except proposal_service.ProposalValidation as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/proposals/{proposal_id}/accept")
async def accept_proposal(
    proposal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _require_personalization(db, current_user.id)
    try:
        return await proposal_service.accept_proposal(current_user.id, proposal_id, db)
    except proposal_service.ProposalNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except proposal_service.ProposalConflict as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/proposals/{proposal_id}/reject")
async def reject_proposal(
    proposal_id: str,
    body: ProposalReject,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await proposal_service.reject_proposal(current_user.id, proposal_id, body.reason, db)
    except proposal_service.ProposalNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except proposal_service.ProposalConflict as exc:
        raise HTTPException(409, str(exc)) from exc


@router.patch("/proposals/{proposal_id}")
async def adjust_proposal(
    proposal_id: str,
    body: ProposalAdjustment,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _require_personalization(db, current_user.id)
    try:
        return await proposal_service.adjust_proposal(current_user.id, proposal_id, body, db)
    except proposal_service.ProposalNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except proposal_service.ProposalConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except proposal_service.ProposalValidation as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/proposals/{proposal_id}/apply")
async def apply_proposal(
    proposal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await proposal_service.apply_proposal(current_user.id, proposal_id, db)
    except proposal_service.ProposalNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except proposal_service.ProposalConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except proposal_service.ProposalValidation as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/proposals/{proposal_id}/feedback", status_code=201)
async def record_feedback(
    proposal_id: str,
    body: FeedbackCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await feedback_service.record_feedback(current_user.id, proposal_id, body, db)
    except proposal_service.ProposalNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except proposal_service.ProposalConflict as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/feedback/summary")
async def feedback_summary(
    goal_id: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return await feedback_service.get_feedback_summary(current_user.id, db, goal_id=goal_id)
