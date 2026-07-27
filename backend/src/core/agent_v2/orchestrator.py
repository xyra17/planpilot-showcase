from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from datetime import date, datetime, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.agent_v2.audit import record_event
from src.core.agent_v2.observer import verify_task_changes
from src.core.agent_v2.planner import create_plan
from src.core.agent_v2.policy import requires_approval
from src.core.agent_v2.registry import ToolRegistry, build_registry
from src.core.agent_v2.schemas import ChangeSet, ToolContext
from src.models import AgentApproval, AgentAuditEvent, AgentRun, AgentStep
from src.services.agent_context import assert_goal_access
from src.services.agent_schedule import undo_task_changes


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def change_hash(change_set: dict[str, Any]) -> str:
    canonical = json.dumps(
        change_set, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


async def _owned_run(db: AsyncSession, user_id: str, run_id: str) -> AgentRun:
    run = (
        await db.execute(
            select(AgentRun).where(AgentRun.id == run_id, AgentRun.user_id == user_id)
        )
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(404, "Agent 任务不存在")
    return run


async def _steps(db: AsyncSession, run_id: str) -> list[AgentStep]:
    return list(
        (
            await db.execute(
                select(AgentStep)
                .where(AgentStep.run_id == run_id)
                .order_by(AgentStep.step_index)
            )
        )
        .scalars()
        .all()
    )


def _step_payload(step: AgentStep, steps: list[AgentStep]) -> dict[str, Any]:
    payload = dict(step.input_data or {})
    outputs = {item.step_index: item.output_data for item in steps}
    if step.tool_name == "analytics.execution_summary":
        payload["context"] = outputs[0]
    elif step.tool_name in {
        "schedule.preview_reschedule",
        "tasks.preview_mutation",
    }:
        payload["context"] = outputs[0]
        payload["analysis"] = outputs[1]
    elif step.tool_name == "plan.review":
        payload["change_set"] = outputs[2]
    elif step.tool_name == "tasks.apply_changes":
        payload["change_set"] = outputs[2]
        payload["review"] = outputs[3]
    return payload


async def create_run(
    db: AsyncSession,
    *,
    user_id: str,
    request: str,
    goal_id: str | None,
    step_budget: int,
    token_budget: int,
    registry: ToolRegistry | None = None,
    auto_advance: bool = True,
) -> AgentRun:
    await assert_goal_access(db, user_id, goal_id)
    tools = registry or build_registry()
    objective, plan = create_plan(tools, request, goal_id)
    if len(plan) > step_budget:
        raise HTTPException(400, "执行计划超过允许的步骤预算")
    run = AgentRun(
        id=str(uuid.uuid4()),
        user_id=user_id,
        goal_id=goal_id,
        request_text=request,
        objective=objective,
        plan=[step.model_dump(mode="json") for step in plan],
        status="running" if auto_advance else "queued",
        step_budget=step_budget,
        token_budget=token_budget,
    )
    db.add(run)
    await db.flush()
    for planned in plan:
        spec = tools.get(planned.tool_name)
        db.add(
            AgentStep(
                id=str(uuid.uuid4()),
                run_id=run.id,
                step_index=planned.index,
                agent_role=planned.agent_role.value,
                tool_name=planned.tool_name,
                status="pending",
                risk=spec.risk.value,
                requires_approval=requires_approval(spec),
                input_data=planned.input,
                idempotency_key=(
                    f"{run.id}:{planned.index}:{planned.tool_name}"
                    if spec.effect.value == "write"
                    else None
                ),
            )
        )
    record_event(
        db,
        run_id=run.id,
        event_type="run.created",
        actor="user",
        detail={"request": request, "objective": objective},
    )
    await db.commit()
    if auto_advance:
        await advance_run(db, user_id=user_id, run_id=run.id, registry=tools)
    return await _owned_run(db, user_id, run.id)


async def claim_queued_run(
    db: AsyncSession, *, user_id: str, run_id: str
) -> bool:
    claimed = (
        await db.execute(
            update(AgentRun)
            .where(
                AgentRun.id == run_id,
                AgentRun.user_id == user_id,
                AgentRun.status.in_(["queued", "running"]),
            )
            .values(status="executing", updated_at=utcnow())
            .returning(AgentRun.id)
        )
    ).scalar_one_or_none()
    await db.commit()
    return claimed is not None


async def advance_run(
    db: AsyncSession,
    *,
    user_id: str,
    run_id: str,
    registry: ToolRegistry | None = None,
) -> AgentRun:
    tools = registry or build_registry()
    run = await _owned_run(db, user_id, run_id)
    if run.status in {"completed", "cancelled", "rejected", "undone", "paused"}:
        return run
    steps = await _steps(db, run.id)
    for step in steps:
        run = await _owned_run(db, user_id, run.id)
        if run.status == "paused":
            return run
        if step.status in {"completed", "skipped"}:
            continue
        spec = tools.get(step.tool_name)
        payload = _step_payload(step, steps)
        if step.requires_approval:
            approval = (
                await db.execute(
                    select(AgentApproval).where(
                        AgentApproval.run_id == run.id,
                        AgentApproval.step_id == step.id,
                    )
                )
            ).scalar_one_or_none()
            if approval is None:
                changes = payload.get("change_set", {})
                if any(
                    item.get("field") == "__delete__"
                    for item in changes.get("operations", [])
                ):
                    step.risk = "high"
                approval = AgentApproval(
                    id=str(uuid.uuid4()),
                    run_id=run.id,
                    step_id=step.id,
                    status="pending",
                    change_set=changes,
                    change_hash=change_hash(changes),
                )
                db.add(approval)
                step.status = "waiting_approval"
                run.status = "waiting_approval"
                run.current_step = step.step_index
                record_event(
                    db,
                    run_id=run.id,
                    step_id=step.id,
                    event_type="approval.requested",
                    actor="main_agent",
                    detail={"change_hash": approval.change_hash, "change_set": changes},
                )
                await db.commit()
                return run
            if approval.status != "approved":
                run.status = "waiting_approval"
                await db.commit()
                return run

        step.status = "running"
        step.started_at = utcnow()
        run.current_step = step.step_index
        record_event(
            db,
            run_id=run.id,
            step_id=step.id,
            event_type="tool.started",
            actor=step.agent_role,
            detail={"tool": spec.name, "effect": spec.effect.value},
        )
        await db.commit()
        last_error: Exception | None = None
        for attempt in range(spec.max_retries + 1):
            step.attempts = attempt + 1
            try:
                result = await asyncio.wait_for(
                    spec.handler(
                        db,
                        ToolContext(user_id=user_id, run_id=run.id, step_id=step.id),
                        payload,
                    ),
                    timeout=spec.timeout_seconds,
                )
                if spec.name == "tasks.apply_changes":
                    verification = await verify_task_changes(
                        db, user_id, ChangeSet.model_validate(payload["change_set"])
                    )
                    result["verification"] = verification
                    if not verification["verified"]:
                        raise RuntimeError("写入后回读验证失败")
                step.output_data = result
                step.status = "completed"
                step.finished_at = utcnow()
                record_event(
                    db,
                    run_id=run.id,
                    step_id=step.id,
                    event_type="tool.completed",
                    actor=step.agent_role,
                    detail={"tool": spec.name, "result": result},
                )
                await db.commit()
                break
            except Exception as exc:
                last_error = exc
                await db.rollback()
                step = (
                    await db.execute(select(AgentStep).where(AgentStep.id == step.id))
                ).scalar_one()
                if attempt < spec.max_retries:
                    record_event(
                        db,
                        run_id=run.id,
                        step_id=step.id,
                        event_type="tool.retrying",
                        actor="observer",
                        detail={"attempt": attempt + 1, "error": str(exc)},
                    )
                    await db.commit()
        if step.status != "completed":
            step.status = "failed"
            step.error = str(last_error)
            step.finished_at = utcnow()
            run = await _owned_run(db, user_id, run.id)
            run.status = "failed"
            run.failure_count += 1
            run.error = str(last_error)
            record_event(
                db,
                run_id=run.id,
                step_id=step.id,
                event_type="run.failed",
                actor="observer",
                detail={"error": str(last_error)},
            )
            await db.commit()
            return run
        steps = await _steps(db, run.id)

    run = await _owned_run(db, user_id, run.id)
    run.status = "completed"
    run.current_step = len(steps)
    run.result = {
        "summary": "Agent 已完成分析和获批操作",
        "last_output": steps[-1].output_data if steps else None,
        "undo_available": bool(
            steps
            and steps[-1].output_data
            and steps[-1].output_data.get("undo_operations")
        ),
    }
    record_event(
        db,
        run_id=run.id,
        event_type="run.completed",
        actor="observer",
        detail=run.result,
    )
    await db.commit()
    return run


async def approve_run(
    db: AsyncSession,
    *,
    user_id: str,
    run_id: str,
    approval_id: str,
    expected_hash: str,
    auto_advance: bool = True,
) -> AgentRun:
    run = await _owned_run(db, user_id, run_id)
    approval = (
        await db.execute(
            select(AgentApproval).where(
                AgentApproval.id == approval_id,
                AgentApproval.run_id == run.id,
                AgentApproval.status == "pending",
            )
        )
    ).scalar_one_or_none()
    if not approval:
        raise HTTPException(409, "审批已处理或不存在")
    if approval.change_hash != expected_hash:
        raise HTTPException(409, "变更预览已变化，请刷新后重新确认")
    approval.status = "approved"
    approval.decided_at = utcnow()
    run.status = "running"
    step = (
        await db.execute(select(AgentStep).where(AgentStep.id == approval.step_id))
    ).scalar_one()
    step.status = "pending"
    record_event(
        db,
        run_id=run.id,
        step_id=step.id,
        event_type="approval.approved",
        actor="user",
        detail={"change_hash": approval.change_hash},
    )
    await db.commit()
    if auto_advance:
        return await advance_run(db, user_id=user_id, run_id=run.id)
    run.status = "queued"
    await db.commit()
    return run


async def edit_approval(
    db: AsyncSession,
    *,
    user_id: str,
    run_id: str,
    approval_id: str,
    change_set: ChangeSet,
) -> AgentRun:
    run = await _owned_run(db, user_id, run_id)
    approval = (
        await db.execute(
            select(AgentApproval).where(
                AgentApproval.id == approval_id,
                AgentApproval.run_id == run.id,
                AgentApproval.status == "pending",
            )
        )
    ).scalar_one_or_none()
    if not approval:
        raise HTTPException(409, "审批已处理或不存在")
    if len(change_set.operations) > 50:
        raise HTTPException(400, "单次变更不能超过 50 项")
    originals = {
        (item["entity"], item["entity_id"], item["field"]): item
        for item in approval.change_set.get("operations", [])
    }
    original_keys = set(originals)
    edited_keys = {
        (item.entity, item.entity_id, item.field) for item in change_set.operations
    }
    if not edited_keys.issubset(original_keys):
        raise HTTPException(400, "只能编辑或移除原方案中的变更，不能新增未审查操作")
    for item in change_set.operations:
        original = originals[(item.entity, item.entity_id, item.field)]
        if item.before != original.get("before"):
            raise HTTPException(400, "不能修改并发校验所使用的原值")
        if item.field == "__delete__" and item.model_dump() != original:
            raise HTTPException(400, "删除操作只能保留或移除，不能修改内容")
        if item.field == "__create__":
            after = dict(item.after or {})
            original_after = dict(original.get("after") or {})
            if (
                after.get("id") != original_after.get("id")
                or after.get("goal_id") != original_after.get("goal_id")
            ):
                raise HTTPException(400, "不能修改新任务的身份或所属目标")
            if not str(after.get("title", "")).strip():
                raise HTTPException(400, "任务标题不能为空")
            try:
                date.fromisoformat(str(after.get("scheduled_date")))
            except ValueError as exc:
                raise HTTPException(400, "任务日期格式无效") from exc
        if item.field == "scheduled_date":
            try:
                date.fromisoformat(str(item.after))
            except ValueError as exc:
                raise HTTPException(400, "任务日期格式无效") from exc
    payload = change_set.model_dump()
    approval.change_set = payload
    approval.change_hash = change_hash(payload)
    step = (
        await db.execute(select(AgentStep).where(AgentStep.id == approval.step_id))
    ).scalar_one()
    source_step = (
        await db.execute(
            select(AgentStep).where(
                AgentStep.run_id == run.id,
                AgentStep.step_index == step.step_index - 2,
            )
        )
    ).scalar_one_or_none()
    if source_step:
        source_step.output_data = payload
    if any(item.field == "__delete__" for item in change_set.operations):
        step.risk = "high"
    record_event(
        db,
        run_id=run.id,
        step_id=step.id,
        event_type="approval.edited",
        actor="user",
        detail={"change_hash": approval.change_hash, "change_set": payload},
    )
    await db.commit()
    return run


async def reject_run(
    db: AsyncSession,
    *,
    user_id: str,
    run_id: str,
    approval_id: str,
    reason: str | None,
) -> AgentRun:
    run = await _owned_run(db, user_id, run_id)
    approval = (
        await db.execute(
            select(AgentApproval).where(
                AgentApproval.id == approval_id,
                AgentApproval.run_id == run.id,
                AgentApproval.status == "pending",
            )
        )
    ).scalar_one_or_none()
    if not approval:
        raise HTTPException(409, "审批已处理或不存在")
    approval.status = "rejected"
    approval.decided_at = utcnow()
    run.status = "rejected"
    record_event(
        db,
        run_id=run.id,
        step_id=approval.step_id,
        event_type="approval.rejected",
        actor="user",
        detail={"reason": reason},
    )
    await db.commit()
    return run


async def cancel_run(db: AsyncSession, *, user_id: str, run_id: str) -> AgentRun:
    run = await _owned_run(db, user_id, run_id)
    if run.status in {"completed", "undone"}:
        raise HTTPException(409, "已完成的任务不能取消")
    run.status = "cancelled"
    record_event(db, run_id=run.id, event_type="run.cancelled", actor="user")
    await db.commit()
    return run


async def pause_run(db: AsyncSession, *, user_id: str, run_id: str) -> AgentRun:
    run = await _owned_run(db, user_id, run_id)
    if run.status not in {"queued", "running", "executing", "waiting_approval"}:
        raise HTTPException(409, "当前状态不能暂停")
    run.objective = {**(run.objective or {}), "paused_from": run.status}
    run.status = "paused"
    record_event(db, run_id=run.id, event_type="run.paused", actor="user")
    await db.commit()
    return run


async def resume_run(db: AsyncSession, *, user_id: str, run_id: str) -> AgentRun:
    run = await _owned_run(db, user_id, run_id)
    if run.status != "paused":
        raise HTTPException(409, "只有已暂停任务可以继续")
    previous = (run.objective or {}).get("paused_from", "running")
    run.status = previous if previous == "waiting_approval" else "queued"
    record_event(db, run_id=run.id, event_type="run.resumed", actor="user")
    await db.commit()
    return run


async def retry_run(
    db: AsyncSession, *, user_id: str, run_id: str, auto_advance: bool = True
) -> AgentRun:
    run = await _owned_run(db, user_id, run_id)
    if run.status != "failed":
        raise HTTPException(409, "只有失败的任务可以重试")
    if run.failure_count >= 3:
        raise HTTPException(409, "失败次数已达上限，请重新创建任务")
    step = (
        await db.execute(
            select(AgentStep).where(
                AgentStep.run_id == run.id, AgentStep.status == "failed"
            )
        )
    ).scalar_one_or_none()
    if step:
        step.status = "pending"
        step.error = None
    run.status = "running" if auto_advance else "queued"
    run.error = None
    record_event(db, run_id=run.id, event_type="run.retry_requested", actor="user")
    await db.commit()
    if auto_advance:
        return await advance_run(db, user_id=user_id, run_id=run.id)
    return run


async def undo_run(db: AsyncSession, *, user_id: str, run_id: str) -> AgentRun:
    run = await _owned_run(db, user_id, run_id)
    if run.status != "completed":
        raise HTTPException(409, "只有已完成任务可以撤销")
    step = (
        await db.execute(
            select(AgentStep).where(
                AgentStep.run_id == run.id,
                AgentStep.tool_name == "tasks.apply_changes",
                AgentStep.status == "completed",
            )
        )
    ).scalar_one_or_none()
    operations = (step.output_data or {}).get("undo_operations", []) if step else []
    if not operations:
        raise HTTPException(409, "此任务没有可撤销变更")
    result = await undo_task_changes(db, user_id, operations)
    run.status = "undone"
    run.result = {**(run.result or {}), "undo_result": result}
    record_event(
        db,
        run_id=run.id,
        step_id=step.id if step else None,
        event_type="run.undone",
        actor="user",
        detail=result,
    )
    await db.commit()
    return run


async def run_detail(db: AsyncSession, user_id: str, run_id: str) -> dict[str, Any]:
    run = await _owned_run(db, user_id, run_id)
    steps = await _steps(db, run.id)
    approvals = list(
        (
            await db.execute(
                select(AgentApproval)
                .where(AgentApproval.run_id == run.id)
                .order_by(AgentApproval.created_at)
            )
        )
        .scalars()
        .all()
    )
    events = list(
        (
            await db.execute(
                select(AgentAuditEvent)
                .where(AgentAuditEvent.run_id == run.id)
                .order_by(AgentAuditEvent.created_at)
            )
        )
        .scalars()
        .all()
    )
    return serialize_run(run, steps, approvals, events)


def serialize_run(
    run: AgentRun,
    steps: list[AgentStep] | None = None,
    approvals: list[AgentApproval] | None = None,
    events: list[AgentAuditEvent] | None = None,
) -> dict[str, Any]:
    return {
        "id": run.id,
        "goal_id": run.goal_id,
        "request": run.request_text,
        "objective": run.objective,
        "plan": run.plan,
        "status": run.status,
        "current_step": run.current_step,
        "step_budget": run.step_budget,
        "failure_count": run.failure_count,
        "error": run.error,
        "result": run.result,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "updated_at": run.updated_at.isoformat() if run.updated_at else None,
        "steps": [
            {
                "id": item.id,
                "index": item.step_index,
                "agent_role": item.agent_role,
                "tool_name": item.tool_name,
                "status": item.status,
                "risk": item.risk,
                "requires_approval": item.requires_approval,
                "input": item.input_data,
                "output": item.output_data,
                "error": item.error,
                "attempts": item.attempts,
            }
            for item in (steps or [])
        ],
        "approvals": [
            {
                "id": item.id,
                "step_id": item.step_id,
                "status": item.status,
                "change_set": item.change_set,
                "change_hash": item.change_hash,
                "created_at": item.created_at.isoformat() if item.created_at else None,
            }
            for item in (approvals or [])
        ],
        "events": [
            {
                "id": item.id,
                "step_id": item.step_id,
                "type": item.event_type,
                "actor": item.actor,
                "detail": item.detail,
                "created_at": item.created_at.isoformat() if item.created_at else None,
            }
            for item in (events or [])
        ],
    }
