from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.agent_v2.audit import record_event
from src.core.agent_v2.errors import BudgetExceeded, LeaseLost, classify_error
from src.core.agent_v2.executor import compensate_run, execute_change_set
from src.core.agent_v2.planner import create_plan
from src.core.agent_v2.policy import evaluate_policy
from src.core.agent_v2.registry import ToolRegistry, build_registry
from src.core.agent_v2.resolver import ready_steps, resolve_inputs, validate_plan
from src.core.agent_v2.schemas import (
    AgentPlan,
    AgentRole,
    ChangeSet,
    ErrorCategory,
    PlanStep,
    PolicyOutcome,
    SubAgentRequest,
    ToolContext,
)
from src.core.agent_v2.subagents import invoke_subagent
from src.core.agent_v2.transitions import (
    claim_run_lease,
    has_run_lease,
    transition_run,
    transition_step,
)
from src.core.time import utc_now
from src.models import AgentApproval, AgentAuditEvent, AgentRun, AgentStep
from src.services.agent_context import assert_goal_access


def change_hash(change_set: dict[str, Any]) -> str:
    canonical = json.dumps(change_set, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


async def _owned_run(db: AsyncSession, user_id: str, run_id: str) -> AgentRun:
    run = (
        await db.execute(
            select(AgentRun)
            .where(AgentRun.id == run_id, AgentRun.user_id == user_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(404, "Agent 任务不存在")
    return run


async def _steps(
    db: AsyncSession, run_id: str, *, current_only: int | None = None
) -> list[AgentStep]:
    query = (
        select(AgentStep)
        .where(AgentStep.run_id == run_id)
        .execution_options(populate_existing=True)
    )
    if current_only is not None:
        query = query.where(AgentStep.plan_version == current_only)
    return list(
        (await db.execute(query.order_by(AgentStep.plan_version, AgentStep.step_index)))
        .scalars()
        .all()
    )


def _persisted_step(plan: AgentPlan, planned: PlanStep, prefix: str) -> PlanStep:
    key = f"{prefix}{planned.step_id}"
    return planned.model_copy(
        update={
            "step_id": key,
            "depends_on": [f"{prefix}{item}" for item in planned.depends_on],
            "input_refs": {
                field: ref.model_copy(update={"step_id": f"{prefix}{ref.step_id}"})
                for field, ref in planned.input_refs.items()
            },
        }
    )


def _add_plan_steps(
    db: AsyncSession,
    run: AgentRun,
    plan: AgentPlan,
    registry: ToolRegistry,
    *,
    reusable: dict[str, AgentStep] | None = None,
) -> list[PlanStep]:
    prefix = f"v{plan.version}:"
    persisted: list[PlanStep] = []
    for planned in plan.steps:
        item = _persisted_step(plan, planned, prefix)
        persisted.append(item)
        spec = registry.get(item.tool_name)
        decision = evaluate_policy(spec, role=item.agent_role, run_kind=run.run_kind)
        reused = (reusable or {}).get(str(planned.step_id))
        stored = AgentStep(
            id=str(uuid.uuid4()),
            run_id=run.id,
            step_index=item.index,
            step_key=item.step_id,
            plan_version=plan.version,
            agent_role=item.agent_role.value,
            tool_name=item.tool_name,
            status="completed" if reused else "pending",
            risk=decision.risk.value,
            requires_approval=decision.outcome == PolicyOutcome.REQUIRE_APPROVAL,
            input_data=item.input,
            resolved_input_summary=reused.resolved_input_summary if reused else {},
            input_refs={
                key: value.model_dump(mode="json") for key, value in item.input_refs.items()
            },
            depends_on=item.depends_on,
            on_failure=item.on_failure,
            rationale=item.rationale,
            output_data=reused.output_data if reused else None,
            attempts=0,
            started_at=reused.started_at if reused else None,
            finished_at=reused.finished_at if reused else None,
            idempotency_key=f"{run.id}:{plan.version}:{item.step_id}:{item.tool_name}"
            if spec.effect.value in {"write", "destructive", "external"}
            else None,
        )
        db.add(stored)
        if reused:
            record_event(
                db,
                run_id=run.id,
                step_id=stored.id,
                event_type="step.reused",
                actor="planner",
                detail={
                    "from_step_id": reused.id,
                    "from_step_key": reused.step_key,
                    "to_step_key": stored.step_key,
                    "plan_version": plan.version,
                },
                safe_summary=f"复用上个计划的已完成步骤：{item.title}",
            )
    return persisted


def _logical_step_id(step_key: str) -> str:
    return step_key.split(":", 1)[1] if ":" in step_key else step_key


def _invalidated_steps(steps: list[AgentStep], failed_step: AgentStep) -> set[str]:
    by_key = {step.step_key: step for step in steps}
    invalid = {failed_step.step_key}
    pending = list(failed_step.depends_on or [])
    while pending:
        key = pending.pop()
        if key in invalid:
            continue
        invalid.add(key)
        dependency = by_key.get(key)
        if dependency:
            pending.extend(dependency.depends_on or [])
    return invalid


def _reusable_steps(
    old_steps: list[AgentStep], plan: AgentPlan, invalidated: set[str]
) -> dict[str, AgentStep]:
    old_by_logical = {_logical_step_id(step.step_key): step for step in old_steps}
    reusable: dict[str, AgentStep] = {}
    for planned in plan.steps:
        old = old_by_logical.get(str(planned.step_id))
        if not old or old.status != "completed" or old.step_key in invalidated:
            continue
        if (
            old.tool_name != planned.tool_name
            or old.agent_role != planned.agent_role.value
            or (old.input_data or {}) != planned.input
            or any(dependency not in reusable for dependency in planned.depends_on)
        ):
            continue
        reusable[str(planned.step_id)] = old
    return reusable


def _plan_history_entry(
    plan: AgentPlan,
    persisted: list[PlanStep],
    trace: dict[str, Any],
    *,
    reused: dict[str, AgentStep] | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    return {
        **trace,
        "version": plan.version,
        "reason": reason,
        "reused_steps": {
            logical_id: source.step_key for logical_id, source in (reused or {}).items()
        },
        "steps": [step.model_dump(mode="json") for step in persisted],
    }


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
    run_kind: str = "user",
) -> AgentRun:
    await assert_goal_access(db, user_id, goal_id)
    tools = registry or build_registry()
    plan, planner_trace = await create_plan(tools, request, goal_id, step_budget=step_budget)
    validate_plan(plan, available_tools=tools.names(), step_budget=step_budget)
    if plan.estimated_tokens > token_budget:
        raise HTTPException(400, "规划已超过 Token 预算")
    run = AgentRun(
        id=str(uuid.uuid4()),
        user_id=user_id,
        goal_id=goal_id,
        request_text=request,
        objective=plan.objective,
        plan=[],
        plan_history=[],
        run_kind=run_kind,
        status="queued",
        plan_version=plan.version,
        step_budget=step_budget,
        token_budget=token_budget,
        tokens_consumed=plan.estimated_tokens,
        deadline_at=utc_now() + timedelta(minutes=10),
    )
    db.add(run)
    await db.flush()
    persisted = _add_plan_steps(db, run, plan, tools)
    run.plan = [step.model_dump(mode="json") for step in persisted]
    run.plan_history = [_plan_history_entry(plan, persisted, planner_trace)]
    record_event(
        db,
        run_id=run.id,
        event_type="run.created",
        actor="user" if run_kind == "user" else "scheduler",
        detail={
            "objective": plan.objective,
            "planner": plan.planner,
            "candidate_tools": plan.candidate_tools,
        },
        safe_summary="已创建 Agent 任务",
    )
    record_event(
        db,
        run_id=run.id,
        event_type="planner.completed",
        actor="planner",
        detail=planner_trace,
        safe_summary=f"计划 v{plan.version} 已通过服务端校验",
    )
    if planner_trace.get("fallback"):
        record_event(
            db,
            run_id=run.id,
            event_type="planner.fallback",
            actor="planner",
            detail={"reason": planner_trace.get("fallback_reason")},
            safe_summary=f"计划 v{plan.version} 已降级为确定性规划",
        )
    await db.commit()
    if auto_advance:
        token = await claim_run_lease(db, user_id=user_id, run_id=run.id, worker_id="inline")
        if token:
            return await advance_run(
                db, user_id=user_id, run_id=run.id, registry=tools, lease_token=token
            )
    return await _owned_run(db, user_id, run.id)


async def claim_queued_run(db: AsyncSession, *, user_id: str, run_id: str) -> bool:
    return bool(
        await claim_run_lease(db, user_id=user_id, run_id=run_id, worker_id="legacy-worker")
    )


def _plan_step(step: AgentStep) -> PlanStep:
    return PlanStep(
        index=step.step_index,
        step_id=step.step_key,
        title=step.tool_name,
        agent_role=AgentRole(step.agent_role),
        tool_name=step.tool_name,
        input=step.input_data or {},
        input_refs=step.input_refs or {},
        depends_on=step.depends_on or [],
        on_failure=step.on_failure,
        rationale=step.rationale,
    )


def _enforce_budget(run: AgentRun) -> None:
    if run.deadline_at and utc_now() >= run.deadline_at:
        raise BudgetExceeded("Run 已超过总运行时间预算")
    if run.steps_consumed >= run.step_budget:
        raise BudgetExceeded("Run 已用尽步骤预算")
    if run.tokens_consumed >= run.token_budget:
        raise BudgetExceeded("Run 已用尽 Token 预算")
    if run.tool_time_consumed_ms >= run.tool_time_budget_ms:
        raise BudgetExceeded("Run 已用尽工具时间预算")


async def _replan(
    db: AsyncSession,
    run: AgentRun,
    registry: ToolRegistry,
    reason: str,
    failed_step: AgentStep,
) -> bool:
    if run.replan_count >= run.replan_budget:
        return False
    old_steps = await _steps(db, run.id, current_only=run.plan_version)
    invalidated = _invalidated_steps(old_steps, failed_step)
    await transition_run(db, run, "replanning", actor="observer", detail={"reason": reason})
    next_plan_version = run.plan_version + 1
    try:
        plan, planner_trace = await create_plan(
            registry,
            run.request_text,
            run.goal_id,
            step_budget=run.step_budget,
            version=next_plan_version,
        )
        reusable = _reusable_steps(old_steps, plan, invalidated)
        steps_to_execute = len(plan.steps) - len(reusable)
        if run.steps_consumed + steps_to_execute > run.step_budget:
            raise BudgetExceeded("重新规划所需步骤超过剩余预算")
        if run.tokens_consumed + plan.estimated_tokens > run.token_budget:
            raise BudgetExceeded("重新规划将超过 Token 预算")
    except Exception as exc:
        record_event(
            db,
            run_id=run.id,
            event_type="replan.rejected",
            actor="planner",
            detail={"reason": classify_error(exc).safe_message},
            safe_summary="重新规划未通过预算或结构校验",
        )
        return False
    run.replan_count += 1
    run.plan_version = next_plan_version
    for step in old_steps:
        if step.status not in {"completed", "superseded"}:
            await transition_step(db, step, "superseded", actor="planner")
    run.tokens_consumed += plan.estimated_tokens
    persisted = _add_plan_steps(db, run, plan, registry, reusable=reusable)
    run.plan = [step.model_dump(mode="json") for step in persisted]
    run.objective = plan.objective
    run.plan_history = [
        *(run.plan_history or []),
        _plan_history_entry(plan, persisted, planner_trace, reused=reusable, reason=reason),
    ]
    record_event(
        db,
        run_id=run.id,
        event_type="planner.completed",
        actor="planner",
        detail=planner_trace,
        safe_summary=f"计划 v{plan.version} 已通过服务端校验",
    )
    if planner_trace.get("fallback"):
        record_event(
            db,
            run_id=run.id,
            event_type="planner.fallback",
            actor="planner",
            detail={"reason": planner_trace.get("fallback_reason")},
            safe_summary=f"计划 v{plan.version} 已降级为确定性规划",
        )
    record_event(
        db,
        run_id=run.id,
        event_type="run.replanned",
        actor="planner",
        detail={
            "plan_version": run.plan_version,
            "reason": reason,
            "fallback_reason": planner_trace.get("fallback_reason"),
            "reused_steps": {
                logical_id: source.step_key for logical_id, source in reusable.items()
            },
            "invalidated_steps": sorted(invalidated),
        },
    )
    await db.commit()
    return True


async def advance_run(
    db: AsyncSession,
    *,
    user_id: str,
    run_id: str,
    registry: ToolRegistry | None = None,
    lease_token: str | None = None,
) -> AgentRun:
    tools = registry or build_registry()
    run = await _owned_run(db, user_id, run_id)
    if run.status in {
        "completed",
        "cancelled",
        "rejected",
        "rolled_back",
        "paused",
        "waiting_approval",
    }:
        return run
    if not lease_token:
        lease_token = await claim_run_lease(db, user_id=user_id, run_id=run.id, worker_id="inline")
        run = await _owned_run(db, user_id, run.id)
    if not lease_token or run.lease_token != lease_token or run.status != "executing":
        return run

    while True:
        run = await _owned_run(db, user_id, run.id)
        current = await _steps(db, run.id, current_only=run.plan_version)
        ready, blocked = ready_steps(current)
        for item in blocked:
            await transition_step(
                db, item, "blocked", actor="orchestrator", detail={"reason": "upstream_failed"}
            )
        if blocked:
            await db.commit()
        if not ready:
            if any(item.status in {"blocked", "failed"} for item in current):
                run.error = "上游步骤失败，后续步骤已阻塞"
                record_event(
                    db,
                    run_id=run.id,
                    event_type="run.failed",
                    actor="orchestrator",
                    detail={"reason": "upstream_failed"},
                    safe_summary=run.error,
                )
                await transition_run(
                    db, run, "failed", actor="orchestrator", lease_token=lease_token
                )
                await db.commit()
                return run
            if all(item.status == "completed" for item in current):
                run.current_step = len(current)
                run.result = {
                    "summary": "Agent 已完成分析和获批操作",
                    "last_output": current[-1].output_data if current else None,
                    "undo_available": any(
                        (item.output_data or {}).get("undo_operations") for item in current
                    ),
                }
                await transition_run(
                    db,
                    run,
                    "completed",
                    actor="observer",
                    detail=run.result,
                    lease_token=lease_token,
                )
                record_event(
                    db,
                    run_id=run.id,
                    event_type="run.completed",
                    actor="observer",
                    detail=run.result,
                    safe_summary="Agent 任务已完成",
                )
                await db.commit()
            return run
        step = ready[0]
        step_id = step.id
        started: float | None = None
        try:
            spec = tools.get(step.tool_name)
            _enforce_budget(run)
            if step.status == "pending":
                await transition_step(db, step, "ready", actor="orchestrator")
                await db.commit()
            elif step.status == "retrying" and run.status == "retrying":
                await transition_run(db, run, "executing", actor="observer")
                await db.commit()
            outputs = {item.step_key: item.output_data for item in current}
            payload = resolve_inputs(_plan_step(step), outputs=outputs)
            step.resolved_input_summary = _safe_data_summary(payload)
            if step.requires_approval:
                approval = (
                    await db.execute(
                        select(AgentApproval).where(
                            AgentApproval.run_id == run.id, AgentApproval.step_id == step.id
                        )
                    )
                ).scalar_one_or_none()
                if approval is None:
                    changes = ChangeSet.model_validate(payload.get("change_set", {}))
                    changes.run_id = run.id
                    changes.plan_version = run.plan_version
                    source_ref = (step.input_refs or {}).get("change_set", {})
                    source_step_id = source_ref.get("step_id", step.step_key)
                    for operation in changes.operations:
                        operation.source_step_id = operation.source_step_id or source_step_id
                        operation.idempotency_key = operation.idempotency_key or (
                            f"{run.id}:{changes.version}:{operation.operation_id}"
                        )
                        operation.precondition = operation.precondition or {
                            "before": operation.before
                        }
                        operation.compensation = operation.compensation or {
                            "field": operation.field,
                            "value": operation.before,
                        }
                    payload["change_set"] = changes.model_dump(mode="json")
                    decision = evaluate_policy(
                        spec,
                        role=AgentRole(step.agent_role),
                        change_set=changes,
                        run_kind=run.run_kind,
                    )
                    await transition_step(db, step, "waiting_approval", actor="main_agent")
                    await transition_run(
                        db, run, "waiting_approval", actor="main_agent", lease_token=lease_token
                    )
                    approval = AgentApproval(
                        id=str(uuid.uuid4()),
                        run_id=run.id,
                        step_id=step.id,
                        status="pending",
                        change_set=payload["change_set"],
                        change_hash=change_hash(payload["change_set"]),
                        change_set_version=changes.version,
                        run_state_version=run.state_version,
                        policy_decision=decision.model_dump(mode="json"),
                    )
                    db.add(approval)
                    record_event(
                        db,
                        run_id=run.id,
                        step_id=step.id,
                        event_type="approval.requested",
                        actor="main_agent",
                        detail={
                            "change_hash": approval.change_hash,
                            "change_set_version": changes.version,
                            "risk": decision.risk.value,
                        },
                        safe_summary="有一组变更等待确认",
                    )
                    await db.commit()
                    return run
                if approval.status != "approved":
                    return run
                payload["change_set"] = approval.change_set

            await transition_step(db, step, "running", actor=step.agent_role)
            step.started_at = utc_now()
            step.attempts += 1
            run.current_step = step.step_index
            run.steps_consumed += 1
            record_event(
                db,
                run_id=run.id,
                step_id=step.id,
                event_type="tool.started",
                actor=step.agent_role,
                detail={
                    "tool": spec.name,
                    "effect": spec.effect.value,
                    "rationale": step.rationale,
                },
            )
            await db.commit()
            started = time.monotonic()
            if spec.effect.value in {"write", "destructive", "external"}:
                result = await asyncio.wait_for(
                    execute_change_set(
                        db,
                        registry=tools,
                        spec=spec,
                        run=run,
                        step=step,
                        user_id=user_id,
                        lease_token=lease_token,
                        payload=payload,
                    ),
                    timeout=spec.timeout_seconds,
                )
                activity = None
            elif step.agent_role != AgentRole.MAIN.value:
                result, activity = await asyncio.wait_for(
                    invoke_subagent(
                        db,
                        registry=tools,
                        role=AgentRole(step.agent_role),
                        tool_name=step.tool_name,
                        request=SubAgentRequest(
                            run_id=run.id,
                            objective=run.objective,
                            input_data=payload,
                            allowed_tools=[
                                tool.name
                                for tool in tools.allowed_for_role(AgentRole(step.agent_role))
                            ],
                        ),
                        context=ToolContext(
                            user_id=user_id,
                            run_id=run.id,
                            step_id=step.id,
                            source_step_id=step.step_key,
                            lease_token=lease_token,
                        ),
                    ),
                    timeout=spec.timeout_seconds,
                )
            else:
                result = await asyncio.wait_for(
                    tools.invoke(
                        db,
                        spec,
                        ToolContext(
                            user_id=user_id,
                            run_id=run.id,
                            step_id=step.id,
                            source_step_id=step.step_key,
                            lease_token=lease_token,
                        ),
                        payload,
                    ),
                    timeout=spec.timeout_seconds,
                )
                activity = None
            elapsed = int((time.monotonic() - started) * 1000)
            if not await has_run_lease(db, run_id=run.id, lease_token=lease_token):
                raise LeaseLost("执行租约已失效")
            step.output_data = result
            step.tool_time_ms += elapsed
            step.finished_at = utc_now()
            run.tool_time_consumed_ms += elapsed
            await transition_step(db, step, "completed", actor="observer")
            record_event(
                db,
                run_id=run.id,
                step_id=step.id,
                event_type="tool.completed",
                actor=step.agent_role,
                detail={
                    "tool": spec.name,
                    "duration_ms": elapsed,
                    "data_types_read": activity.data_types_read if activity else [],
                    "data_summary": _safe_data_summary(result),
                    "evidence": [item.model_dump(mode="json") for item in activity.evidence]
                    if activity
                    else [],
                    "conclusions": [item.model_dump(mode="json") for item in activity.conclusions]
                    if activity
                    else [],
                },
                safe_summary=f"{spec.name} 已完成",
            )
            await db.commit()
        except Exception as exc:
            await db.rollback()
            run = await _owned_run(db, user_id, run_id)
            step = (await db.execute(select(AgentStep).where(AgentStep.id == step_id))).scalar_one()
            if started is not None:
                elapsed = int((time.monotonic() - started) * 1000)
                step.tool_time_ms += elapsed
                run.tool_time_consumed_ms += elapsed
            error = classify_error(exc)
            if error.category == ErrorCategory.CANCELLED:
                if run.status == "paused" and step.status == "running":
                    await transition_step(db, step, "retrying", actor="observer")
                    record_event(
                        db,
                        run_id=run.id,
                        step_id=step.id,
                        event_type="tool.interrupted",
                        actor="observer",
                        safe_summary="工具因暂停而中断，可在恢复后重试",
                    )
                    await db.commit()
                elif run.status == "cancelled" and step.status == "running":
                    await transition_step(db, step, "failed", actor="observer")
                    await db.commit()
                else:
                    await db.rollback()
                return run
            step.error = error.safe_message
            step.error_data = error.model_dump(mode="json")
            step.finished_at = utc_now()
            record_event(
                db,
                run_id=run.id,
                step_id=step.id,
                event_type="tool.failed",
                actor="observer",
                detail=error.model_dump(mode="json"),
                safe_summary=error.safe_message,
            )
            if spec.effect.value in {"write", "destructive", "external"}:
                record_event(
                    db,
                    run_id=run.id,
                    step_id=step.id,
                    event_type="executor.failed",
                    actor="observer",
                    detail={"category": error.category.value},
                    safe_summary="安全执行失败，变更已回滚",
                )
            if error.category == ErrorCategory.RETRYABLE and step.attempts <= spec.max_retries:
                await transition_step(db, step, "retrying", actor="observer")
                await transition_run(db, run, "retrying", actor="observer", lease_token=lease_token)
                await db.commit()
                continue
            await transition_step(db, step, "failed", actor="observer")
            run.failure_count += 1
            run.error = error.safe_message
            if (
                error.category == ErrorCategory.RECOVERABLE
                and step.on_failure == "replan"
                and await _replan(db, run, tools, error.safe_message, step)
            ):
                run = await _owned_run(db, user_id, run_id)
                await transition_run(db, run, "executing", actor="planner")
                await db.commit()
                continue
            event_type = (
                "budget.exceeded"
                if error.category == ErrorCategory.BUDGET_EXCEEDED
                else "run.failed"
            )
            record_event(
                db,
                run_id=run.id,
                step_id=step.id,
                event_type=event_type,
                actor="observer",
                detail=error.model_dump(mode="json"),
                safe_summary=error.safe_message,
            )
            await transition_run(db, run, "failed", actor="observer", lease_token=lease_token)
            await db.commit()
            return run


async def approve_run(
    db: AsyncSession,
    *,
    user_id: str,
    run_id: str,
    approval_id: str,
    expected_hash: str,
    change_set_version: int | None = None,
    run_state_version: int | None = None,
    high_risk_confirmed: bool = False,
    auto_advance: bool = True,
) -> tuple[AgentRun, bool]:
    run = await _owned_run(db, user_id, run_id)
    approval = (
        await db.execute(
            select(AgentApproval)
            .where(
                AgentApproval.id == approval_id,
                AgentApproval.run_id == run.id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if not approval or approval.change_hash != expected_hash:
        raise HTTPException(409, "审批已处理或变更预览已变化")
    if approval.status == "approved":
        await db.refresh(run)
        return run, False
    if approval.status != "pending":
        raise HTTPException(409, "审批已处理")
    if change_set_version is not None and change_set_version != approval.change_set_version:
        raise HTTPException(409, "ChangeSet 版本已变化")
    if run_state_version is not None and run_state_version != run.state_version:
        raise HTTPException(409, "Run 状态版本已变化")
    if (approval.policy_decision or {}).get("risk") == "high" and not high_risk_confirmed:
        raise HTTPException(409, "高风险变更需要二次确认")
    approval.status = "approved"
    approval.decided_at = utc_now()
    step = (
        await db.execute(select(AgentStep).where(AgentStep.id == approval.step_id))
    ).scalar_one()
    await transition_step(db, step, "pending", actor="user")
    await transition_run(db, run, "queued", actor="user")
    record_event(
        db,
        run_id=run.id,
        step_id=step.id,
        event_type="approval.approved",
        actor="user",
        detail={
            "change_hash": approval.change_hash,
            "change_set_version": approval.change_set_version,
        },
    )
    await db.commit()
    if auto_advance:
        return await advance_run(db, user_id=user_id, run_id=run.id), True
    return run, True


async def edit_approval(
    db: AsyncSession, *, user_id: str, run_id: str, approval_id: str, change_set: ChangeSet
) -> AgentRun:
    run = await _owned_run(db, user_id, run_id)
    approval = (
        await db.execute(
            select(AgentApproval)
            .where(
                AgentApproval.id == approval_id,
                AgentApproval.run_id == run.id,
                AgentApproval.status == "pending",
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if not approval:
        raise HTTPException(409, "审批已处理或不存在")
    originals = {
        (item["entity"], item["entity_id"], item["field"]): item
        for item in approval.change_set.get("operations", [])
    }
    if len(change_set.operations) > 50 or not {
        (item.entity, item.entity_id, item.field) for item in change_set.operations
    }.issubset(originals):
        raise HTTPException(400, "只能编辑或移除原方案中的变更")
    for item in change_set.operations:
        original = originals[(item.entity, item.entity_id, item.field)]
        if item.before != original.get("before"):
            raise HTTPException(400, "不能修改并发校验所使用的原值")
        if item.field == "__delete__" and item.model_dump(mode="json") != original:
            raise HTTPException(400, "删除操作只能保留或移除")
        if item.field == "scheduled_date":
            try:
                date.fromisoformat(str(item.after))
            except ValueError as exc:
                raise HTTPException(400, "任务日期格式无效") from exc
    change_set.run_id = run.id
    change_set.plan_version = run.plan_version
    change_set.version = approval.change_set_version + 1
    payload = change_set.model_dump(mode="json")
    approval.change_set = payload
    approval.change_set_version = change_set.version
    approval.change_hash = change_hash(payload)
    approval_refs = (
        await db.execute(select(AgentStep.input_refs).where(AgentStep.id == approval.step_id))
    ).scalar_one()
    source_ref = approval_refs.get("change_set")
    if not source_ref:
        raise HTTPException(409, "审批步骤缺少 ChangeSet 来源")
    source_key = source_ref["step_id"]
    source = (
        await db.execute(
            select(AgentStep).where(AgentStep.run_id == run.id, AgentStep.step_key == source_key)
        )
    ).scalar_one_or_none()
    if source:
        source.output_data = payload
    record_event(
        db,
        run_id=run.id,
        step_id=approval.step_id,
        event_type="approval.edited",
        actor="user",
        detail={
            "change_hash": approval.change_hash,
            "change_set_version": approval.change_set_version,
        },
    )
    await db.commit()
    return run


async def reject_run(
    db: AsyncSession, *, user_id: str, run_id: str, approval_id: str, reason: str | None
) -> AgentRun:
    run = await _owned_run(db, user_id, run_id)
    approval = (
        await db.execute(
            select(AgentApproval)
            .where(
                AgentApproval.id == approval_id,
                AgentApproval.run_id == run.id,
                AgentApproval.status == "pending",
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if not approval:
        raise HTTPException(409, "审批已处理或不存在")
    approval.status = "rejected"
    approval.decided_at = utc_now()
    await transition_run(db, run, "rejected", actor="user", detail={"reason": reason})
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
    if run.status in {"completed", "rolled_back"}:
        raise HTTPException(409, "已完成的任务不能取消")
    await transition_run(db, run, "cancelled", actor="user")
    await db.commit()
    return run


async def delete_run(db: AsyncSession, *, user_id: str, run_id: str) -> None:
    run = await _owned_run(db, user_id, run_id)
    if run.status in {"queued", "executing", "retrying", "replanning"}:
        raise HTTPException(409, "执行中的 Agent 任务请先取消，再删除")
    await db.delete(run)
    await db.commit()


async def pause_run(db: AsyncSession, *, user_id: str, run_id: str) -> AgentRun:
    run = await _owned_run(db, user_id, run_id)
    if run.status not in {"queued", "executing"}:
        raise HTTPException(409, "当前状态不能暂停")
    await transition_run(db, run, "paused", actor="user")
    await db.commit()
    return run


async def resume_run(db: AsyncSession, *, user_id: str, run_id: str) -> AgentRun:
    run = await _owned_run(db, user_id, run_id)
    if run.status != "paused":
        raise HTTPException(409, "只有已暂停任务可以继续")
    await transition_run(db, run, "queued", actor="user")
    await db.commit()
    return run


async def retry_run(
    db: AsyncSession, *, user_id: str, run_id: str, auto_advance: bool = True
) -> AgentRun:
    run = await _owned_run(db, user_id, run_id)
    if run.status != "failed" or run.failure_count >= 3:
        raise HTTPException(409, "当前任务不能重试")
    step = (
        await db.execute(
            select(AgentStep).where(
                AgentStep.run_id == run.id,
                AgentStep.plan_version == run.plan_version,
                AgentStep.status == "failed",
            )
        )
    ).scalar_one_or_none()
    if step:
        await transition_step(db, step, "pending", actor="user")
        step.error = None
        step.error_data = None
    run.error = None
    await transition_run(db, run, "queued", actor="user")
    await db.commit()
    return await advance_run(db, user_id=user_id, run_id=run.id) if auto_advance else run


async def undo_run(db: AsyncSession, *, user_id: str, run_id: str) -> AgentRun:
    run = await _owned_run(db, user_id, run_id)
    if run.status != "completed":
        raise HTTPException(409, "只有已完成任务可以撤销")
    step = (
        (
            await db.execute(
                select(AgentStep)
                .where(
                    AgentStep.run_id == run.id,
                    AgentStep.tool_name == "tasks.apply_changes",
                    AgentStep.status == "completed",
                )
                .order_by(AgentStep.plan_version.desc())
            )
        )
        .scalars()
        .first()
    )
    operations = (step.output_data or {}).get("undo_operations", []) if step else []
    if not operations:
        raise HTTPException(409, "此任务没有可撤销变更")
    await transition_run(db, run, "compensating", actor="user")
    try:
        result = await compensate_run(db, run=run, user_id=user_id, operations=operations)
        run.result = {**(run.result or {}), "undo_result": result, "undo_available": False}
        await transition_run(db, run, "rolled_back", actor="observer")
        record_event(
            db,
            run_id=run.id,
            step_id=step.id if step else None,
            event_type="run.rolled_back",
            actor="observer",
            detail=result,
        )
        await db.commit()
        return run
    except Exception as exc:
        await db.rollback()
        run = await _owned_run(db, user_id, run_id)
        if run.status == "completed":
            await transition_run(db, run, "compensating", actor="user")
        run.error = classify_error(exc).safe_message
        await transition_run(db, run, "failed", actor="observer")
        record_event(
            db,
            run_id=run.id,
            event_type="executor.undo_failed",
            actor="observer",
            detail={"error": run.error},
            safe_summary=run.error,
        )
        await db.commit()
        raise


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
                .order_by(AgentAuditEvent.sequence)
            )
        )
        .scalars()
        .all()
    )
    return serialize_run(run, steps, approvals, events)


def _safe_data_summary(value: Any) -> dict[str, Any]:
    if value is None:
        return {"type": "none"}
    if isinstance(value, list):
        return {"type": "list", "count": len(value)}
    if not isinstance(value, dict):
        return {"type": type(value).__name__}
    summary: dict[str, Any] = {"type": "object", "fields": sorted(value)}
    counts = {key: len(item) for key, item in value.items() if isinstance(item, list)}
    if counts:
        summary["counts"] = counts
    if "summary" in value:
        summary["summary"] = str(value["summary"])[:160]
    if isinstance(value.get("operations"), list):
        summary["operation_count"] = len(value["operations"])
    if "completion_rate" in value:
        summary["completion_rate"] = value["completion_rate"]
    return summary


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
        "plan_history": run.plan_history,
        "plan_version": run.plan_version,
        "run_kind": run.run_kind,
        "state_version": run.state_version,
        "status": run.status,
        "current_step": run.current_step,
        "failure_count": run.failure_count,
        "error": run.error,
        "result": run.result,
        "budgets": {
            "steps": {"used": run.steps_consumed, "limit": run.step_budget},
            "tokens": {"used": run.tokens_consumed, "limit": run.token_budget},
            "tool_time_ms": {"used": run.tool_time_consumed_ms, "limit": run.tool_time_budget_ms},
            "replans": {"used": run.replan_count, "limit": run.replan_budget},
        },
        "runtime": {
            "worker_id": run.worker_id,
            "heartbeat_at": run.heartbeat_at.isoformat() if run.heartbeat_at else None,
            "lease_expires_at": run.lease_expires_at.isoformat() if run.lease_expires_at else None,
            "deadline_at": run.deadline_at.isoformat() if run.deadline_at else None,
        },
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "updated_at": run.updated_at.isoformat() if run.updated_at else None,
        "steps": [
            {
                "id": item.id,
                "index": item.step_index,
                "step_key": item.step_key,
                "plan_version": item.plan_version,
                "agent_role": item.agent_role,
                "tool_name": item.tool_name,
                "status": item.status,
                "risk": item.risk,
                "requires_approval": item.requires_approval,
                "input": item.input_data,
                "input_summary": item.resolved_input_summary or _safe_data_summary(item.input_data),
                "input_refs": item.input_refs,
                "depends_on": item.depends_on,
                "rationale": item.rationale,
                "output": item.output_data,
                "output_summary": _safe_data_summary(item.output_data),
                "error": item.error,
                "error_data": item.error_data,
                "attempts": item.attempts,
                "tool_time_ms": item.tool_time_ms,
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
                "change_set_version": item.change_set_version,
                "run_state_version": item.run_state_version,
                "policy_decision": item.policy_decision,
                "created_at": item.created_at.isoformat() if item.created_at else None,
            }
            for item in (approvals or [])
        ],
        "events": [
            {
                "id": item.id,
                "sequence": item.sequence,
                "schema_version": item.schema_version,
                "step_id": item.step_id,
                "type": item.event_type,
                "actor": item.actor,
                "summary": item.safe_summary,
                "detail": item.detail,
                "created_at": item.created_at.isoformat() if item.created_at else None,
            }
            for item in (events or [])
        ],
    }
