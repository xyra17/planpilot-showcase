"""Application service for the Decision Proposal review/apply gateway."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.agents.coach_agent import CoachAgent
from src.core.agent_v2.schemas import ChangeOperation, ChangeSet
from src.core.time import utc_now
from src.events.publisher import emit
from src.intelligence.decision_context import DecisionContextBuilder
from src.intelligence.pattern_feedback import apply_pattern_signal
from src.models import (
    CheckinRecord,
    DecisionProposal,
    Goal,
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
    "GOAL_PLAN_CREATE",
    "CHECKIN_RECORD",
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
    stmt = stmt.where(DecisionProposal.proposal_type.notin_({"GOAL_PLAN_CREATE", "CHECKIN_RECORD"}))
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
    source: str = "ai_agent",
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
    policy_type = (
        CoachAgent.recommend_action(full_context) if use_personalization else "learning_nudge"
    )

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
        source=source,
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
    del user_id, proposal_id, db
    raise ProposalConflict(
        "direct Proposal apply was removed; convert the insight to an Action Run"
    )


async def build_insight_change_set(user_id: str, proposal_id: str, db: AsyncSession) -> ChangeSet:
    """Convert one validated learning insight into an executable ChangeSet."""
    proposal = await _get_owned_proposal(user_id, proposal_id, db)
    if proposal.status not in {"pending", "accepted"}:
        raise ProposalConflict("only pending or accepted insights can generate an action plan")
    _require_not_expired(proposal)
    changes = proposal.proposed_changes or {}
    operations: list[ChangeOperation] = []

    if proposal.proposal_type == "CHECKIN_RECORD":
        goal_id = str(changes.get("goal_id") or proposal.goal_id or "")
        goal = await db.scalar(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
        if goal is None:
            raise ProposalValidation("check-in goal does not exist")
        checkin_date = str(changes.get("date") or "")
        try:
            date.fromisoformat(checkin_date)
            rate = float(changes["completion_rate"])
        except (TypeError, ValueError, KeyError) as exc:
            raise ProposalValidation("check-in draft is invalid") from exc
        if not 0 <= rate <= 1:
            raise ProposalValidation("check-in completion rate is outside the allowed range")
        existing = await db.scalar(
            select(CheckinRecord).where(
                CheckinRecord.user_id == user_id,
                CheckinRecord.goal_id == goal_id,
                CheckinRecord.date == checkin_date,
            )
        )
        checkin_id = existing.id if existing else str(uuid.uuid4())
        before = (
            {
                "id": existing.id,
                "goal_id": existing.goal_id,
                "date": existing.date,
                "mode": existing.mode,
                "natural_text": existing.natural_text,
                "completion_rate": existing.completion_rate,
            }
            if existing
            else None
        )
        after = {
            "id": checkin_id,
            "goal_id": goal_id,
            "date": checkin_date,
            "mode": "natural",
            "natural_text": str(changes.get("natural_text") or ""),
            "completion_rate": rate,
        }
        operations.append(
            ChangeOperation(
                entity="checkin",
                entity_id=checkin_id,
                field="__upsert__",
                before=before,
                after=after,
                label=f"{goal.title} · {checkin_date}",
                reason="自然语言完成度是推断结果，需确认后记录",
            )
        )

    if proposal.proposal_type == "GOAL_PLAN_CREATE":
        goal_snapshot = dict(changes.get("goal") or {})
        goal_id = str(goal_snapshot.get("id") or "")
        if not goal_id or not str(goal_snapshot.get("title") or "").strip():
            raise ProposalValidation("goal plan draft is incomplete")
        operations.append(
            ChangeOperation(
                entity="goal",
                entity_id=goal_id,
                field="__create__",
                before=None,
                after=goal_snapshot,
                label=str(goal_snapshot["title"]),
                reason="按用户确认的计划草案创建目标",
            )
        )
        for raw in changes.get("tasks", []):
            snapshot = dict(raw)
            task_id = str(snapshot.get("id") or uuid.uuid4())
            snapshot.update({"id": task_id, "goal_id": goal_id})
            operations.append(
                ChangeOperation(
                    entity="task",
                    entity_id=task_id,
                    field="__create__",
                    before=None,
                    after=snapshot,
                    label=str(snapshot.get("title") or "学习任务"),
                    reason="按用户确认的计划草案创建任务",
                )
            )

    if proposal.proposal_type in {"reschedule_overdue_tasks", "PLAN_ADJUSTMENT"} and changes.get(
        "task_updates"
    ):
        updates, tasks = await _validate_task_reschedules(user_id, changes, db)
        for update in updates:
            task = tasks[update["task_id"]]
            operations.append(
                ChangeOperation(
                    entity="task",
                    entity_id=task.id,
                    field="scheduled_date",
                    before=task.scheduled_date,
                    after=update["scheduled_date"],
                    label=task.title,
                    reason=f"来自学习洞察“{proposal.title}”",
                    precondition={"version": task.version},
                )
            )

    if (
        proposal.proposal_type in {"reduce_daily_load", "PLAN_ADJUSTMENT"}
        and "daily_hours" in changes
    ):
        goal, daily_hours = await _validate_daily_load(user_id, proposal.goal_id, changes, db)
        operations.append(
            ChangeOperation(
                entity="goal",
                entity_id=goal.id,
                field="daily_hours",
                before=goal.daily_hours,
                after=daily_hours,
                label=goal.title,
                reason=f"来自学习洞察“{proposal.title}”",
                precondition={"version": goal.version},
            )
        )

    if proposal.proposal_type == "TASK_SPLIT":
        await _validate_adaptive_changes(user_id, proposal, changes, db)
        original = await db.get(Task, str(changes["original_task_id"]))
        assert original is not None
        operations.append(
            ChangeOperation(
                entity="task",
                entity_id=original.id,
                field="status",
                before=original.status,
                after="skipped",
                label=original.title,
                reason="拆分后停用原任务",
                precondition={"version": original.version},
            )
        )
        for row in changes["new_tasks"]:
            task_id = str(uuid.uuid4())
            snapshot = {
                "id": task_id,
                "goal_id": original.goal_id,
                "title": str(row["title"]).strip(),
                "description": None,
                "estimated_mins": int(row["estimated_mins"]),
                "status": "pending",
                "priority": original.priority,
                "scheduled_date": str(row["scheduled_date"]),
                "mastery_level": "unknown",
                "type": original.type,
                "kb_refs": list(original.kb_refs or []),
                "version": 1,
            }
            operations.append(
                ChangeOperation(
                    entity="task",
                    entity_id=task_id,
                    field="__create__",
                    before=None,
                    after=snapshot,
                    label=snapshot["title"],
                    reason="按洞察方案拆分任务",
                )
            )

    if proposal.proposal_type == "DIFFICULTY_ADJUST":
        await _validate_adaptive_changes(user_id, proposal, changes, db)
        task = await db.get(Task, str(changes["task_id"]))
        assert task is not None
        for field, after in (
            ("estimated_mins", int(changes["estimated_mins"])),
            ("priority", str(changes["priority"])),
        ):
            operations.append(
                ChangeOperation(
                    entity="task",
                    entity_id=task.id,
                    field=field,
                    before=getattr(task, field),
                    after=after,
                    label=task.title,
                    reason=f"来自学习洞察“{proposal.title}”",
                    precondition={"version": task.version},
                )
            )

    if proposal.proposal_type == "REVIEW_INSERTION":
        await _validate_adaptive_changes(user_id, proposal, changes, db)
        task_id = str(uuid.uuid4())
        snapshot = {
            "id": task_id,
            "goal_id": str(changes.get("goal_id") or proposal.goal_id),
            "title": str(changes["title"]).strip(),
            "description": None,
            "estimated_mins": int(changes["estimated_mins"]),
            "status": "pending",
            "priority": "high",
            "scheduled_date": str(changes["scheduled_date"]),
            "mastery_level": "unknown",
            "type": "review",
            "kb_refs": [str(changes["concept_id"])],
            "version": 1,
        }
        operations.append(
            ChangeOperation(
                entity="task",
                entity_id=task_id,
                field="__create__",
                before=None,
                after=snapshot,
                label=snapshot["title"],
                reason="按洞察方案插入复习任务",
            )
        )

    if not operations:
        raise ProposalValidation("这条学习洞察不包含需要修改的数据")
    return ChangeSet(
        summary=f"根据“{proposal.title}”生成 {len(operations)} 项变更",
        operations=operations,
        source={"kind": "learning_insight", "proposal_id": proposal.id},
    )


async def convert_insight_to_action_run(
    user_id: str,
    proposal_id: str,
    db: AsyncSession,
    *,
    conversation_turn_id: str | None = None,
    need_frame: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from src.core.agent_v2.orchestrator import create_run, run_detail
    from src.core.agent_v2.schemas import ActionIntent
    from src.models import InsightActionRun
    from src.services.insight_action_lifecycle import (
        active_link,
        next_attempt_number,
        sync_run_lifecycle,
    )
    from src.tasks.agent_runs import dispatch_agent_run

    proposal = await _get_owned_proposal(user_id, proposal_id, db, lock=True)
    existing = await active_link(db, proposal.id, lock=True)
    if existing:
        return await run_detail(db, user_id, existing.run_id)
    if proposal.status == "applied" or proposal.lifecycle_status == "applied":
        raise ProposalConflict("applied insight cannot generate another action run")
    await build_insight_change_set(user_id, proposal_id, db)

    proposal.action_capability = "insight_action"
    proposal.action_seed = {
        "proposal_id": proposal.id,
        "proposal_type": proposal.proposal_type,
    }
    conversation_turn_id = conversation_turn_id or str(uuid.uuid4())
    intent = ActionIntent(
        capability="insight_action",
        goal_id=proposal.goal_id,
        constraints={"proposal_id": proposal.id},
        requested_effect="update",
        resolution_quality="exact",
        source="insight",
    )
    run = await create_run(
        db,
        user_id=user_id,
        request=f"根据学习洞察生成调整方案：{proposal.title}",
        goal_id=proposal.goal_id,
        step_budget=10,
        token_budget=20000,
        auto_advance=False,
        run_kind="user",
        action_intent=intent,
        deterministic_plan_only=True,
        conversation_turn_id=conversation_turn_id,
        insight_id=proposal.id,
        trace_context={
            "conversation_turn_id": conversation_turn_id,
            "source": "learning_insight",
            "insight_id": proposal.id,
            "need_frame": need_frame
            or {
                "speech_act": "command",
                "core_need": "将学习洞察转换为行动方案",
                "mode": "action",
                "context_scope": ["goal", "tasks", "learning_profile"],
                "evidence_scope": list(proposal.evidence_references or []),
            },
            "action_intent": intent.model_dump(mode="json"),
        },
        commit=False,
    )
    run_id = str(run.id)
    link = InsightActionRun(
        insight_id=proposal.id,
        run_id=run_id,
        status="converted",
        is_active=True,
        attempt_number=await next_attempt_number(db, proposal.id),
        history=[],
    )
    db.add(link)
    try:
        await db.flush()
        proposal.converted_run_id = run_id
        proposal.lifecycle_status = "converted"
        await sync_run_lifecycle(db, run=run, lifecycle="converted")
        await db.commit()
    except IntegrityError:
        await db.rollback()
        winner = await active_link(db, proposal_id)
        if winner is None:
            raise
        return await run_detail(db, user_id, winner.run_id)
    dispatch_agent_run(run_id, user_id)
    return await run_detail(db, user_id, run_id)


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

    from src.services.beta_evidence_service import assignment

    beta = await assignment(db, user_id)
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
        agent_trace={**(agent_trace or {}), "beta": beta},
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


async def _get_owned_proposal(
    user_id: str,
    proposal_id: str,
    db: AsyncSession,
    *,
    lock: bool = False,
) -> DecisionProposal:
    stmt = select(DecisionProposal).where(
        DecisionProposal.id == proposal_id,
        DecisionProposal.user_id == user_id,
    )
    if lock:
        stmt = stmt.with_for_update()
    proposal = (await db.execute(stmt)).scalar_one_or_none()
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
        "action_capability": proposal.action_capability,
        "action_seed": proposal.action_seed or {},
        "converted_run_id": proposal.converted_run_id,
        "evidence_references": proposal.evidence_references or [],
        "confidence": proposal.confidence,
        "status": proposal.status,
        "lifecycle_status": proposal.lifecycle_status,
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
