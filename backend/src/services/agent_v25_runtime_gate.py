from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.core.agent_v2.orchestrator import (
    advance_run,
    approve_run,
    cancel_run,
    edit_approval,
    reject_run,
    undo_run,
)
from src.core.agent_v2.schemas import ChangeSet
from src.core.time import utc_now
from src.models import (
    AgentApproval,
    AgentAuditEvent,
    AgentFeedbackEvent,
    AgentRun,
    Goal,
    InsightActionRun,
    Task,
    User,
)
from src.services.evaluation_v2_service import canonical_hash, load_agent_v25_cases
from src.services.proposal_service import (
    ProposalCreate,
    convert_insight_to_action_run,
    create_proposal,
)
from src.services.workspace_service import ensure_default_workspace

SessionFactory = async_sessionmaker[AsyncSession]


@dataclass(frozen=True)
class RuntimeSeed:
    user_id: str
    goal_id: str
    task_id: str
    task_before: str


@dataclass(frozen=True)
class ApprovalSnapshot:
    run_id: str
    approval_id: str
    change_hash: str
    change_set_version: int
    run_state_version: int
    change_set: dict[str, Any]


async def _seed_account(db: AsyncSession, label: str) -> RuntimeSeed:
    suffix = uuid.uuid4().hex
    user = User(
        email=f"v25-runtime-{label}-{suffix}@test.invalid",
        username=f"v25rt-{suffix[:16]}",
        hashed_password="evaluation-only",
    )
    db.add(user)
    await db.flush()
    await ensure_default_workspace(user, db)
    goal = Goal(
        user_id=user.id,
        type="skill",
        title=f"Runtime Gate {label}",
        deadline=(date.today() + timedelta(days=60)).isoformat(),
        daily_hours=2.0,
    )
    db.add(goal)
    await db.flush()
    task = Task(
        goal_id=goal.id,
        title=f"Runtime task {label}",
        scheduled_date=(date.today() - timedelta(days=2)).isoformat(),
        estimated_mins=30,
    )
    db.add(task)
    await db.flush()
    seed = RuntimeSeed(
        user_id=str(user.id),
        goal_id=str(goal.id),
        task_id=str(task.id),
        task_before=str(task.scheduled_date),
    )
    await db.commit()
    return seed


async def _insight_preview(
    db: AsyncSession, seed: RuntimeSeed, *, days: int = 3
) -> ApprovalSnapshot:
    proposal = await create_proposal(
        seed.user_id,
        ProposalCreate(
            goal_id=seed.goal_id,
            proposal_type="reschedule_overdue_tasks",
            title=f"Runtime safety {uuid.uuid4().hex[:8]}",
            reasoning=["Agent V2.5 runtime safety gate"],
            proposed_changes={
                "task_updates": [
                    {
                        "task_id": seed.task_id,
                        "scheduled_date": (date.today() + timedelta(days=days)).isoformat(),
                    }
                ]
            },
            confidence=0.8,
        ),
        db,
    )
    detail = await convert_insight_to_action_run(seed.user_id, proposal["id"], db)
    run_id = str(detail["id"])
    await advance_run(db, user_id=seed.user_id, run_id=run_id)
    approval = (
        await db.execute(select(AgentApproval).where(AgentApproval.run_id == run_id))
    ).scalar_one()
    return ApprovalSnapshot(
        run_id=run_id,
        approval_id=str(approval.id),
        change_hash=str(approval.change_hash),
        change_set_version=int(approval.change_set_version),
        run_state_version=int(approval.run_state_version),
        change_set=dict(approval.change_set),
    )


async def _facts(db: AsyncSession, *, run_id: str, task_id: str, before: str) -> dict[str, Any]:
    run = await db.get(AgentRun, run_id)
    task = await db.get(Task, task_id)
    link = await db.scalar(select(InsightActionRun).where(InsightActionRun.run_id == run_id))
    audit_count = await db.scalar(
        select(func.count()).select_from(AgentAuditEvent).where(AgentAuditEvent.run_id == run_id)
    )
    feedback_count = await db.scalar(
        select(func.count())
        .select_from(AgentFeedbackEvent)
        .where(AgentFeedbackEvent.run_id == run_id)
    )
    completed_events = await db.scalar(
        select(func.count())
        .select_from(AgentAuditEvent)
        .where(
            AgentAuditEvent.run_id == run_id,
            AgentAuditEvent.event_type == "executor.completed",
        )
    )
    return {
        "writes": int(task is not None and task.scheduled_date != before),
        "terminal": run.status if run else None,
        "link_status": link.status if link else None,
        "active_links": int(bool(link and link.is_active)),
        "audit_count": int(audit_count or 0),
        "feedback_count": int(feedback_count or 0),
        "executor_completed_events": int(completed_events or 0),
    }


