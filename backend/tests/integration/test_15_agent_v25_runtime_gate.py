from unittest.mock import patch

import pytest
from sqlalchemy import select

import src.database as database
from src.core.agent_v2 import orchestrator
from src.core.agent_v2.audit import record_event
from src.models import AgentApproval, AgentRun, EvaluationCase, EvaluationResult, Task
from src.services import agent_v25_runtime_gate as runtime_gate
from src.services.evaluation_v2_service import (
    load_agent_v25_cases,
    run_agent_v25_runtime_gate,
)

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_agent_v25_runtime_gate_uses_real_postgresql_facts(setup_db):
    async with database.AsyncSessionLocal() as db:
        result = await run_agent_v25_runtime_gate(db, "postgresql-ci")

    assert result["status"] == "passed", result["failures"]
    assert result["metrics"]["unconfirmed_write_violations"] == 0
    assert result["metrics"]["cross_user_write_violations"] == 0
    assert result["metrics"]["duplicate_write_violations"] == 0
    assert result["metrics"]["critical_safety_pass_rate"] == 1.0
    async with database.AsyncSessionLocal() as db:
        concurrency = (
            await db.execute(
                select(EvaluationResult.actual_output)
                .join(EvaluationCase, EvaluationCase.id == EvaluationResult.case_id)
                .where(
                    EvaluationResult.evaluation_run_id == result["evaluation_run_id"],
                    EvaluationCase.case_key == "concurrent-conversion-01",
                )
            )
        ).scalar_one()
    assert concurrency == {"attempts": 20, "active_runs": 1, "unique_run_ids": 1}


@pytest.mark.asyncio
async def test_runtime_gate_turns_red_when_ownership_guard_is_mutated(setup_db):
    async def insecure_owned_run(db, _user_id: str, run_id: str):
        return (await db.execute(select(AgentRun).where(AgentRun.id == run_id))).scalar_one()

    with patch.object(orchestrator, "_owned_run", insecure_owned_run):
        result = await runtime_gate.evaluate_agent_v25_runtime_gate(database.AsyncSessionLocal)

    assert result["status"] == "failed"
    assert any(item["case"] == "cross-user-01" for item in result["failures"])


@pytest.mark.asyncio
async def test_unconfirmed_case_turns_red_when_approval_guard_is_mutated(setup_db):
    case = next(
        item
        for item in load_agent_v25_cases()["action-runtime-safety-v1"]
        if item["id"] == "unconfirmed-write-01"
    )
    production_advance = runtime_gate.advance_run

    async def unsafe_advance(db, *, user_id: str, run_id: str, **kwargs):
        approval = await db.scalar(select(AgentApproval).where(AgentApproval.run_id == run_id))
        if approval is None:
            return await production_advance(db, user_id=user_id, run_id=run_id, **kwargs)
        operation = approval.change_set["operations"][0]
        task = await db.get(Task, operation["entity_id"])
        task.scheduled_date = operation["after"]
        await db.commit()
        return await db.get(AgentRun, run_id)

    with patch.object(runtime_gate, "advance_run", unsafe_advance):
        actual = await runtime_gate._evaluate_lifecycle_case(database.AsyncSessionLocal, case)

    assert runtime_gate._case_passed(actual, case) is False
    assert actual["writes"] == 1


@pytest.mark.asyncio
async def test_duplicate_case_turns_red_when_idempotency_is_mutated(setup_db):
    case = next(
        item
        for item in load_agent_v25_cases()["action-runtime-safety-v1"]
        if item["id"] == "duplicate-approval-01"
    )
    production_approve = runtime_gate._approve

    async def unsafe_approve(db, user_id, approval):
        result = await production_approve(db, user_id, approval)
        if result[1] is False:
            record_event(
                db,
                run_id=approval.run_id,
                event_type="executor.completed",
                actor="mutated-idempotency-guard",
                detail={"unsafe_duplicate": True},
            )
            await db.commit()
        return result

    with patch.object(runtime_gate, "_approve", unsafe_approve):
        actual = await runtime_gate._evaluate_lifecycle_case(database.AsyncSessionLocal, case)

    assert runtime_gate._case_passed(actual, case) is False
    assert actual["executor_completed_events"] == 2
