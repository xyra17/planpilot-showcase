"""Phase 6 offline gate, gateway, canary and calibration tests."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import func, select

from src.core.model_gateway import ModelGateway, reset_gateway_state
from src.core.time import local_midnight_as_utc, utc_now
from src.models import (
    AgentTraceSpan,
    CanaryObservation,
    EvaluationCase,
    Goal,
    PredictionObservation,
    Task,
    User,
)
from src.services import (
    agent_control_service,
    calibration_service,
    canary_observation_service,
    canary_service,
)


async def _valid_imported_runtime_gate(_db):
    return {
        "id": "isolated-proof",
        "status": "valid",
        "valid": True,
        "blockers": [],
        "dataset_hash": "isolated-runtime-dataset",
        "critical_safety_pass_rate": 1.0,
    }


@pytest.mark.asyncio
async def test_model_gateway_retries_timeout_then_uses_fallback():
    await reset_gateway_state()
    primary = SimpleNamespace(
        ainvoke=AsyncMock(side_effect=[TimeoutError("slow"), TimeoutError("slow")])
    )
    expected = SimpleNamespace(content='{"ok": true}')
    fallback = SimpleNamespace(ainvoke=AsyncMock(return_value=expected))

    result = await ModelGateway.invoke(
        ["safe-message"],
        primary=primary,
        primary_route="smart:deepseek-test",
        timeout_seconds=0.05,
        max_retries=1,
        fallback_factory=lambda: fallback,
    )

    assert result.response is expected
    assert result.fallback_used is True
    assert [row.outcome for row in result.attempts] == ["failure", "failure", "success"]
    assert all("safe-message" not in str(row.to_dict()) for row in result.attempts)


@pytest.mark.asyncio
async def test_production_gate_has_104_cases_and_is_auditable(
    client, auth, goal_id, db, monkeypatch
):
    monkeypatch.setattr(
        "src.services.beta_evidence_service.runtime_gate_status",
        _valid_imported_runtime_gate,
    )
    goal = await db.get(Goal, goal_id)
    user = await db.get(User, goal.user_id)
    user.is_admin = True
    await db.commit()

    response = await client.post("/api/v1/agent-control/offline-gates/run", headers=auth)

    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["status"] == "passed"
    assert payload["metrics"]["total"] == 104
    assert payload["metrics"]["pass_rate"] >= 0.98
    assert payload["metrics"]["safety_pass_rate"] == 1.0
    assert set(payload["metrics"]["categories"]) == {
        "cold_start",
        "long_term_user",
        "low_completion",
        "high_delay",
        "agent_recovery",
        "tool_failure",
        "model_timeout",
        "safety_violation",
    }
    count = int(
        await db.scalar(
            select(func.count())
            .select_from(EvaluationCase)
            .where(EvaluationCase.dataset_id == payload["run"]["dataset_id"])
        )
        or 0
    )
    assert count == 104


@pytest.mark.asyncio
async def test_canary_is_offline_gated_internal_first_and_advances(
    client, auth, goal_id, db, monkeypatch
):
    monkeypatch.setattr(
        "src.services.beta_evidence_service.runtime_gate_status",
        _valid_imported_runtime_gate,
    )
    goal = await db.get(Goal, goal_id)
    admin = await db.get(User, goal.user_id)
    admin.is_admin = True
    outsider = User(
        email=f"outside-{uuid.uuid4().hex}@test.com",
        username=f"outside-{uuid.uuid4().hex[:12]}",
        hashed_password="not-used",
    )
    db.add(outsider)
    await db.commit()
    gate_response = await client.post("/api/v1/agent-control/offline-gates/run", headers=auth)
    assert gate_response.status_code == 201
    gate = gate_response.json()
    runtime = await agent_control_service.ensure_baseline(db)

    created = await canary_service.create_coach_canary(
        db,
        actor=admin.id,
        name=f"coach-canary-{uuid.uuid4().hex}",
        hypothesis="候选策略在不降低安全性的前提下提升完成率",
        offline_gate_id=gate["id"],
        prompt_version_id=runtime.prompt.id,
        model_config_id=runtime.model.id,
        policy_version_id=runtime.policy.id,
    )
    assert created["current_stage"] == "internal"
    assert created["traffic_percent"] == 0.0

    outside_runtime = await agent_control_service.resolve_runtime(db, user_id=outsider.id)
    assert outside_runtime.experiment is None
    internal_runtime = await agent_control_service.resolve_runtime(db, user_id=admin.id)
    assert internal_runtime.experiment is not None
    trace_id = uuid.uuid4().hex
    invocation = await agent_control_service.record_invocation(
        db,
        runtime=internal_runtime,
        user_id=admin.id,
        goal_id=goal.id,
        context={"profile": {}},
        output={"proposal_type": "learning_nudge"},
        trace={
            "trace_id": trace_id,
            "latency_ms": 12,
            "success": True,
            "fallback": False,
            "gateway_attempts": [
                {
                    "route": "test:coach",
                    "attempt": 1,
                    "outcome": "success",
                    "latency_ms": 8,
                }
            ],
        },
    )
    await db.commit()
    assert invocation.experiment_id == created["experiment_id"]
    spans = list(
        (
            await db.execute(select(AgentTraceSpan).where(AgentTraceSpan.trace_id == trace_id))
        ).scalars()
    )
    assert {span.name for span in spans} >= {
        "coach_agent_run",
        "retrieve_decision_context",
        "model_call",
        "create_proposal",
    }
    assert await canary_observation_service.normalize_canary_observations(db) == 1
    assert await canary_observation_service.normalize_canary_observations(db) == 0
    observation = await db.scalar(
        select(CanaryObservation).where(CanaryObservation.agent_invocation_id == invocation.id)
    )
    assert observation is not None
    assert observation.observation_type == "exposure"

    paused = await canary_service.pause_canary(db, created["id"], admin.id, "暂停观察真实指标")
    assert paused["status"] == "paused"
    resumed = await canary_service.resume_canary(db, created["id"], admin.id)
    assert resumed["status"] == "running"
    assert resumed["current_stage"] == "internal"
    assert resumed["transitions"][0]["action"] == "resumed"

    advanced = await canary_service.advance_canary(db, created["id"], admin.id)
    assert advanced["current_stage"] == "1"
    assert advanced["traffic_percent"] == 1.0
    rolled_back = await canary_service.rollback_canary(
        db, created["id"], admin.id, "Phase 6 自动化回滚演练"
    )
    assert rolled_back["status"] == "rolled_back"
    assert rolled_back["transitions"][0]["action"] == "rolled_back"


@pytest.mark.asyncio
async def test_prediction_outcome_and_calibration_are_tracked(db):
    user = User(
        email=f"calibration-{uuid.uuid4().hex}@test.com",
        username=f"calibration-{uuid.uuid4().hex[:12]}",
        hashed_password="not-used",
    )
    db.add(user)
    await db.flush()
    goal = Goal(
        user_id=user.id,
        type="skill",
        title="校准测试",
        deadline=date.today().isoformat(),
        daily_hours=1,
    )
    db.add(goal)
    await db.flush()
    task = Task(
        goal_id=goal.id,
        title="已完成任务",
        scheduled_date=(date.today() - timedelta(days=1)).isoformat(),
        estimated_mins=30,
        status="pending",
    )
    db.add(task)
    await db.flush()
    await calibration_service.record_task_failure_prediction(
        db,
        user_id=user.id,
        goal_id=goal.id,
        task=task,
        probability=0.25,
        features={"completion_rate": 0.8},
        predicted_at=utc_now() - timedelta(days=1, hours=1),
    )
    task.status = "completed"
    task.completed_at = utc_now() - timedelta(days=1)
    await db.commit()

    assert await calibration_service.capture_actual_outcomes(db) >= 1
    report = await calibration_service.calculate_calibration(db)
    assert report["outcome_count"] >= 1
    assert report["brier_score"] is not None
    observation = await db.scalar(
        select(PredictionObservation).where(PredictionObservation.task_id == task.id)
    )
    assert observation.actual_outcome is False
    assert observation.feature_snapshot == {"completion_rate": 0.8}
    expected_due_date = date.fromisoformat(task.scheduled_date) + timedelta(days=1)
    assert observation.outcome_due_at == local_midnight_as_utc(
        expected_due_date, user.timezone
    )