async def _approve(
    db: AsyncSession, user_id: str, approval: ApprovalSnapshot
) -> tuple[AgentRun, bool]:
    return await approve_run(
        db,
        user_id=user_id,
        run_id=approval.run_id,
        approval_id=approval.approval_id,
        expected_hash=approval.change_hash,
        change_set_version=approval.change_set_version,
        run_state_version=approval.run_state_version,
        high_risk_confirmed=True,
        auto_advance=False,
    )


async def _evaluate_lifecycle_case(factory: SessionFactory, case: dict[str, Any]) -> dict[str, Any]:
    category = case["category"]
    async with factory() as db:
        seed = await _seed_account(db, category)
        intruder_user_id: str | None = None
        ownership_denied = True
        if category == "cross_user":
            intruder_user_id = (await _seed_account(db, "intruder")).user_id
        approval = await _insight_preview(db, seed)

        if category == "unconfirmed_write":
            await advance_run(db, user_id=seed.user_id, run_id=approval.run_id)
        elif category == "cross_user":
            try:
                await _approve(db, str(intruder_user_id), approval)
            except HTTPException:
                await db.rollback()
            else:
                ownership_denied = False
        elif category == "expired_changeset":
            edited = ChangeSet.model_validate(approval.change_set)
            edited.operations[0].after = (date.today() + timedelta(days=4)).isoformat()
            await edit_approval(
                db,
                user_id=seed.user_id,
                run_id=approval.run_id,
                approval_id=approval.approval_id,
                change_set=edited,
            )
            try:
                await approve_run(
                    db,
                    user_id=seed.user_id,
                    run_id=approval.run_id,
                    approval_id=approval.approval_id,
                    expected_hash=approval.change_hash,
                    change_set_version=approval.change_set_version,
                    run_state_version=approval.run_state_version,
                    auto_advance=False,
                )
            except HTTPException:
                await db.rollback()
        elif category == "rejected":
            await reject_run(
                db,
                user_id=seed.user_id,
                run_id=approval.run_id,
                approval_id=approval.approval_id,
                reason="runtime gate rejection",
            )
        elif category == "cancelled":
            await cancel_run(db, user_id=seed.user_id, run_id=approval.run_id)
        elif category == "failed":
            await _approve(db, seed.user_id, approval)
            stored = await db.get(AgentRun, approval.run_id)
            stored.deadline_at = utc_now() - timedelta(seconds=1)
            await db.commit()
            await advance_run(db, user_id=seed.user_id, run_id=approval.run_id)
        else:
            await _approve(db, seed.user_id, approval)
            await advance_run(db, user_id=seed.user_id, run_id=approval.run_id)
            if category == "rollback":
                await undo_run(db, user_id=seed.user_id, run_id=approval.run_id)

        actual = await _facts(
            db,
            run_id=approval.run_id,
            task_id=seed.task_id,
            before=seed.task_before,
        )
        if category == "duplicate_write":
            _, dispatched_again = await _approve(db, seed.user_id, approval)
            actual = await _facts(
                db,
                run_id=approval.run_id,
                task_id=seed.task_id,
                before=seed.task_before,
            )
            actual["duplicate_dispatch"] = int(dispatched_again)
        actual["ownership_blocked"] = category != "cross_user" or ownership_denied
        owner = await db.get(User, seed.user_id)
        if owner is not None:
            await db.delete(owner)
        if intruder_user_id is not None:
            intruder = await db.get(User, intruder_user_id)
            if intruder is not None:
                await db.delete(intruder)
        await db.commit()
        return actual


async def _evaluate_concurrency_case(factory: SessionFactory) -> dict[str, Any]:
    async with factory() as db:
        seed = await _seed_account(db, "concurrency")
        proposal = await create_proposal(
            seed.user_id,
            ProposalCreate(
                goal_id=seed.goal_id,
                proposal_type="reschedule_overdue_tasks",
                title="20 concurrent conversions",
                reasoning=["database uniqueness check"],
                proposed_changes={
                    "task_updates": [
                        {
                            "task_id": seed.task_id,
                            "scheduled_date": (date.today() + timedelta(days=2)).isoformat(),
                        }
                    ]
                },
                confidence=0.8,
            ),
            db,
        )
        proposal_id = proposal["id"]
        user_id = seed.user_id

    async def convert() -> str:
        async with factory() as session:
            detail = await convert_insight_to_action_run(user_id, proposal_id, session)
            return detail["id"]

    run_ids = await asyncio.gather(*(convert() for _ in range(20)))
    async with factory() as db:
        active = list(
            (
                await db.execute(
                    select(InsightActionRun).where(
                        InsightActionRun.insight_id == proposal_id,
                        InsightActionRun.is_active.is_(True),
                    )
                )
            ).scalars()
        )
        actual = {
            "attempts": 20,
            "active_runs": len(active),
            "unique_run_ids": len(set(run_ids)),
        }
        owner = await db.get(User, user_id)
        if owner is not None:
            await db.delete(owner)
            await db.commit()
        return actual


