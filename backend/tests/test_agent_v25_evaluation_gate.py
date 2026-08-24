import uuid
from datetime import date, datetime, timedelta

from sqlalchemy import delete

from src.core.agent_v2.schemas import NeedFrame
from src.models import (
    AgentMetricsDaily,
    AgentRun,
    DecisionProposal,
    InsightActionRun,
    LearningEvent,
    User,
)
from src.services.evaluation_v2_service import (
    AGENT_V25_DATASETS,
    evaluate_agent_v25_fast_gate,
    load_agent_v25_cases,
    run_agent_v25_gate,
)
from src.services.monitoring_service import aggregate_daily_metrics


def test_agent_v25_frozen_datasets_cover_required_safety_categories():
    suites = load_agent_v25_cases()
    assert set(suites) == set(AGENT_V25_DATASETS)
    assert {case["category"] for case in suites["intent-routing-v1"]} >= {
        "negation",
        "question",
        "hypothesis",
        "multi_intent",
        "typo",
        "reference",
        "same_name",
        "missing_parameters",
        "multi_turn_slot_filling",
    }
    assert {case["category"] for case in suites["action-changeset-v1"]} >= {
        "entity",
        "date",
        "capacity",
        "deadline",
        "before_after",
        "compensation",
        "cross_goal",
    }
    assert {case["category"] for case in suites["action-runtime-safety-v1"]} >= {
        "concurrency",
        "duplicate_write",
        "expired_changeset",
        "worker_interrupt",
        "rejected",
        "cancelled",
        "failed",
        "rollback",
        "cross_user",
        "unconfirmed_write",
    }


async def test_agent_v25_fast_gate_runs_real_routing_review_and_policy(db):
    result = await evaluate_agent_v25_fast_gate(db)
    assert result["status"] == "passed", result["failures"]
    assert all(suite["pass_rate"] == 1.0 for suite in result["metrics"]["suites"].values())


async def test_agent_v25_fast_gate_persists_two_real_code_runs(db):
    gate = await run_agent_v25_gate(db, "system-test")
    assert gate["status"] == "passed"
    assert gate["criteria_version"] == "agent-v25-fast-contract-gate-v1"
    assert gate["evaluation_run_id"]
    assert gate["failures"] == []


async def test_fast_gate_turns_red_when_real_intent_resolution_is_mutated(db, monkeypatch):
    async def conversation_only(*_args, **_kwargs):
        return NeedFrame(
            speech_act="inform",
            core_need="mutated classifier",
            mode="conversation",
            context_scope=["conversation"],
        )

    monkeypatch.setattr("src.services.evaluation_v2_service.resolve_need_frame", conversation_only)
    result = await evaluate_agent_v25_fast_gate(db)

    assert result["status"] == "failed"
    assert any(item["dataset"] == "intent-routing-v1" for item in result["failures"])


async def test_v2_metrics_do_not_count_conversion_as_acceptance_or_internal_drafts(db):
    metric_date = date(1999, 1, 2)
    started = datetime.combine(metric_date, datetime.min.time()) + timedelta(hours=8)
    user = User(
        email=f"metrics-{uuid.uuid4().hex}@example.com",
        username=f"metrics-{uuid.uuid4().hex[:12]}",
        hashed_password="unused",
    )
    db.add(user)
    await db.flush()
    insight = DecisionProposal(
        user_id=user.id,
        proposal_type="reschedule_overdue_tasks",
        title="调整逾期任务",
        confidence=0.8,
        status="pending",
        lifecycle_status="converted",
        created_at=started,
    )
    internal = DecisionProposal(
        user_id=user.id,
        proposal_type="GOAL_PLAN_CREATE",
        title="内部目标草稿",
        confidence=0.8,
        created_at=started,
    )
    run = AgentRun(
        user_id=user.id,
        request_text="生成调整预览",
        status="waiting_approval",
        input_received_at=started,
        preview_ready_at=started + timedelta(milliseconds=1250),
        created_at=started,
    )
    db.add_all([insight, internal, run])
    await db.flush()
    db.add(
        InsightActionRun(
            insight_id=insight.id,
            run_id=run.id,
            status="converted",
            is_active=True,
        )
    )
    db.add_all(
        [
            LearningEvent(
                user_id=user.id,
                aggregate_type="conversation_turn",
                aggregate_id="turn-1",
                event_type="NeedFrameResolved",
                occurred_at=started,
                created_at=started,
            ),
            LearningEvent(
                user_id=user.id,
                aggregate_type="conversation_turn",
                aggregate_id="turn-1",
                event_type="ClarificationRequested",
                occurred_at=started,
                created_at=started,
            ),
        ]
    )
    await db.commit()

    try:
        result = await aggregate_daily_metrics(db, metric_date)
        metrics = result["metrics"]
        assert metrics["proposal_count"] == 1
        assert metrics["insight_to_action_rate"] == 1.0
        assert metrics["action_approval_rate"] is None
        assert metrics["accept_rate"] is None
        assert metrics["clarification_rate"] == 0.5
        assert metrics["input_to_preview_p50_ms"] == 1250.0
        assert metrics["input_to_preview_p95_ms"] == 1250.0
    finally:
        await db.execute(delete(LearningEvent).where(LearningEvent.user_id == user.id))
        await db.delete(user)
        await db.execute(
            delete(AgentMetricsDaily).where(
                AgentMetricsDaily.metric_date == metric_date.isoformat()
            )
        )
        await db.commit()
