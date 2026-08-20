"""Application service for the Decision Proposal review/apply gateway."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.agents.coach_agent import CoachAgent
from src.core.time import utc_now
from src.events.publisher import emit
from src.intelligence.decision_context import DecisionContextBuilder
from src.intelligence.pattern_feedback import apply_pattern_signal
from src.models import (
    DecisionProposal,
    Goal,
    GoalVersion,
    LearnerPattern,
    LearningConcept,
    ProposalFeedback,
    Task,
)
from src.services import agent_control_service

ALLOWED_PROPOSAL_TYPES = {
    "reschedule_overdue_tasks",
    "reduce_daily_load",
    "learning_nudge",
    "PLAN_ADJUSTMENT",
    "TASK_SPLIT",
    "DIFFICULTY_ADJUST",
    "REVIEW_INSERTION",
}


class ProposalError(Exception):
    pass


class ProposalNotFound(ProposalError):
    pass


class ProposalConflict(ProposalError):
    pass


class ProposalValidation(ProposalError):
    pass


class ProposalCreate(BaseModel):
    goal_id: str | None = None
    proposal_type: str
    title: str = Field(min_length=1, max_length=200)
    summary: str = Field(default="", max_length=2000)
    reasoning: list[str] = Field(min_length=1, max_length=5)
    proposed_changes: dict[str, Any] = Field(default_factory=dict)
    evidence_references: list[str] = Field(default_factory=list, max_length=20)
    confidence: float = Field(ge=0.0, le=1.0)
    expires_at: datetime | None = None


class ProposalReject(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)


class ProposalAdjustment(BaseModel):
    proposed_changes: dict[str, Any]
    reason: str = Field(min_length=1, max_length=500)


async def list_proposals(
    user_id: str,
    db: AsyncSession,
    *,
    goal_id: str | None = None,
    status: str | None = None,
) -> list[dict[str, Any]]:
    stmt = select(DecisionProposal).where(DecisionProposal.user_id == user_id)
    if goal_id:
        stmt = stmt.where(DecisionProposal.goal_id == goal_id)
    if status:
        stmt = stmt.where(DecisionProposal.status == status)
    rows = (await db.execute(stmt.order_by(DecisionProposal.created_at.desc()))).scalars().all()
    proposal_ids = [row.id for row in rows]
    feedback_ids = (
        set(
            (
                await db.execute(
                    select(ProposalFeedback.proposal_id).where(
                        ProposalFeedback.proposal_id.in_(proposal_ids)
                    )
                )
            ).scalars()
        )
        if proposal_ids
        else set()
    )
    return [proposal_to_dict(row, has_feedback=row.id in feedback_ids) for row in rows]


async def create_proposal(
    user_id: str,
    body: ProposalCreate,
    db: AsyncSession,
    *,
    source: Literal["ai_agent", "user_action"] = "ai_agent",
) -> dict[str, Any]:
    proposal = await _create_no_commit(user_id, body, db, source=source)
    await db.commit()
    await db.refresh(proposal)
    return proposal_to_dict(proposal)


async def generate_proposal(
    user_id: str,
    db: AsyncSession,
    *,
    goal_id: str | None,
) -> list[dict[str, Any]]:
    runtime = await agent_control_service.resolve_runtime(
        db,
        user_id=user_id,
        agent_type="coach",
    )
    full_context = await DecisionContextBuilder.build(db, user_id, goal_id=goal_id)
    use_personalization = not (
        runtime.variant
        and (runtime.variant.treatment_config or {}).get("personalization_enabled") is False
    )
    context = (
        full_context
        if use_personalization
        else {
            **full_context,
            "profile": None,
            "cognitive_profile": None,
            "active_patterns": [],
            "memories": {},
            "knowledge_gaps": [],
            "recent_events": [],
            "data_quality": {
                "profile_event_count": 0,
                "profile_scope": "experiment_control",
                "pattern_count": 0,
                "memory_count": 0,
                "cognitive_confidence": 0.0,
                "knowledge_gap_count": 0,
                "low_confidence_fields": [],
                "level": "disabled",
            },
            "personalization": {"enabled": False, "reason": "experiment_control"},
        }
    )
    patterns = full_context["active_patterns"] if use_personalization else []
    if use_personalization and not patterns:
        return []

    goal_context = full_context.get("goal_context") or {}
    overdue = goal_context.get("overdue_tasks", [])
    profile = full_context.get("profile") or {}
    pattern_by_type = {row["pattern_type"]: row for row in patterns}
    policy_type = CoachAgent.recommend_action(full_context) if use_personalization else "learning_nudge"

    if not use_personalization:
        body = ProposalCreate(
            goal_id=goal_id,
            proposal_type="learning_nudge",
            title="保持今天的学习节奏",
            summary="根据当前目标和任务提供通用提醒；本次不使用长期学习画像。",
            reasoning=["该建议属于无个性化实验对照组，不读取行为模式或长期记忆。"],
            proposed_changes={},
            evidence_references=[],
            confidence=0.5,
            expires_at=utc_now() + timedelta(days=7),
        )
    elif policy_type == "reschedule_overdue_tasks":
        evidence = (
            pattern_by_type.get("delay_pattern")
            or pattern_by_type.get("plan_adherence")
            or patterns[0]
        )
        task_updates = [
            {
                "task_id": task["id"],
                "scheduled_date": (date.today() + timedelta(days=index + 1)).isoformat(),
            }
            for index, task in enumerate(overdue[:5])
        ]
        body = ProposalCreate(
            goal_id=goal_id,
            proposal_type="reschedule_overdue_tasks",
            title="重新安排逾期任务",
            summary=f"检测到 {len(overdue)} 个逾期任务，建议分散到接下来的学习日。",
            reasoning=[
                f"当前有 {len(overdue)} 个未完成的逾期任务。",
                f"依据 {evidence['pattern_type']}，该规律置信度为 {evidence['confidence']:.0%}。",
            ],
            proposed_changes={"task_updates": task_updates},
            evidence_references=[evidence["id"]],
            confidence=evidence["confidence"],
            expires_at=utc_now() + timedelta(days=7),
        )
    elif policy_type == "reduce_daily_load":
        evidence = pattern_by_type.get("completion_rate_trend") or patterns[0]
        current_hours = float(goal_context["goal"]["daily_hours"])
        recommended = round(max(0.5, current_hours * 0.8), 1)
        body = ProposalCreate(
            goal_id=goal_id,
            proposal_type="reduce_daily_load",
            title="降低每日计划负荷",
            summary="近期完成率偏低，先缩小每日投入目标以恢复稳定节奏。",
            reasoning=[
                f"近 30 天完成率为 {profile['completion_rate_30d']:.0%}。",
                f"依据 {evidence['pattern_type']}，该规律置信度为 {evidence['confidence']:.0%}。",
            ],
            proposed_changes={"goal_id": goal_id, "daily_hours": recommended},
            evidence_references=[evidence["id"]],
            confidence=evidence["confidence"],
            expires_at=utc_now() + timedelta(days=7),
        )
    else:
        evidence = patterns[0]
        preferred_window = CoachAgent.preferred_window(context)
        body = ProposalCreate(
            goal_id=goal_id,
            proposal_type="learning_nudge",
            title=(
                f"把重要学习安排在 {preferred_window}" if preferred_window else "保持当前学习节奏"
            ),
            summary=(
                "历史完成记录显示这个时段更适合专注任务，建议优先放置高难度内容。"
                if preferred_window
                else "当前没有需要立即修改的计划项，建议延续已形成的稳定节奏。"
            ),
            reasoning=[f"{evidence['explanation']}，置信度为 {evidence['confidence']:.0%}。"],
            proposed_changes={},
            evidence_references=[evidence["id"]],
            confidence=evidence["confidence"],
            expires_at=utc_now() + timedelta(days=7),
        )

    existing = (
        await db.execute(
            select(DecisionProposal).where(
                DecisionProposal.user_id == user_id,
                DecisionProposal.proposal_type == body.proposal_type,
                DecisionProposal.status.in_(["pending", "accepted"]),
                (
                    DecisionProposal.goal_id == goal_id
                    if goal_id is not None
                    else DecisionProposal.goal_id.is_(None)
                ),
            )
        )
    ).scalar_one_or_none()
    if existing:
        return [proposal_to_dict(existing)]

    policy_rules = runtime.policy.rules or {}
    if body.proposal_type not in policy_rules.get("allowed_proposal_types", []):
        raise ProposalValidation("当前 Agent 策略不允许生成该建议类型")
    if policy_rules.get("require_user_confirmation") is not True:
        raise ProposalValidation("当前 Agent 策略未启用强制用户确认")

    agent_result = await CoachAgent.generate(
        context,
        expected_type=body.proposal_type,
        fallback_title=body.title,
        fallback_summary=body.summary,
        fallback_reasoning=body.reasoning,
        system_template=runtime.prompt.template,
        prompt_version=runtime.prompt.version,
        model_provider=runtime.model.provider,
        model_name=runtime.model.model_name,
        temperature=runtime.model.temperature,
        max_tokens=runtime.model.max_tokens,
        timeout_ms=runtime.model.timeout_ms,
        retry_policy=runtime.model.retry_policy,
    )
    body = body.model_copy(
        update={
            "title": agent_result.title,
            "summary": agent_result.summary,
            "reasoning": agent_result.reasoning,
        }
    )
    invocation = await agent_control_service.record_invocation(
        db,
        runtime=runtime,
        user_id=user_id,
        goal_id=goal_id,
        context=context,
        output={
            "proposal_type": body.proposal_type,
            "title": body.title,
            "summary": body.summary,
            "reasoning": body.reasoning,
        },
        trace=agent_result.trace,
    )
    agent_trace = {
        **agent_result.trace,
        "invocation_id": invocation.id,
        "deployment_id": runtime.deployment.id,
        "deployment_revision": runtime.deployment.revision,
        "prompt_version_id": runtime.prompt.id,
        "model_config_id": runtime.model.id,
        "policy_version_id": runtime.policy.id,
        "experiment_id": runtime.experiment.id if runtime.experiment else None,
        "variant_id": runtime.variant.id if runtime.variant else None,
    }
    proposal = await _create_no_commit(
        user_id,
        body,
        db,
        source="ai_agent",
        model_name=agent_result.model_name or runtime.model.model_name,
        agent_trace=agent_trace,
    )
    invocation.proposal_id = proposal.id
    await db.commit()
    await db.refresh(proposal)
    return [proposal_to_dict(proposal)]


async def accept_proposal(user_id: str, proposal_id: str, db: AsyncSession) -> dict[str, Any]:
    proposal = await _get_owned_proposal(user_id, proposal_id, db)
    if proposal.status == "accepted":
        return proposal_to_dict(proposal)
    _require_status(proposal, "pending")
    _require_not_expired(proposal)
    now = utc_now()
    proposal.status = "accepted"
    proposal.reviewed_at = now
    proposal.updated_at = now
    event = await emit(
        db,
        user_id=user_id,
        goal_id=proposal.goal_id,
        aggregate_type="proposal",
        aggregate_id=proposal.id,
        event_type="ProposalAccepted",
        payload={"proposal_type": proposal.proposal_type},
    )
    await db.flush()
    await apply_pattern_signal(
        db,
        user_id=user_id,
        pattern_ids=proposal.evidence_references or [],
        event=event,
        contribution=0.01,
        source="proposal_accepted",
        meta={"proposal_id": proposal.id},
    )
    await db.commit()
    return proposal_to_dict(proposal)


async def reject_proposal(
    user_id: str,
    proposal_id: str,
    reason: str,
    db: AsyncSession,
) -> dict[str, Any]:
    proposal = await _get_owned_proposal(user_id, proposal_id, db)
    if proposal.status == "rejected":
        return proposal_to_dict(proposal)
    _require_status(proposal, "pending")
    now = utc_now()
    proposal.status = "rejected"
    proposal.rejection_reason = reason
    proposal.reviewed_at = now
    proposal.updated_at = now
    event = await emit(
        db,
        user_id=user_id,
        goal_id=proposal.goal_id,
        aggregate_type="proposal",
        aggregate_id=proposal.id,
        event_type="ProposalRejected",
        payload={"proposal_type": proposal.proposal_type, "reason": reason},
    )
    await db.flush()
    await apply_pattern_signal(
        db,
        user_id=user_id,
        pattern_ids=proposal.evidence_references or [],
        event=event,
        contribution=-0.02,
        source="proposal_rejected",
        meta={"proposal_id": proposal.id},
    )
    await db.commit()
    return proposal_to_dict(proposal)


async def adjust_proposal(
    user_id: str,
    proposal_id: str,
    body: ProposalAdjustment,
    db: AsyncSession,
) -> dict[str, Any]:
    """Let a user edit a pending proposal without bypassing the apply gateway."""
    proposal = await _get_owned_proposal(user_id, proposal_id, db)
    _require_status(proposal, "pending")
    _require_not_expired(proposal)
    if proposal.proposal_type == "reschedule_overdue_tasks":
        await _validate_task_reschedules(user_id, body.proposed_changes, db)
    elif proposal.proposal_type == "reduce_daily_load":
        await _validate_daily_load(user_id, proposal.goal_id, body.proposed_changes, db)
    elif proposal.proposal_type == "learning_nudge":
        if body.proposed_changes:
            raise ProposalValidation("learning_nudge does not support plan mutations")
    elif proposal.proposal_type in {
        "PLAN_ADJUSTMENT",
        "TASK_SPLIT",
        "DIFFICULTY_ADJUST",
        "REVIEW_INSERTION",
    }:
        await _validate_adaptive_changes(user_id, proposal, body.proposed_changes, db)
    else:
        raise ProposalValidation("unsupported proposal type")

    proposal.proposed_changes = body.proposed_changes
    proposal.reasoning = [*(proposal.reasoning or [])[:4], f"用户调整：{body.reason}"]
    proposal.updated_at = utc_now()
    await emit(
        db,
        user_id=user_id,
        goal_id=proposal.goal_id,
        aggregate_type="proposal",
        aggregate_id=proposal.id,
        event_type="ProposalAdjusted",
        source="user_action",
        payload={"proposal_type": proposal.proposal_type},
    )
    await db.commit()
    return proposal_to_dict(proposal)


async def apply_proposal(user_id: str, proposal_id: str, db: AsyncSession) -> dict[str, Any]:
    proposal = await _get_owned_proposal(user_id, proposal_id, db)
    if proposal.status == "applied":
        return proposal_to_dict(proposal)
    _require_status(proposal, "accepted")
    _require_not_expired(proposal)
    before_snapshot = await _proposal_target_snapshot(proposal, db)

    if proposal.proposal_type == "reschedule_overdue_tasks":
        await _apply_task_reschedules(user_id, proposal, db)
    elif proposal.proposal_type == "reduce_daily_load":
        await _apply_daily_load(user_id, proposal, db)
    elif proposal.proposal_type != "learning_nudge":
        if proposal.proposal_type == "PLAN_ADJUSTMENT":
            await _apply_plan_adjustment(user_id, proposal, db)
        elif proposal.proposal_type == "TASK_SPLIT":
            await _apply_task_split(user_id, proposal, db)
        elif proposal.proposal_type == "DIFFICULTY_ADJUST":
            await _apply_difficulty_adjust(user_id, proposal, db)
        elif proposal.proposal_type == "REVIEW_INSERTION":
            await _apply_review_insertion(user_id, proposal, db)
        else:
            raise ProposalValidation("unsupported proposal type")

    now = utc_now()
    created_task_ids = [row.id for row in db.new if isinstance(row, Task)]
    await db.flush()
    after_snapshot = await _proposal_target_snapshot(
        proposal, db, additional_task_ids=created_task_ids
    )
    before_goal = before_snapshot.get("goal")
    after_goal = after_snapshot.get("goal")
    if before_goal and after_goal and before_goal["version"] != after_goal["version"]:
        goal = await db.get(Goal, after_goal["id"])
        assert goal is not None
        db.add(
            GoalVersion(
                goal_id=goal.id,
                version=goal.version,
                title_snapshot=goal.title,
                objective_snapshot=goal.description,
                constraints_snapshot={
                    "deadline": goal.deadline,
                    "daily_hours": goal.daily_hours,
                    "work_schedule": goal.work_schedule,
                    "status": goal.status,
                },
                change_reason=f"proposal:{proposal.id}",
                created_by="ai",
            )
        )
    proposal.status = "applied"
    proposal.applied_at = now
    proposal.updated_at = now
    proposal.application_snapshot = {
        "schema_version": "proposal-application-v1",
        "applied_at": now.isoformat(),
        "before": before_snapshot,
        "after": after_snapshot,
        "target_task_ids": sorted(after_snapshot["tasks"]),
    }
    await emit(
        db,
        user_id=user_id,
        goal_id=proposal.goal_id,
        aggregate_type="proposal",
        aggregate_id=proposal.id,
        event_type="ProposalApplied",
        source="ai_agent",
        correlation_id=proposal.id,
        idempotency_key=f"proposal:{proposal.id}:applied",
        payload={
            "proposal_type": proposal.proposal_type,
            "target_task_ids": proposal.application_snapshot["target_task_ids"],
            "target_versions": {
                task_id: row["version"] for task_id, row in after_snapshot["tasks"].items()
            },
        },
    )
    await db.commit()
    return proposal_to_dict(proposal)


def _proposal_task_ids(proposal: DecisionProposal) -> set[str]:
    changes = proposal.proposed_changes or {}
    task_ids = {
        str(row["task_id"])
        for row in changes.get("task_updates", [])
        if isinstance(row, dict) and row.get("task_id")
    }
    for key in ("task_id", "original_task_id"):
        if changes.get(key):
            task_ids.add(str(changes[key]))
    return task_ids


async def _proposal_target_snapshot(
    proposal: DecisionProposal,
    db: AsyncSession,
    *,
    additional_task_ids: list[str] | None = None,
) -> dict[str, Any]:
    task_ids = _proposal_task_ids(proposal) | set(additional_task_ids or [])
    if task_ids:
        tasks = list((await db.execute(select(Task).where(Task.id.in_(task_ids)))).scalars())
    elif proposal.goal_id:
        tasks = list(
            (
                await db.execute(
                    select(Task).where(
                        Task.goal_id == proposal.goal_id,
                        Task.status.in_({"pending", "in_progress"}),
                    )
                )
            ).scalars()
        )
    else:
        tasks = []
    goal = await db.get(Goal, proposal.goal_id) if proposal.goal_id else None
    return {
        "goal": (
            {
                "id": goal.id,
                "version": goal.version,
                "daily_hours": goal.daily_hours,
                "status": goal.status,
            }
            if goal
            else None
        ),
        "tasks": {
            task.id: {
                "version": task.version,
                "status": task.status,
                "scheduled_date": task.scheduled_date,
                "estimated_mins": task.estimated_mins,
                "completed_at": task.completed_at.isoformat() if task.completed_at else None,
            }
            for task in tasks
        },
    }


async def _create_no_commit(
    user_id: str,
    body: ProposalCreate,
    db: AsyncSession,
    *,
    source: str,
    model_name: str | None = None,
    agent_trace: dict[str, Any] | None = None,
) -> DecisionProposal:
    if body.proposal_type not in ALLOWED_PROPOSAL_TYPES:
        raise ProposalValidation("unsupported proposal type")
    if body.goal_id:
        goal = (
            await db.execute(select(Goal).where(Goal.id == body.goal_id, Goal.user_id == user_id))
        ).scalar_one_or_none()
        if goal is None:
            raise ProposalValidation("goal does not exist")
    patterns = list(
        (
            await db.execute(
                select(LearnerPattern).where(
                    LearnerPattern.user_id == user_id,
                    LearnerPattern.id.in_(body.evidence_references),
                    LearnerPattern.status == "active",
                )
            )
        )
        .scalars()
        .all()
    )
    if len(patterns) != len(set(body.evidence_references)):
        raise ProposalValidation("every evidence reference must be an active owned pattern")

    proposal = DecisionProposal(
        user_id=user_id,
        goal_id=body.goal_id,
        proposal_type=body.proposal_type,
        title=body.title,
        summary=body.summary,
        reasoning=body.reasoning,
        proposed_changes=body.proposed_changes,
        evidence_references=list(dict.fromkeys(body.evidence_references)),
        confidence=body.confidence,
        status="pending",
        requires_user_confirmation=True,
        source=source,
        model_name=model_name,
        agent_trace=agent_trace or {},
        expires_at=body.expires_at,
    )
    db.add(proposal)
    await db.flush()
    await emit(
        db,
        user_id=user_id,
        goal_id=body.goal_id,
        aggregate_type="proposal",
        aggregate_id=proposal.id,
        event_type="ProposalCreated",
        source=source,
        payload={
            "proposal_type": proposal.proposal_type,
            "confidence": proposal.confidence,
            "evidence_references": proposal.evidence_references,
        },
    )
    return proposal


async def _get_owned_proposal(user_id: str, proposal_id: str, db: AsyncSession) -> DecisionProposal:
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
    return proposal


def _require_status(proposal: DecisionProposal, required: str) -> None:
    if proposal.status != required:
        raise ProposalConflict(
            f"proposal status must be {required}, current status is {proposal.status}"
        )


def _require_not_expired(proposal: DecisionProposal) -> None:
    if proposal.expires_at and proposal.expires_at <= utc_now():
        raise ProposalConflict("proposal has expired")


async def _apply_task_reschedules(
    user_id: str, proposal: DecisionProposal, db: AsyncSession
) -> None:
    updates, tasks = await _validate_task_reschedules(user_id, proposal.proposed_changes or {}, db)

    for update in updates:
        task = tasks[update["task_id"]]
        parsed = date.fromisoformat(update["scheduled_date"])
        old_date = task.scheduled_date
        task.scheduled_date = parsed.isoformat()
        await emit(
            db,
            user_id=user_id,
            goal_id=task.goal_id,
            aggregate_type="task",
            aggregate_id=task.id,
            event_type="TaskRescheduled",
            source="ai_agent",
            payload={
                "title": task.title,
                "from_date": old_date,
                "to_date": parsed.isoformat(),
                "trigger": "proposal_apply",
                "proposal_id": proposal.id,
            },
        )


async def _validate_task_reschedules(
    user_id: str,
    changes: dict[str, Any],
    db: AsyncSession,
) -> tuple[list[dict[str, Any]], dict[str, Task]]:
    updates = changes.get("task_updates")
    if not isinstance(updates, list) or not updates:
        raise ProposalValidation("task_updates is required")
    if any(not isinstance(row, dict) for row in updates):
        raise ProposalValidation("every task update must be an object")
    task_ids = [row.get("task_id") for row in updates]
    if any(not task_id for task_id in task_ids) or len(task_ids) != len(set(task_ids)):
        raise ProposalValidation("task updates must contain unique task_id values")
    rows = (
        await db.execute(
            select(Task, Goal)
            .join(Goal, Task.goal_id == Goal.id)
            .where(Task.id.in_(task_ids), Goal.user_id == user_id)
        )
    ).all()
    tasks = {task.id: task for task, _ in rows}
    if len(tasks) != len(set(task_ids)):
        raise ProposalValidation("proposal contains an inaccessible task")
    for update in updates:
        new_date = update.get("scheduled_date")
        try:
            parsed = date.fromisoformat(new_date)
        except (TypeError, ValueError) as exc:
            raise ProposalValidation("scheduled_date must be YYYY-MM-DD") from exc
        if parsed < date.today():
            raise ProposalValidation("scheduled_date cannot be in the past")
    return updates, tasks


async def _apply_daily_load(user_id: str, proposal: DecisionProposal, db: AsyncSession) -> None:
    changes = proposal.proposed_changes or {}
    goal, daily_hours = await _validate_daily_load(user_id, proposal.goal_id, changes, db)
    old_hours = goal.daily_hours
    goal.daily_hours = daily_hours
    await emit(
        db,
        user_id=user_id,
        goal_id=goal.id,
        aggregate_type="goal",
        aggregate_id=goal.id,
        event_type="GoalUpdated",
        source="ai_agent",
        payload={
            "changed_fields": ["daily_hours"],
            "old_daily_hours": old_hours,
            "daily_hours": daily_hours,
            "proposal_id": proposal.id,
        },
    )


async def _validate_daily_load(
    user_id: str,
    proposal_goal_id: str | None,
    changes: dict[str, Any],
    db: AsyncSession,
) -> tuple[Goal, float]:
    goal_id = changes.get("goal_id") or proposal_goal_id
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
    ).scalar_one_or_none()
    if goal is None:
        raise ProposalValidation("goal does not exist")
    try:
        daily_hours = float(changes["daily_hours"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ProposalValidation("daily_hours is required") from exc
    if not 0.25 <= daily_hours <= 16:
        raise ProposalValidation("daily_hours is outside the allowed range")
    return goal, daily_hours


async def _validate_adaptive_changes(
    user_id: str,
    proposal: DecisionProposal,
    changes: dict[str, Any],
    db: AsyncSession,
) -> None:
    if proposal.proposal_type == "PLAN_ADJUSTMENT":
        if not changes.get("task_updates") and "daily_hours" not in changes:
            raise ProposalValidation("plan adjustment requires task_updates or daily_hours")
        if changes.get("task_updates"):
            await _validate_task_reschedules(user_id, changes, db)
        if "daily_hours" in changes:
            await _validate_daily_load(user_id, proposal.goal_id, changes, db)
        return
    if proposal.proposal_type == "TASK_SPLIT":
        original_id = changes.get("original_task_id")
        rows = changes.get("new_tasks")
        if not original_id or not isinstance(rows, list) or not 2 <= len(rows) <= 10:
            raise ProposalValidation("task split requires 2 to 10 new_tasks")
        original = await db.scalar(
            select(Task)
            .join(Goal, Task.goal_id == Goal.id)
            .where(
                Task.id == original_id,
                Task.goal_id == proposal.goal_id,
                Goal.user_id == user_id,
            )
        )
        if original is None:
            raise ProposalValidation("original task does not exist")
        if original.status in {"completed", "skipped", "abandoned"}:
            raise ProposalValidation("original task can no longer be split")
        for row in rows:
            if not isinstance(row, dict) or not str(row.get("title") or "").strip():
                raise ProposalValidation("every split task requires a title")
            try:
                minutes = int(row.get("estimated_mins"))
                scheduled = date.fromisoformat(str(row.get("scheduled_date")))
            except (TypeError, ValueError) as exc:
                raise ProposalValidation("split task fields are invalid") from exc
            if not 5 <= minutes <= 480 or scheduled < date.today():
                raise ProposalValidation("split task duration or date is outside allowed range")
        return
    if proposal.proposal_type == "DIFFICULTY_ADJUST":
        task_id = changes.get("task_id")
        task = await db.scalar(
            select(Task)
            .join(Goal, Task.goal_id == Goal.id)
            .where(
                Task.id == task_id,
                Task.goal_id == proposal.goal_id,
                Goal.user_id == user_id,
            )
        )
        if task is None:
            raise ProposalValidation("task does not exist")
        if task.status in {"completed", "skipped", "abandoned"}:
            raise ProposalValidation("task can no longer be adjusted")
        try:
            minutes = int(changes.get("estimated_mins"))
        except (TypeError, ValueError) as exc:
            raise ProposalValidation("estimated_mins is invalid") from exc
        if not 5 <= minutes <= 480 or changes.get("priority") not in {"low", "medium", "high"}:
            raise ProposalValidation("difficulty adjustment is outside allowed range")
        return
    if proposal.proposal_type == "REVIEW_INSERTION":
        goal_id = changes.get("goal_id") or proposal.goal_id
        concept_id = changes.get("concept_id")
        owned_goal = await db.scalar(
            select(Goal.id).where(Goal.id == goal_id, Goal.user_id == user_id)
        )
        owned_concept = await db.scalar(
            select(LearningConcept.id).where(
                LearningConcept.id == concept_id,
                LearningConcept.user_id == user_id,
                or_(LearningConcept.goal_id.is_(None), LearningConcept.goal_id == goal_id),
            )
        )
        if owned_goal is None or owned_concept is None:
            raise ProposalValidation("review goal or concept does not exist")
        try:
            scheduled = date.fromisoformat(str(changes.get("scheduled_date")))
            minutes = int(changes.get("estimated_mins"))
        except (TypeError, ValueError) as exc:
            raise ProposalValidation("review task fields are invalid") from exc
        if scheduled < date.today() or not 5 <= minutes <= 240:
            raise ProposalValidation("review task is outside allowed range")
        if not str(changes.get("title") or "").strip():
            raise ProposalValidation("review title is required")


async def _apply_plan_adjustment(
    user_id: str, proposal: DecisionProposal, db: AsyncSession
) -> None:
    changes = proposal.proposed_changes or {}
    await _validate_adaptive_changes(user_id, proposal, changes, db)
    if changes.get("task_updates"):
        await _apply_task_reschedules(user_id, proposal, db)
    if "daily_hours" in changes:
        await _apply_daily_load(user_id, proposal, db)


async def _apply_task_split(user_id: str, proposal: DecisionProposal, db: AsyncSession) -> None:
    changes = proposal.proposed_changes or {}
    await _validate_adaptive_changes(user_id, proposal, changes, db)
    original = await db.scalar(select(Task).where(Task.id == changes["original_task_id"]))
    assert original is not None
    original.status = "skipped"
    await emit(
        db,
        user_id=user_id,
        goal_id=original.goal_id,
        aggregate_type="task",
        aggregate_id=original.id,
        event_type="TaskSkipped",
        source="ai_agent",
        payload={
            "title": original.title,
            "skip_reason": "adaptive_task_split",
            "debt_created": False,
            "proposal_id": proposal.id,
        },
    )
    for row in changes["new_tasks"]:
        task = Task(
            id=str(uuid.uuid4()),
            goal_id=original.goal_id,
            title=str(row["title"]).strip(),
            estimated_mins=int(row["estimated_mins"]),
            scheduled_date=str(row["scheduled_date"]),
            priority=original.priority,
            type=original.type,
            status="pending",
        )
        db.add(task)
        await emit(
            db,
            user_id=user_id,
            goal_id=original.goal_id,
            aggregate_type="task",
            aggregate_id=task.id,
            event_type="TaskCreated",
            source="ai_agent",
            payload={
                "title": task.title,
                "scheduled_date": task.scheduled_date,
                "estimated_mins": task.estimated_mins,
                "proposal_id": proposal.id,
            },
        )


async def _apply_difficulty_adjust(
    user_id: str, proposal: DecisionProposal, db: AsyncSession
) -> None:
    changes = proposal.proposed_changes or {}
    await _validate_adaptive_changes(user_id, proposal, changes, db)
    task = await db.scalar(select(Task).where(Task.id == changes["task_id"]))
    assert task is not None
    old_minutes, old_priority = task.estimated_mins, task.priority
    task.estimated_mins = int(changes["estimated_mins"])
    task.priority = str(changes["priority"])
    await emit(
        db,
        user_id=user_id,
        goal_id=task.goal_id,
        aggregate_type="task",
        aggregate_id=task.id,
        event_type="TaskDifficultyAdjusted",
        source="ai_agent",
        payload={
            "old_estimated_mins": old_minutes,
            "estimated_mins": task.estimated_mins,
            "old_priority": old_priority,
            "priority": task.priority,
            "proposal_id": proposal.id,
        },
    )


async def _apply_review_insertion(
    user_id: str, proposal: DecisionProposal, db: AsyncSession
) -> None:
    changes = proposal.proposed_changes or {}
    await _validate_adaptive_changes(user_id, proposal, changes, db)
    task = Task(
        id=str(uuid.uuid4()),
        goal_id=str(changes.get("goal_id") or proposal.goal_id),
        title=str(changes["title"]).strip(),
        estimated_mins=int(changes["estimated_mins"]),
        scheduled_date=str(changes["scheduled_date"]),
        priority="high",
        type="review",
        status="pending",
        kb_refs=[str(changes["concept_id"])],
    )
    db.add(task)
    await emit(
        db,
        user_id=user_id,
        goal_id=task.goal_id,
        aggregate_type="task",
        aggregate_id=task.id,
        event_type="TaskCreated",
        source="ai_agent",
        payload={
            "title": task.title,
            "scheduled_date": task.scheduled_date,
            "estimated_mins": task.estimated_mins,
            "type": "review",
            "concept_id": changes["concept_id"],
            "proposal_id": proposal.id,
        },
    )


def proposal_to_dict(proposal: DecisionProposal, *, has_feedback: bool = False) -> dict[str, Any]:
    # Learner-facing responses expose only a small, human-readable generation
    # summary.  Prompt/model/policy IDs and experiment internals belong to the
    # admin audit endpoint, not to an individual's learning workspace.
    trace = proposal.agent_trace or {}
    public_agent_trace = {
        "invocation_id": trace.get("invocation_id"),
        "fallback": bool(trace.get("fallback")),
        "latency_ms": trace.get("latency_ms"),
    }
    return {
        "id": proposal.id,
        "goal_id": proposal.goal_id,
        "proposal_type": proposal.proposal_type,
        "title": proposal.title,
        "summary": proposal.summary,
        "reasoning": proposal.reasoning or [],
        "proposed_changes": proposal.proposed_changes or {},
        "evidence_references": proposal.evidence_references or [],
        "confidence": proposal.confidence,
        "status": proposal.status,
        "requires_user_confirmation": proposal.requires_user_confirmation,
        "source": proposal.source,
        # Keep model routing details in the admin audit, not the learner response.
        "model_name": None,
        "agent_trace": public_agent_trace,
        "rejection_reason": proposal.rejection_reason,
        "expires_at": proposal.expires_at.isoformat() if proposal.expires_at else None,
        "reviewed_at": proposal.reviewed_at.isoformat() if proposal.reviewed_at else None,
        "applied_at": proposal.applied_at.isoformat() if proposal.applied_at else None,
        "created_at": proposal.created_at.isoformat() if proposal.created_at else None,
        "has_feedback": has_feedback,
    }
