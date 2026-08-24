"""Phase 5 production Agent versioning, evaluation, experiment and learning tests."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select

from src.config import settings
from src.core.time import utc_now
from src.models import (
    AgentFeedbackEvent,
    AgentInvocation,
    EvaluationCase,
    ExperimentAssignment,
    ExperimentExposure,
    Goal,
    LearningEvent,
    User,
    UserDataConsent,
)
from src.services import (
    agent_control_service,
    experiment_service,
    feedback_learning_service,
    monitoring_service,
)


@pytest.mark.asyncio
async def test_admin_control_api_and_versioned_evaluation(client, auth, goal_id, db):
    forbidden = await client.get("/api/v1/agent-control/versions", headers=auth)
    assert forbidden.status_code == 403
    audit_forbidden = await client.get("/api/v1/agent-control/admin/invocations", headers=auth)
    assert audit_forbidden.status_code == 403
    product_forbidden = await client.get(
        "/api/v1/agent-control/admin/product-validation/latest", headers=auth
    )
    assert product_forbidden.status_code == 403

    goal = await db.get(Goal, goal_id)
    user = await db.get(User, goal.user_id)
    user.is_admin = True
    await db.commit()

    audit = await client.get("/api/v1/agent-control/admin/invocations", headers=auth)
    assert audit.status_code == 200, audit.text
    assert isinstance(audit.json(), list)

    versions = await client.get("/api/v1/agent-control/versions", headers=auth)
    assert versions.status_code == 200, versions.text
    payload = versions.json()
    assert payload["prompts"][0]["status"] == "approved"
    assert payload["models"][0]["status"] == "approved"
    assert payload["policies"][0]["rules"]["require_user_confirmation"] is True

    evaluated = await client.post("/api/v1/agent-control/evaluations/run", headers=auth)
    assert evaluated.status_code == 201, evaluated.text
    assert evaluated.json()["summary_metrics"]["total"] == 20
    assert evaluated.json()["summary_metrics"]["safety_pass_rate"] == 1.0
    case_count = int(await db.scalar(select(func.count()).select_from(EvaluationCase)) or 0)
    assert case_count >= 20

    core_reports = await client.post(
        "/api/v1/agent-control/learning-experiments/run",
        headers=auth,
        json={"window_days": 90},
    )
    assert core_reports.status_code == 201, core_reports.text
    assert len(core_reports.json()["reports"]) == 4
    history = await client.get("/api/v1/agent-control/learning-experiments/reports", headers=auth)
    assert history.status_code == 200
    assert len(history.json()) >= 4

    readiness = await client.post(
        "/api/v1/agent-control/production-readiness/evaluate",
        headers=auth,
        json={"window_days": 90},
    )
    assert readiness.status_code == 201, readiness.text
    assert readiness.json()["decision"] == "hold"
    assert "canary_missing" in readiness.json()["reason_codes"]
    decisions = await client.get(
        "/api/v1/agent-control/production-readiness/decisions", headers=auth
    )
    assert decisions.status_code == 200
    assert decisions.json()[0]["decision"] == "hold"
    product_latest = await client.get(
        "/api/v1/agent-control/admin/product-validation/latest", headers=auth
    )
    assert product_latest.status_code == 200
    assert product_latest.json()["schema_version"] == "product-validation-v2"
    product_history = await client.get(
        "/api/v1/agent-control/admin/product-validation/history?limit=5", headers=auth
    )
    assert product_history.status_code == 200
    assert product_history.json()[0]["snapshot_id"]


@pytest.mark.asyncio
async def test_experiment_assignment_is_stable_and_exposure_is_recorded(db):
    runtime = await agent_control_service.ensure_baseline(db)
    user = User(
        email=f"phase5-{uuid.uuid4().hex}@test.com",
        username=f"phase5-{uuid.uuid4().hex[:12]}",
        hashed_password="not-used",
    )
    db.add(user)
    await db.flush()
    db.add(UserDataConsent(user_id=user.id, experiments_enabled=True))
    await db.commit()

    experiment = await experiment_service.create_experiment(
        db,
        created_by="test-admin",
        name=f"coach-strategy-{uuid.uuid4().hex}",
        hypothesis="版本化建议可以提升用户接受率",
        allocation_percent=100,
        primary_metric="accept_rate",
        variants=[
            {
                "key": "control",
                "display_name": "稳定策略",
                "traffic_weight": 0.5,
                "prompt_version_id": runtime.prompt.id,
                "model_config_id": runtime.model.id,
                "policy_version_id": runtime.policy.id,
                "is_control": True,
            },
            {
                "key": "candidate",
                "display_name": "候选策略",
                "traffic_weight": 0.5,
                "prompt_version_id": runtime.prompt.id,
                "model_config_id": runtime.model.id,
                "policy_version_id": runtime.policy.id,
                "is_control": False,
            },
        ],
    )
    await experiment_service.transition_experiment(db, experiment["id"], "approved", "admin")
    await experiment_service.transition_experiment(db, experiment["id"], "running", "admin")

    first = await agent_control_service.resolve_runtime(db, user_id=user.id)
    second = await agent_control_service.resolve_runtime(db, user_id=user.id)
    assert first.assignment is not None
    assert second.assignment is not None
    assert first.assignment.variant_id == second.assignment.variant_id
    invocation = await agent_control_service.record_invocation(
        db,
        runtime=first,
        user_id=user.id,
        goal_id=None,
        context={"profile": {"completion_rate_30d": 0.5}},
        output={"proposal_type": "learning_nudge"},
        trace={
            "trace_id": uuid.uuid4().hex,
            "latency_ms": 12,
            "fallback": False,
            "prompt_render_hash": "a" * 64,
            "token_usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
        },
    )
    await db.commit()
    exposure = await db.scalar(
        select(ExperimentExposure).where(ExperimentExposure.agent_invocation_id == invocation.id)
    )
    assignments = int(
        await db.scalar(
            select(func.count())
            .select_from(ExperimentAssignment)
            .where(
                ExperimentAssignment.experiment_id == experiment["id"],
                ExperimentAssignment.user_id == user.id,
            )
        )
        or 0
    )
    assert exposure is not None
    assert assignments == 1
    await experiment_service.transition_experiment(db, experiment["id"], "completed", "admin")


@pytest.mark.asyncio
async def test_feedback_normalization_is_append_only_and_idempotent(db):
    user = User(
        email=f"feedback-{uuid.uuid4().hex}@test.com",
        username=f"feedback-{uuid.uuid4().hex[:12]}",
        hashed_password="not-used",
    )
    db.add(user)
    await db.flush()
    event = LearningEvent(
        user_id=user.id,
        goal_id=None,
        aggregate_type="proposal",
        aggregate_id=str(uuid.uuid4()),
        event_type="ProposalRejected",
        source="user_action",
        payload={"reason": "当前建议不适合我的日程"},
        occurred_at=utc_now(),
        version=1,
    )
    db.add(event)
    await db.commit()

    await feedback_learning_service.normalize_learning_events(db)
    await feedback_learning_service.normalize_learning_events(db)
    rows = list(
        (
            await db.execute(
                select(AgentFeedbackEvent).where(AgentFeedbackEvent.source_event_id == event.id)
            )
        ).scalars()
    )
    assert len(rows) == 1
    assert rows[0].feedback_type == "proposal_rejected"
    assert rows[0].reason == "当前建议不适合我的日程"


@pytest.mark.asyncio
async def test_daily_monitoring_and_safe_rollback(db):
    baseline = await agent_control_service.ensure_baseline(db, environment=settings.environment)
    deployed = await agent_control_service.deploy_versions(
        db,
        actor="admin",
        agent_type="coach",
        environment=settings.environment,
        prompt_version_id=baseline.prompt.id,
        model_config_id=baseline.model.id,
        policy_version_id=baseline.policy.id,
    )
    aggregate = await monitoring_service.aggregate_daily_metrics(db)
    assert aggregate["health_status"] in {"healthy", "warning", "critical"}
    assert "success_rate" in aggregate["metrics"]

    rollback = await monitoring_service.rollback_deployment(
        db,
        target_deployment_id=baseline.deployment.id,
        actor="admin",
        reason="Phase 5 回滚演练",
    )
    assert rollback["status"] == "active"
    assert rollback["revision"] > deployed["revision"]
    active = await agent_control_service.ensure_baseline(db, environment=settings.environment)
    assert active.deployment.id == rollback["deployment_id"]


@pytest.mark.asyncio
async def test_runtime_overview_only_returns_current_users_invocations(db):
    user = User(
        email=f"overview-{uuid.uuid4().hex}@test.com",
        username=f"overview-{uuid.uuid4().hex[:12]}",
        hashed_password="not-used",
    )
    db.add(user)
    await db.commit()
    overview = await agent_control_service.runtime_overview(db, user.id)
    assert overview["safety"] == {
        "requires_user_confirmation": True,
        "direct_mutation_allowed": False,
    }
    assert overview["model_roles"]["interactive"]["primary_model"] == settings.model_name
    assert overview["model_roles"]["structured"]["primary_model"] == settings.smart_model_name
    assert overview["model_roles"]["critical"]["fallback"] is None
    assert overview["model_roles"]["embedding"]["primary_model"] == settings.embedding_model_name
    count = int(
        await db.scalar(
            select(func.count())
            .select_from(AgentInvocation)
            .where(AgentInvocation.user_id == user.id)
        )
        or 0
    )
    assert overview["metrics"]["invocation_count"] == count
