"""Phase 2C-4 ~ 2C-7 learner loop tests."""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from src.core.agent_v2.orchestrator import advance_run
from src.core.time import utc_now
from src.intelligence.event_processor import process_event
from src.intelligence.profile_metrics import (
    calc_consistency,
    calc_daily_investment,
    calc_preferred_hours,
)
from src.models import (
    AgentInvocation,
    DecisionProposal,
    Goal,
    LearnerPattern,
    LearnerPatternAudit,
    LearnerPatternSuppression,
    LearnerProfile,
    LearningEvent,
    PatternEvidence,
    Task,
)


@pytest.mark.asyncio
async def test_user_can_control_and_audit_learner_patterns(client, auth, goal_id, db):
    goal = await db.scalar(select(Goal).where(Goal.id == goal_id))
    pattern = LearnerPattern(
        user_id=goal.user_id,
        goal_id=None,
        pattern_type="preferred_session_length",
        pattern_value={"minutes": 45},
        confidence=0.8,
        evidence_count=8,
        scope="user",
        decay_rate=0.05,
        status="active",
        first_observed_at=utc_now() - timedelta(days=20),
    )
    db.add(pattern)
    await db.commit()

    managed = await client.get("/api/v1/learner/patterns/manage", headers=auth)
    assert managed.status_code == 200
    assert any(row["id"] == pattern.id for row in managed.json())

    confirmed = await client.post(
        f"/api/v1/learner/patterns/{pattern.id}/actions",
        headers=auth,
        json={"action": "confirm", "reason": "符合最近学习体验"},
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["pattern"]["user_review_status"] == "confirmed"

    corrected = await client.post(
        f"/api/v1/learner/patterns/{pattern.id}/actions",
        headers=auth,
        json={"action": "correct", "summary": "高负荷周更适合 35 分钟专注"},
    )
    assert corrected.status_code == 200
    assert corrected.json()["pattern"]["explanation"] == "高负荷周更适合 35 分钟专注"
    undo = await client.post(
        f"/api/v1/learner/pattern-audits/{corrected.json()['audit_id']}/undo", headers=auth
    )
    assert undo.status_code == 200, undo.text

    scoped = await client.post(
        f"/api/v1/learner/patterns/{pattern.id}/actions",
        headers=auth,
        json={"action": "set_scope", "scope": "goal", "goal_id": goal_id},
    )
    assert scoped.status_code == 200
    assert scoped.json()["pattern"]["goal_id"] == goal_id

    paused = await client.post(
        f"/api/v1/learner/patterns/{pattern.id}/actions",
        headers=auth,
        json={"action": "pause"},
    )
    assert paused.status_code == 200
    assert paused.json()["pattern"]["status"] == "paused"
    restored = await client.post(
        f"/api/v1/learner/patterns/{pattern.id}/actions",
        headers=auth,
        json={"action": "restore"},
    )
    assert restored.status_code == 200
    assert restored.json()["pattern"]["status"] == "active"

    audits = await client.get("/api/v1/learner/pattern-audits", headers=auth)
    assert audits.status_code == 200
    assert {row["action"] for row in audits.json()} >= {
        "confirm",
        "correct",
        "undo",
        "set_scope",
        "pause",
        "restore",
    }

    forgotten = await client.post(
        f"/api/v1/learner/patterns/{pattern.id}/actions",
        headers=auth,
        json={"action": "forget"},
    )
    assert forgotten.status_code == 200
    assert forgotten.json()["deleted"] is True
    assert await db.scalar(select(LearnerPattern.id).where(LearnerPattern.id == pattern.id)) is None
    forget_audit = await db.scalar(
        select(LearnerPatternAudit).where(
            LearnerPatternAudit.pattern_id == pattern.id,
            LearnerPatternAudit.action == "forget",
        )
    )
    assert forget_audit is not None
    assert "summary" not in forget_audit.before_state
    suppression = await db.scalar(
        select(LearnerPatternSuppression).where(
            LearnerPatternSuppression.user_id == goal.user_id,
            LearnerPatternSuppression.pattern_type == "preferred_session_length",
        )
    )
    assert suppression is not None


@pytest.mark.asyncio
async def test_user_can_attribute_one_overdue_evidence_and_recompute_pattern(client, auth, goal_id, db):
    goal = await db.scalar(select(Goal).where(Goal.id == goal_id))
    assert goal is not None
    events = []
    for index in range(5):
        event = LearningEvent(
            user_id=goal.user_id,
            goal_id=goal_id,
            aggregate_type="task",
            aggregate_id=f"delay-task-{index}",
            event_type="TaskCompleted",
            occurred_at=utc_now(),
            payload={
                "days_overdue": 4,
                "actual_mins": 60,
                "title": f"数据叙事 {index + 1}",
                "stage_label": "数据叙事",
            },
        )
        db.add(event)
        await db.flush()
        await process_event(db, event)
        events.append(event)
    await db.commit()

    pattern = await db.scalar(
        select(LearnerPattern).where(
            LearnerPattern.user_id == goal.user_id,
            LearnerPattern.pattern_type == "delay_pattern",
        )
    )
    assert pattern is not None
    evidence = await db.scalar(
        select(PatternEvidence).where(
            PatternEvidence.pattern_id == pattern.id,
            PatternEvidence.learning_event_id == events[0].id,
        )
    )
    assert evidence is not None

    response = await client.post(
        f"/api/v1/learner/patterns/{pattern.id}/evidence/{evidence.id}/attribution",
        headers=auth,
        json={"reason_code": "business_trip", "note": "当周在出差，连续时间明显减少"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["attribution"] == "external_interruption"
    assert body["pattern"]["evidence_summary"]["excluded_count"] == 1
    assert body["pattern"]["pattern_value"]["effective_sample_count"] == 4
    assert body["pattern"]["status"] == "decayed"

    managed = await client.get("/api/v1/learner/patterns/manage", headers=auth)
    assert managed.status_code == 200
    managed_pattern = next(row for row in managed.json() if row["id"] == pattern.id)
    corrected = next(item for item in managed_pattern["evidence"] if item["evidence_id"] == evidence.id)
    assert corrected["direction"] == "excluded"
    assert corrected["reason_code"] == "business_trip"


def _event(user_id: str, goal_id: str, event_type: str, payload: dict, days_ago: int = 0):
    return LearningEvent(
        id=str(uuid.uuid4()),
        user_id=user_id,
        goal_id=goal_id,
        aggregate_type="checkin" if event_type == "CheckinSubmitted" else "task",
        aggregate_id=str(uuid.uuid4()),
        event_type=event_type,
        source="user_action",
        payload=payload,
        occurred_at=utc_now() - timedelta(days=days_ago),
        version=1,
    )


def test_profile_metrics_pattern_and_compatible_event_payloads():
    user_id = str(uuid.uuid4())
    goal_id = str(uuid.uuid4())
    pattern = LearnerPattern(
        user_id=user_id,
        goal_id=None,
        pattern_type="weekly_learning_frequency",
        pattern_value={"avg_days_per_week": 5},
        confidence=0.8,
        evidence_count=8,
        scope="user",
        decay_rate=0.05,
        status="active",
        first_observed_at=utc_now(),
    )
    events = [
        _event(
            user_id,
            goal_id,
            "CheckinSubmitted",
            {"actual_mins": 60, "completed": 2},
            days_ago=1,
        ),
        _event(
            user_id,
            goal_id,
            "CheckinSubmitted",
            {"time_investment_mins": 30, "completed_count": 1},
            days_ago=2,
        ),
    ]
    consistency, weekly_days = calc_consistency([pattern], events)
    assert consistency == pytest.approx(5 / 7, abs=0.0001)
    assert weekly_days == 5
    assert calc_daily_investment(events) == 45

    completion = _event(user_id, goal_id, "TaskCompleted", {}, days_ago=0)
    completion.occurred_at = completion.occurred_at.replace(hour=21)
    assert calc_preferred_hours([], [completion]) == (20, 22)


@pytest.mark.asyncio
async def test_profile_context_proposal_and_feedback_closed_loop(client, auth, goal_id, db):
    goal = await db.scalar(select(Goal).where(Goal.id == goal_id))
    assert goal is not None
    user_id = goal.user_id

    task_response = await client.post(
        "/api/v1/tasks",
        headers=auth,
        json={
            "goalId": goal_id,
            "title": "需要重新安排的逾期任务",
            "date": (date.today() - timedelta(days=4)).isoformat(),
            "estimatedMinutes": 45,
            "priority": "high",
        },
    )
    assert task_response.status_code == 201, task_response.text
    task_id = task_response.json()["id"]

    delay_pattern = LearnerPattern(
        id=str(uuid.uuid4()),
        user_id=user_id,
        goal_id=None,
        pattern_type="delay_pattern",
        pattern_value={"chronic_delay_rate": 0.6},
        confidence=0.8,
        evidence_count=8,
        scope="user",
        decay_rate=0.05,
        status="active",
        first_observed_at=utc_now() - timedelta(days=20),
        last_confirmed_at=utc_now(),
    )
    completion_pattern = LearnerPattern(
        id=str(uuid.uuid4()),
        user_id=user_id,
        goal_id=goal_id,
        pattern_type="completion_rate_trend",
        pattern_value={"current_30d_avg": 0.5, "trend": "declining"},
        confidence=0.75,
        evidence_count=9,
        scope="goal",
        decay_rate=0.1,
        status="active",
        first_observed_at=utc_now() - timedelta(days=20),
        last_confirmed_at=utc_now(),
    )
    db.add_all([delay_pattern, completion_pattern])
    for index in range(7):
        db.add(
            _event(
                user_id,
                goal_id,
                "CheckinSubmitted",
                {
                    "date": (date.today() - timedelta(days=index)).isoformat(),
                    "completion_rate": 0.5,
                    "mastery_rate": 0.4,
                    "actual_mins": 40,
                    "completed": 1,
                },
                days_ago=index,
            )
        )
    await db.commit()

    confidence_before = delay_pattern.confidence
    rebuild = await client.post("/api/v1/learner/profile/rebuild", headers=auth)
    assert rebuild.status_code == 200, rebuild.text
    assert rebuild.json()["processed_goals"] >= 1

    profile_response = await client.get(f"/api/v1/learner/profile?goal_id={goal_id}", headers=auth)
    assert profile_response.status_code == 200
    profile = profile_response.json()["profile"]
    assert profile["event_count"] >= 7
    assert profile["completion_rate_30d"] == pytest.approx(0.5)
    await db.refresh(delay_pattern)
    assert delay_pattern.confidence == confidence_before  # Builder 不修改 Pattern

    context_response = await client.get(
        f"/api/v1/learner/decision-context?goal_id={goal_id}", headers=auth
    )
    assert context_response.status_code == 200, context_response.text
    context = context_response.json()
    assert context["data_quality"]["profile_scope"] == "goal"
    assert context["goal_context"]["task_summary"]["overdue_count"] == 1
    assert {row["pattern_type"] for row in context["active_patterns"]} >= {
        "delay_pattern",
        "completion_rate_trend",
    }
    delay_context = next(
        row for row in context["active_patterns"] if row["pattern_type"] == "delay_pattern"
    )
    assert delay_context["evidence_summary"]["supporting_count"] == 0
    assert delay_context["evidence_summary"]["opposing_count"] == 0
    assert delay_context["evidence_summary"]["first_observed_at"]
    validation_response = await client.get("/api/v1/learner/validation-status", headers=auth)
    assert validation_response.status_code == 200
    assert validation_response.json()["schema_version"] == "core-learning-experiment-v1"
    assert isinstance(validation_response.json()["reports"], list)
    assert validation_response.json()["viewer_evidence"]["cohort"] == "internal_or_test"
    assert validation_response.json()["viewer_evidence"]["eligible_for_real_evidence"] is False

    generated = await client.post(
        "/api/v1/learner/proposals/generate",
        headers=auth,
        json={"goal_id": goal_id},
    )
    assert generated.status_code == 200, generated.text
    proposal = generated.json()[0]
    assert proposal["proposal_type"] == "reschedule_overdue_tasks"
    assert proposal["status"] == "pending"
    assert proposal["evidence_references"] == [delay_pattern.id]
    assert proposal["agent_trace"]["invocation_id"]
    invocation = await db.get(AgentInvocation, proposal["agent_trace"]["invocation_id"])
    assert invocation is not None
    assert invocation.proposal_id == proposal["id"]
    assert invocation.prompt_version_id
    assert invocation.model_config_id
    assert invocation.policy_version_id

    accepted = await client.post(f"/api/v1/learner/proposals/{proposal['id']}/accept", headers=auth)
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "accepted"

    applied = await client.post(f"/api/v1/learner/proposals/{proposal['id']}/apply", headers=auth)
    assert applied.status_code == 409
    action = await client.post(
        f"/api/v1/learner/proposals/{proposal['id']}/action-run", headers=auth
    )
    assert action.status_code == 200, action.text
    run_id = action.json()["id"]
    await advance_run(db, user_id=user_id, run_id=run_id)
    preview = await client.get(f"/api/v2/agent/runs/{run_id}", headers=auth)
    assert preview.status_code == 200, preview.text
    approval = preview.json()["approvals"][0]
    approved = await client.post(
        f"/api/v2/agent/runs/{run_id}/approve",
        headers=auth,
        json={
            "approval_id": approval["id"],
            "change_hash": approval["change_hash"],
            "change_set_version": approval["change_set_version"],
            "run_state_version": approval["run_state_version"],
        },
    )
    assert approved.status_code == 200, approved.text
    await advance_run(db, user_id=user_id, run_id=run_id)
    applied_proposal = await db.get(DecisionProposal, proposal["id"])
    await db.refresh(applied_proposal)
    assert applied_proposal.status == "applied"
    assert applied_proposal.lifecycle_status == "applied"
    task = await db.scalar(select(Task).where(Task.id == task_id))
    await db.refresh(task)
    assert task.scheduled_date > date.today().isoformat()

    feedback = await client.post(
        f"/api/v1/learner/proposals/{proposal['id']}/feedback",
        headers=auth,
        json={"outcome": "helpful", "rating": 5, "comment": "新的节奏更可执行"},
    )
    assert feedback.status_code == 201, feedback.text
    await db.refresh(delay_pattern)
    assert delay_pattern.confidence > confidence_before
    evidence = (
        (
            await db.execute(
                select(PatternEvidence).where(
                    PatternEvidence.pattern_id == delay_pattern.id,
                    PatternEvidence.meta["source"].as_string() == "proposal_feedback",
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(evidence) == 1

    second = await client.post(
        "/api/v1/learner/proposals/generate",
        headers=auth,
        json={"goal_id": goal_id},
    )
    assert second.status_code == 200
    second_proposal = second.json()[0]
    assert second_proposal["proposal_type"] == "reduce_daily_load"
    rejected = await client.post(
        f"/api/v1/learner/proposals/{second_proposal['id']}/reject",
        headers=auth,
        json={"reason": "本周时间只是临时减少"},
    )
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"
    await db.refresh(completion_pattern)
    assert completion_pattern.confidence < 0.75

    summary_response = await client.get(
        f"/api/v1/learner/feedback/summary?goal_id={goal_id}", headers=auth
    )
    assert summary_response.status_code == 200
    summary = summary_response.json()
    assert summary["accepted_count"] == 1
    assert summary["rejected_count"] == 1
    assert summary["accept_rate"] == 0.5
    assert summary["pattern_accuracy"] == 1.0

    event_types = set(
        (
            await db.execute(
                select(LearningEvent.event_type).where(
                    LearningEvent.aggregate_id.in_([proposal["id"], second_proposal["id"]])
                )
            )
        ).scalars()
    )
    assert {"ProposalCreated", "ProposalAccepted", "ProposalRejected"} <= event_types

    stored = await db.scalar(select(DecisionProposal).where(DecisionProposal.id == proposal["id"]))
    profile_row = await db.scalar(
        select(LearnerProfile).where(
            LearnerProfile.user_id == user_id, LearnerProfile.goal_id == goal_id
        )
    )
    assert stored.status == "applied"
    assert profile_row is not None
