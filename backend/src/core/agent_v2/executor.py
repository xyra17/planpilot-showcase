from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.agent_v2.audit import record_event
from src.core.agent_v2.errors import LeaseLost
from src.core.agent_v2.observer import verify_task_changes
from src.core.agent_v2.policy import evaluate_policy
from src.core.agent_v2.registry import ToolRegistry, ToolSpec
from src.core.agent_v2.schemas import (
    AgentRole,
    ChangeSet,
    PolicyOutcome,
    ReviewOutput,
    ToolContext,
)
from src.core.agent_v2.transitions import has_run_lease
from src.models import AgentApproval, AgentRun, AgentStep
from src.services.agent_schedule import undo_task_changes


async def execute_change_set(
    db: AsyncSession,
    *,
    registry: ToolRegistry,
    spec: ToolSpec,
    run: AgentRun,
    step: AgentStep,
    user_id: str,
    lease_token: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    if not await has_run_lease(db, run_id=run.id, lease_token=lease_token):
        raise LeaseLost("执行租约已失效")
    raw_change_set = payload.get("change_set", {})
    change_set = ChangeSet.model_validate(raw_change_set)
    if not payload.get("review"):
        raise HTTPException(409, "变更集缺少风险审查结论")
    review = ReviewOutput.model_validate(payload["review"])
    decision = evaluate_policy(
        spec,
        role=AgentRole.MAIN,
        change_set=change_set,
        review=review,
        run_kind=run.run_kind,
    )
    if decision.outcome == PolicyOutcome.DENY:
        raise HTTPException(403, "; ".join(decision.reasons))
    approval = (
        await db.execute(
            select(AgentApproval).where(
                AgentApproval.run_id == run.id,
                AgentApproval.step_id == step.id,
                AgentApproval.status == "approved",
            )
        )
    ).scalar_one_or_none()
    if decision.outcome == PolicyOutcome.REQUIRE_APPROVAL:
        if not approval:
            raise HTTPException(409, "变更集尚未批准")
        if (
            approval.change_set_version != change_set.version
            or approval.run_state_version > run.state_version
        ):
            raise HTTPException(409, "审批版本已失效")
        from src.core.agent_v2.orchestrator import change_hash, review_hash

        current_change_hash = change_hash(raw_change_set)
        current_review_hash = review_hash(payload["review"])
        if approval.change_hash != current_change_hash:
            raise HTTPException(409, "获批变更与当前变更不一致")
        if (
            approval.reviewed_change_hash != current_change_hash
            or approval.review_hash != current_review_hash
            or approval.review_hash != review_hash(approval.review_snapshot or {})
        ):
            raise HTTPException(409, "风险审查与获批变更不一致，请重新审批")
        approved_policy = approval.policy_decision or {}
        if (
            approved_policy.get("outcome") != decision.outcome.value
            or approved_policy.get("policy_version") != decision.policy_version
            or approved_policy.get("risk") != decision.risk.value
            or approved_policy.get("review_finding_codes", []) != decision.review_finding_codes
        ):
            raise HTTPException(409, "风险审查结论已变化，请重新审批")
    change_set.run_id = run.id
    change_set.plan_version = run.plan_version
    for operation in change_set.operations:
        operation.source_step_id = operation.source_step_id or step.step_key
        operation.idempotency_key = (
            operation.idempotency_key or f"{run.id}:{change_set.version}:{operation.operation_id}"
        )
        operation.precondition = operation.precondition or {"before": operation.before}
        operation.compensation = operation.compensation or {
            "field": operation.field,
            "value": operation.before,
        }
    record_event(
        db,
        run_id=run.id,
        step_id=step.id,
        event_type="executor.started",
        actor="executor",
        detail={
            "change_set_id": change_set.change_set_id,
            "version": change_set.version,
            "policy": decision.model_dump(mode="json"),
        },
    )
    try:
        result = await registry.invoke(
            db,
            spec,
            ToolContext(
                user_id=user_id,
                run_id=run.id,
                step_id=step.id,
                source_step_id=step.step_key,
                lease_token=lease_token,
            ),
            {**payload, "change_set": change_set.model_dump(mode="json")},
        )
        verification = await verify_task_changes(db, user_id, change_set)
        if not verification["verified"]:
            raise RuntimeError("写入后回读验证失败")
        result["verification"] = verification
        result["undo_operations"] = [
            operation.model_dump(mode="json") for operation in change_set.operations
        ]
        record_event(
            db,
            run_id=run.id,
            step_id=step.id,
            event_type="executor.completed",
            actor="observer",
            detail={"change_set_id": change_set.change_set_id, "count": result.get("count", 0)},
        )
        return result
    except Exception:
        await db.rollback()
        raise


async def compensate_run(
    db: AsyncSession, *, run: AgentRun, user_id: str, operations: list[dict[str, Any]]
) -> dict[str, Any]:
    record_event(
        db,
        run_id=run.id,
        event_type="executor.undo_started",
        actor="user",
        detail={"operation_count": len(operations)},
    )
    result = await undo_task_changes(db, user_id, operations, commit=False)
    record_event(
        db, run_id=run.id, event_type="executor.undo_completed", actor="observer", detail=result
    )
    return result