async def _evaluate_worker_interrupt(factory: SessionFactory) -> dict[str, Any]:
    from src.core.agent_v2.transitions import claim_run_lease
    from src.models import AgentStep
    from src.tasks import agent_runs

    async with factory() as db:
        seed = await _seed_account(db, "worker_interrupt")
        approval = await _insight_preview(db, seed)
        # Return the preview Run to a queued state, then emulate a worker dying
        # after claiming the durable lease but before a write step can execute.
        run = await db.get(AgentRun, approval.run_id)
        run.status = "queued"
        await db.commit()
        token = await claim_run_lease(
            db,
            user_id=seed.user_id,
            run_id=approval.run_id,
            worker_id="runtime-gate",
            lease_seconds=30,
        )
        stored = await db.get(AgentRun, approval.run_id)
        step = await db.scalar(
            select(AgentStep)
            .where(AgentStep.run_id == approval.run_id, AgentStep.status == "pending")
            .order_by(AgentStep.step_index)
        )
        if step:
            step.status = "running"
        stored.lease_expires_at = utc_now() - timedelta(seconds=1)
        await db.commit()

    recovered = await agent_runs._recover()
    async with factory() as db:
        actual = await _facts(
            db,
            run_id=approval.run_id,
            task_id=seed.task_id,
            before=seed.task_before,
        )
        stored = await db.get(AgentRun, approval.run_id)
        actual.update(
            {
                "recovered": recovered["recovered"] >= 1,
                "terminal": stored.status,
                "lease_released": stored.lease_token is None,
                "claim_created": token is not None,
            }
        )
        owner = await db.get(User, seed.user_id)
        if owner is not None:
            await db.delete(owner)
            await db.commit()
        return actual


def _case_passed(actual: dict[str, Any], case: dict[str, Any]) -> bool:
    expected = case["expected"]
    expected_matches = all(actual.get(key) == value for key, value in expected.items())
    checks = {
        "unconfirmed_write_forbidden": actual.get("writes") == 0,
        "cross_user_access_forbidden": actual.get("ownership_blocked") is True
        and actual.get("writes") == 0,
        "duplicate_write_forbidden": actual.get("executor_completed_events") == 1
        and actual.get("duplicate_dispatch") == 0,
        "stale_review_forbidden": actual.get("writes") == 0,
        "worker_recovery": actual.get("recovered") is True and actual.get("lease_released") is True,
        "lifecycle_feedback": actual.get("feedback_count", 0) > 0,
        "compensation_restores_before": actual.get("writes") == 0,
        "single_active_run": actual.get("active_runs") == 1 and actual.get("unique_run_ids") == 1,
        "approved_write_once": actual.get("writes") == 1
        and actual.get("executor_completed_events") == 1,
    }
    return expected_matches and all(
        checks.get(assertion, False) for assertion in case.get("assertions") or []
    )


async def evaluate_agent_v25_runtime_gate(
    factory: SessionFactory,
    *,
    case_runner: Callable[[SessionFactory, dict[str, Any]], Any] | None = None,
) -> dict[str, Any]:
    """Execute the frozen runtime suite through real production paths and database facts."""
    cases = load_agent_v25_cases()["action-runtime-safety-v1"]
    failures: list[dict[str, Any]] = []
    results: dict[str, dict[str, Any]] = {}
    runner = case_runner or _evaluate_lifecycle_case
    for case in cases:
        if case["category"] == "concurrency":
            actual = await _evaluate_concurrency_case(factory)
        elif case["category"] == "worker_interrupt":
            actual = await _evaluate_worker_interrupt(factory)
        else:
            actual = await runner(factory, case)
        passed = _case_passed(actual, case)
        results[case["id"]] = {"passed": passed, "actual": actual}
        if not passed:
            failures.append({"case": case["id"], "actual": actual})

    unconfirmed = results["unconfirmed-write-01"]["actual"]["writes"]
    cross_user = results["cross-user-01"]["actual"]["writes"]
    duplicate = max(
        0,
        results["duplicate-approval-01"]["actual"]["executor_completed_events"] - 1,
    )
    critical_passed = sum(int(item["passed"]) for item in results.values())
    metrics = {
        "total": len(cases),
        "passed": critical_passed,
        "critical_safety_pass_rate": critical_passed / len(cases),
        "unconfirmed_write_violations": unconfirmed,
        "cross_user_write_violations": cross_user,
        "duplicate_write_violations": duplicate,
        "content_hash": canonical_hash(cases),
    }
    hard_passed = (
        not failures
        and unconfirmed == 0
        and cross_user == 0
        and duplicate == 0
        and metrics["critical_safety_pass_rate"] == 1.0
    )
    return {
        "status": "passed" if hard_passed else "failed",
        "metrics": metrics,
        "failures": failures,
        "results": results,
    }
