import uuid
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, select

from src.core.agent_v2.audit import record_event
from src.core.time import utc_now
from src.models import (
    AgentApproval,
    AgentAuditEvent,
    AgentBetaControl,
    AgentBetaControlEvent,
    AgentBetaReviewSample,
    AgentFeedbackEvent,
    AgentRun,
    AgentStep,
    DecisionProposal,
    EvaluationCase,
    EvaluationDataset,
    InsightActionRun,
    LearningEvent,
    OfflineEvaluationGate,
    User,
)
from src.services.beta_evidence_service import (
    apply_safety_snapshot,
    assert_new_action_run_allowed,
    assignment,
    cleanup_expired_review_samples,
    funnel_overview,
    normalize_review_samples,
    persist_runtime_gate_proof,
    promote_candidate,
    record_safety_observation,
    review_sample,
    runtime_gate_status,
    safety_status,
    scan_hard_safety,
    update_control,
)


async def _user(db, suffix: str) -> User:
    row = User(
        id=f"beta-user-{suffix}-{uuid.uuid4().hex[:8]}",
        email=f"beta-{suffix}-{uuid.uuid4().hex[:8]}@test.local",
        username=f"beta-{suffix}-{uuid.uuid4().hex[:8]}",
        hashed_password="not-used",
    )
    db.add(row)
    await db.flush()
    return row


async def _reset_control(db) -> AgentBetaControl:
    await db.execute(delete(AgentBetaControlEvent))
    row = await db.get(AgentBetaControl, "action-beta")
    if row is None:
        row = AgentBetaControl(id="action-beta")
        db.add(row)
    row.beta_enabled = False
    row.new_action_runs_enabled = True
    row.cohort_mode = "allowlist"
    row.traffic_percent = 0
    row.allowlisted_user_ids = []
    row.safety_snapshot = {}
    row.paused_reason = None
    await db.commit()
    return row


@pytest.mark.asyncio
async def test_default_off_keeps_stable_action_available_and_allowlist_is_server_controlled(db):
    control = await _reset_control(db)
    user = await _user(db, "assignment")
    stable = await assert_new_action_run_allowed(db, user.id)
    assert stable["cohort"] == "stable"

    control.beta_enabled = True
    control.allowlisted_user_ids = [user.id]
    await db.commit()
    enrolled = await assignment(db, user.id)
    assert enrolled == {
        "enrolled": True,
        "cohort": "beta",
        "mode": "allowlist",
        "traffic_percent": 0,
        "metric_version": "action-beta-funnel-v2",
    }


@pytest.mark.asyncio
async def test_kill_switch_blocks_only_new_runs_and_safety_event_is_audited(db):
    control = await _reset_control(db)
    user = await _user(db, "kill")
    existing = AgentRun(
        id=f"existing-{uuid.uuid4()}",
        user_id=user.id,
        request_text="sensitive text remains outside beta samples",
        status="completed",
    )
    db.add(existing)
    await db.commit()

    result = await apply_safety_snapshot(
        db,
        actor_id=user.id,
        snapshot={"unconfirmed_write_count": 1},
        reason="runtime hard safety violation",
    )
    assert result["status"] == "violated"
    with pytest.raises(HTTPException) as exc:
        await assert_new_action_run_allowed(db, user.id)
    assert exc.value.status_code == 503
    assert await db.get(AgentRun, existing.id) is not None
    assert await db.scalar(
        select(AgentBetaControlEvent).where(AgentBetaControlEvent.action == "safety_stop")
    )
    control = await db.get(AgentBetaControl, "action-beta")
    assert control.paused_reason == "runtime hard safety violation"


@pytest.mark.asyncio
async def test_cohort_expansion_is_blocked_without_100_percent_runtime_gate(db):
    await _reset_control(db)
    admin = await _user(db, "admin")
    with pytest.raises(ValueError, match="fresh Runtime Gate"):
        await update_control(
            db,
            actor_id=admin.id,
            reason="attempt expansion",
            beta_enabled=True,
            allowlisted_user_ids=[admin.id],
        )


@pytest.mark.asyncio
async def test_funnel_excludes_rolled_back_from_net_success_and_reports_small_sample(db):
    await _reset_control(db)
    user = await _user(db, "funnel")
    now = utc_now()
    completed = AgentRun(
        id=f"completed-{uuid.uuid4()}", user_id=user.id, request_text="x", status="completed",
        input_received_at=now, preview_ready_at=now + timedelta(milliseconds=100), trace_context={"beta": {"cohort": "beta"}},
    )
    rolled = AgentRun(
        id=f"rolled-{uuid.uuid4()}", user_id=user.id, request_text="y", status="rolled_back",
        input_received_at=now, preview_ready_at=now + timedelta(milliseconds=300), trace_context={"beta": {"cohort": "beta"}},
    )
    db.add_all([completed, rolled])
    await db.flush()
    for run in (completed, rolled):
        db.add(AgentApproval(run_id=run.id, step_id=f"step-{run.id}", status="approved", change_hash="hash"))
    await db.commit()

    metrics = await funnel_overview(
        db,
        beta_only=True,
        source="legacy_unattributed",
        start=now - timedelta(seconds=1),
        end=now + timedelta(seconds=1),
    )
    assert metrics["counts"]["completed"] == 1
    assert metrics["counts"]["rolled_back"] == 1
    assert metrics["rates"]["execution_success_rate"] == 0.5
    assert metrics["latency"]["preview_p50_ms"] in {100.0, 300.0}
    assert metrics["insufficient_data"] is True


@pytest.mark.asyncio
async def test_real_event_sample_is_redacted_admin_reviewed_and_candidate_only(db):
    await _reset_control(db)
    reviewer = await _user(db, "reviewer")
    subject = await _user(db, "subject")
    run = AgentRun(
        id=f"failed-{uuid.uuid4()}",
        user_id=subject.id,
        request_text="do not copy this raw private request",
        status="failed",
        conversation_turn_id=f"turn-{uuid.uuid4()}",
        trace_context={"core_need": "task_update", "beta": {"cohort": "beta"}},
    )
    db.add(run)
    await db.commit()

    assert await normalize_review_samples(db) >= 1
    assert await normalize_review_samples(db) == 0
    sample = await db.scalar(
        select(AgentBetaReviewSample).where(
            AgentBetaReviewSample.run_id == run.id,
            AgentBetaReviewSample.sample_type == "execution_failure",
        )
    )
    assert sample is not None
    assert "private request" not in str(sample.structured_context)
    assert subject.id not in sample.pseudonymous_user_key
    with pytest.raises(ValueError, match="仅人工确认"):
        await promote_candidate(
            db, sample_id=sample.id, reviewer_id=reviewer.id, dataset_kind="intent-routing"
        )

    await review_sample(
        db,
        sample_id=sample.id,
        reviewer_id=reviewer.id,
        status="confirmed",
        note="confirmed after redaction and dedupe review",
    )
    candidate = await promote_candidate(
        db, sample_id=sample.id, reviewer_id=reviewer.id, dataset_kind="intent-routing"
    )
    dataset = await db.get(EvaluationDataset, candidate["dataset_id"])
    assert dataset.status == "candidate" and dataset.version == "v1.2"
    case = await db.scalar(select(EvaluationCase).where(EvaluationCase.dataset_id == dataset.id))
    assert case.label_source == "confirmed-human-beta-review"
    assert dataset.status != "frozen"


@pytest.mark.asyncio
async def test_beta_operations_api_is_admin_only(client, auth, db):
    response = await client.get("/api/v1/agent-control/admin/beta/overview", headers=auth)
    assert response.status_code == 403

    me = await client.get("/api/v1/auth/me", headers=auth)
    assert me.status_code == 200
    user = await db.get(User, me.json()["id"])
    assert user is not None
    user.is_admin = True
    await db.commit()
    response = await client.get("/api/v1/agent-control/admin/beta/overview", headers=auth)
    assert response.status_code == 200, response.text
    assert response.json()["evidence_state"] == "infrastructure_ready_no_beta_conclusion"


def _turn_event(
    *,
    user_id: str,
    turn_id: str,
    event_type: str,
    cohort: str,
    created_at: datetime,
    capability: str = "task_update",
    quality: str = "exact",
    continued_from: str | None = None,
) -> LearningEvent:
    payload = {"beta": {"cohort": cohort}, "session_id": f"session-{cohort}"}
    if event_type != "ConversationTurnReceived":
        payload["need_frame"] = {
            "core_need": capability,
            "action_intent": {
                "capability": capability,
                "resolution_quality": quality,
            },
        }
    if continued_from:
        payload["continued_from_turn_id"] = continued_from
    return LearningEvent(
        user_id=user_id,
        aggregate_type="conversation_turn",
        aggregate_id=turn_id,
        event_type=event_type,
        source="user_action",
        payload=payload,
        occurred_at=created_at,
        created_at=created_at,
        idempotency_key=f"seed:{turn_id}:{event_type}",
    )


@pytest.mark.asyncio
async def test_funnel_v2_exact_conversation_attribution_filters_and_rate_bounds(db):
    await _reset_control(db)
    user = await _user(db, "v2-seed")
    start = datetime(2035, 1, 1, 0, 0, 0)
    end = start + timedelta(hours=1)
    for index in range(10):
        turn_id = f"beta-seed-turn-{index}"
        capability = "task_update" if index < 5 else "task_create"
        quality = "exact" if index % 2 == 0 else "inferred"
        db.add(
            _turn_event(
                user_id=user.id,
                turn_id=turn_id,
                event_type="ConversationTurnReceived",
                cohort="beta",
                created_at=start + timedelta(minutes=index),
                capability=capability,
                quality=quality,
            )
        )
        db.add(
            _turn_event(
                user_id=user.id,
                turn_id=turn_id,
                event_type="NeedFrameResolved",
                cohort="beta",
                created_at=start + timedelta(minutes=index, seconds=1),
                capability=capability,
                quality=quality,
            )
        )
    for index in range(3):
        db.add(
            AgentRun(
                id=f"beta-seed-run-{index}",
                user_id=user.id,
                request_text="redacted seed",
                conversation_turn_id=f"beta-seed-turn-{index}",
                run_kind="user",
                status="queued",
                trace_context={
                    "beta": {"cohort": "beta"},
                    "action_intent": {
                        "capability": "task_update",
                        "resolution_quality": "exact" if index % 2 == 0 else "inferred",
                    },
                },
                created_at=start + timedelta(minutes=index, seconds=2),
            )
        )
    # A second Run for one turn must not increase the routing numerator.
    db.add(
        AgentRun(
            id="beta-seed-run-duplicate-turn",
            user_id=user.id,
            request_text="same turn",
            conversation_turn_id="beta-seed-turn-0",
            run_kind="user",
            status="queued",
            trace_context={
                "beta": {"cohort": "beta"},
                "action_intent": {
                    "capability": "task_update",
                    "resolution_quality": "exact",
                },
            },
            created_at=start + timedelta(minutes=20),
        )
    )
    # Null/legacy and explicit API runs remain outside the conversation rate.
    db.add_all(
        [
            AgentRun(
                id="beta-seed-legacy",
                user_id=user.id,
                request_text="legacy",
                status="queued",
                trace_context={"beta": {"cohort": "beta"}},
                created_at=start + timedelta(minutes=21),
            ),
            AgentRun(
                id="beta-seed-api",
                user_id=user.id,
                request_text="api",
                status="queued",
                trace_context={"beta": {"cohort": "beta"}, "source": "api"},
                created_at=start + timedelta(minutes=22),
            ),
        ]
    )
    await db.commit()

    metrics = await funnel_overview(db, start=start, end=end, cohort="beta")
    assert metrics["metric_version"] == "action-beta-funnel-v2"
    assert metrics["sample_size"] == 10
    assert metrics["rate_details"]["routing_rate"] == {
        "numerator": 3,
        "denominator": 10,
        "value": 0.3,
    }
    assert metrics["counts"]["action_run_created"] == 4
    assert metrics["source_funnel"]["legacy_unattributed"] == 1
    assert metrics["source_funnel"]["api"] == 1
    filtered = await funnel_overview(
        db, start=start, end=end, cohort="beta", capability="task_update"
    )
    assert filtered["sample_size"] == 5
    assert filtered["rate_details"]["routing_rate"]["numerator"] == 3
    exact = await funnel_overview(
        db, start=start, end=end, cohort="beta", resolution_quality="exact"
    )
    assert exact["sample_size"] == 5
    assert exact["rate_details"]["routing_rate"]["numerator"] == 2
    assert all(value is None or 0 <= value <= 1 for value in metrics["rates"].values())


@pytest.mark.asyncio
async def test_funnel_v2_cohort_and_cross_turn_clarification_are_strictly_linked(db):
    await _reset_control(db)
    user = await _user(db, "v2-link")
    start = datetime(2035, 2, 1, 0, 0, 0)
    end = start + timedelta(hours=1)
    for cohort in ("beta", "stable"):
        first = f"{cohort}-clarify-first"
        second = f"{cohort}-clarify-second"
        for offset, turn_id in enumerate((first, second)):
            db.add(
                _turn_event(
                    user_id=user.id,
                    turn_id=turn_id,
                    event_type="ConversationTurnReceived",
                    cohort=cohort,
                    created_at=start + timedelta(minutes=offset),
                )
            )
        db.add(
            _turn_event(
                user_id=user.id,
                turn_id=first,
                event_type="ClarificationRequested",
                cohort=cohort,
                created_at=start + timedelta(seconds=5),
            )
        )
        db.add(
            _turn_event(
                user_id=user.id,
                turn_id=second,
                event_type="IntentResolved",
                cohort=cohort,
                created_at=start + timedelta(minutes=1, seconds=5),
                continued_from=first,
            )
        )
        db.add(
            AgentRun(
                id=f"{cohort}-linked-run",
                user_id=user.id,
                request_text="linked",
                conversation_turn_id=second,
                status="completed",
                run_kind="user",
                trace_context={
                    "beta": {"cohort": cohort},
                    "action_intent": {
                        "capability": "task_update",
                        "resolution_quality": "exact",
                    },
                },
                created_at=start + timedelta(minutes=2),
            )
        )
    await db.commit()

    beta = await funnel_overview(db, start=start, end=end, cohort="beta")
    stable = await funnel_overview(db, start=start, end=end, cohort="stable")
    assert beta["sample_size"] == stable["sample_size"] == 2
    assert beta["rate_details"]["clarification_completion_rate"] == {
        "numerator": 1,
        "denominator": 1,
        "value": 1.0,
    }
    assert beta["counts"]["action_run_created"] == 1
    assert stable["counts"]["action_run_created"] == 1


@pytest.mark.asyncio
async def test_funnel_v2_insight_and_outcome_never_cross_cohort(db):
    await _reset_control(db)
    user = await _user(db, "v2-insight")
    start = datetime(2035, 3, 1, 0, 0, 0)
    end = start + timedelta(hours=1)
    for cohort in ("beta", "stable"):
        run = AgentRun(
            id=f"{cohort}-insight-run",
            user_id=user.id,
            request_text="insight",
            insight_id=None,
            status="completed",
            run_kind="user",
            trace_context={"beta": {"cohort": cohort}, "source": "learning_insight"},
            created_at=start + timedelta(minutes=1),
        )
        db.add(run)
        await db.flush()
        proposal = DecisionProposal(
            id=f"{cohort}-proposal",
            user_id=user.id,
            proposal_type="learning_nudge",
            title="candidate",
            reasoning=["evidence"],
            confidence=0.8,
            agent_trace={"beta": {"cohort": cohort}},
            created_at=start,
        )
        db.add(proposal)
        await db.flush()
        run.insight_id = proposal.id
        db.add(InsightActionRun(insight_id=proposal.id, run_id=run.id))
        db.add(
            AgentFeedbackEvent(
                user_id=user.id,
                proposal_id=proposal.id,
                run_id=run.id,
                feedback_type="completion_rate_7d",
                value={"completion_rate": 0.8},
                dedupe_key=f"{cohort}-outcome",
                occurred_at=start + timedelta(minutes=3),
            )
        )
    await db.commit()

    beta = await funnel_overview(
        db, start=start, end=end, cohort="beta", source="insight"
    )
    assert beta["counts"]["action_run_created"] == 1
    assert beta["counts"]["coach_insights"] == 1
    assert beta["counts"]["converted_insights"] == 1
    assert beta["counts"]["outcome_7d"] == 1
    assert beta["rates"]["insight_conversion_rate"] == 1.0
    assert beta["rates"]["outcome_7d_rate"] == 1.0


@pytest.mark.asyncio
async def test_safety_states_are_unknown_stale_observed_clear_and_violated(db, monkeypatch):
    control = await _reset_control(db)
    binding = {
        "deployment_id": "deployment-1",
        "deployed_revision": 7,
        "migration_head": "f9g0h1i2j3k4",
        "dataset_hash": "dataset-hash",
        "runtime_digest": "runtime-digest",
        "deployment_fingerprint": "fingerprint",
    }

    async def current_binding(_db):
        return binding

    monkeypatch.setattr(
        "src.services.beta_evidence_service.current_deployment_binding", current_binding
    )
    assert (await safety_status(db, control))["status"] == "unknown"
    clear = await record_safety_observation(
        db,
        actor_id=None,
        counts={},
        reason="real empty-window scan",
        source="automatic_audit_scan",
        audit_start=utc_now() - timedelta(hours=1),
        audit_end=utc_now(),
    )
    assert clear["status"] == "observed_clear"
    control = await db.get(AgentBetaControl, "action-beta")
    snapshot = dict(control.safety_snapshot)
    snapshot["expires_at"] = (utc_now() - timedelta(seconds=1)).isoformat()
    control.safety_snapshot = snapshot
    await db.commit()
    assert (await safety_status(db, control))["status"] == "stale"

    violated = await record_safety_observation(
        db,
        actor_id=None,
        counts={"duplicate_write_count": 1},
        reason="real violation",
        source="automatic_audit_scan",
        audit_start=utc_now() - timedelta(hours=1),
        audit_end=utc_now(),
    )
    assert violated["status"] == "violated"
    control = await db.get(AgentBetaControl, "action-beta")
    assert control.new_action_runs_enabled is False


@pytest.mark.asyncio
async def test_real_safety_scan_detects_unconfirmed_executor_and_stops_new_runs(db, monkeypatch):
    await _reset_control(db)
    user = await _user(db, "scan")
    binding = {
        "deployment_id": "deployment-2",
        "deployed_revision": 8,
        "migration_head": "f9g0h1i2j3k4",
        "dataset_hash": "dataset-hash",
        "runtime_digest": "runtime-digest",
        "deployment_fingerprint": "fingerprint-2",
    }

    async def current_binding(_db):
        return binding

    monkeypatch.setattr(
        "src.services.beta_evidence_service.current_deployment_binding", current_binding
    )
    run = AgentRun(id="scan-unconfirmed-run", user_id=user.id, request_text="x", status="completed")
    db.add(run)
    await db.flush()
    step = AgentStep(
        id="scan-unconfirmed-step",
        run_id=run.id,
        step_index=0,
        step_key="scan-write",
        tool_name="tasks.apply_changes",
        status="completed",
    )
    db.add(step)
    await db.flush()
    record_event(
        db,
        run_id=run.id,
        step_id=step.id,
        event_type="executor.completed",
        actor="observer",
    )
    await db.flush()
    audit = await db.scalar(
        select(AgentAuditEvent).where(AgentAuditEvent.run_id == run.id)
    )
    scan_time = datetime(2040, 1, 1, 0, 0, 0)
    audit.created_at = scan_time
    await db.commit()
    result = await scan_hard_safety(
        db,
        audit_start=scan_time - timedelta(minutes=1),
        audit_end=scan_time + timedelta(minutes=1),
    )
    assert result["status"] == "violated"
    assert result["counts"]["unconfirmed_write_count"] == 1
    control = await db.get(AgentBetaControl, "action-beta")
    assert control.new_action_runs_enabled is False


@pytest.mark.asyncio
async def test_runtime_gate_proof_must_be_fresh_and_match_current_deployment(db, monkeypatch):
    await _reset_control(db)
    binding = {
        "deployment_id": "deployment-proof",
        "deployed_revision": 12,
        "migration_head": "f9g0h1i2j3k4",
        "dataset_hash": None,
        "runtime_digest": "runtime-digest",
        "deployment_fingerprint": "placeholder",
    }

    async def current_binding(_db):
        return dict(binding)

    monkeypatch.setattr(
        "src.services.beta_evidence_service.current_deployment_binding", current_binding
    )
    validation = {
        "status": "passed",
        "metrics": {
            "critical_safety_pass_rate": 1.0,
            "unconfirmed_write_violations": 0,
            "cross_user_write_violations": 0,
            "duplicate_write_violations": 0,
        },
        "results": {"expired-changeset-01": {"passed": True}},
        "failures": [],
    }
    # Let the imported frozen dataset hash become part of the same current binding.
    original = __import__(
        "src.services.beta_evidence_service", fromlist=["current_deployment_binding"]
    )
    from src.services.evaluation_v2_service import ensure_agent_v25_datasets

    datasets = await ensure_agent_v25_datasets(db)
    dataset = next(row for row in datasets if row.name == "action-runtime-safety-v1")
    binding["dataset_hash"] = dataset.content_hash
    binding["deployment_fingerprint"] = original.canonical_hash(
        {key: value for key, value in binding.items() if key != "deployment_fingerprint"}
    )
    validation["dataset_hash"] = dataset.content_hash
    await persist_runtime_gate_proof(
        db,
        actor="proof-test",
        validation_result=validation,
        started_at=utc_now() - timedelta(minutes=1),
    )
    valid = await runtime_gate_status(db)
    assert valid["valid"] is True
    binding["deployed_revision"] = 13
    mismatch = await runtime_gate_status(db)
    assert mismatch["valid"] is False
    assert "runtime_gate_deployed_revision_mismatch" in mismatch["blockers"]
    binding["deployed_revision"] = 12
    gate = await db.scalar(
        select(OfflineEvaluationGate)
        .where(OfflineEvaluationGate.criteria_version == "agent-v25-runtime-safety-gate-v1")
        .order_by(OfflineEvaluationGate.decided_at.desc())
    )
    criteria = dict(gate.criteria)
    proof = dict(criteria["deployment_binding"])
    proof["expires_at"] = (utc_now() - timedelta(seconds=1)).isoformat()
    criteria["deployment_binding"] = proof
    gate.criteria = criteria
    await db.commit()
    expired = await runtime_gate_status(db)
    assert expired["valid"] is False
    assert "runtime_gate_expired" in expired["blockers"]


@pytest.mark.asyncio
async def test_expired_review_samples_are_cleaned_and_audited(db):
    await _reset_control(db)
    sample = AgentBetaReviewSample(
        source_kind="agent_run",
        source_id=f"expired-{uuid.uuid4()}",
        pseudonymous_user_key="expired-user",
        sample_type="execution_failure",
        retention_expires_at=utc_now() - timedelta(seconds=1),
    )
    db.add(sample)
    await db.commit()
    assert await cleanup_expired_review_samples(db) == 1
    assert await db.get(AgentBetaReviewSample, sample.id) is None
    event = await db.scalar(
        select(AgentBetaControlEvent)
        .where(AgentBetaControlEvent.action == "review_retention_cleanup")
        .order_by(AgentBetaControlEvent.created_at.desc())
    )
    assert event is not None and event.after_state["deleted"] == 1


@pytest.mark.asyncio
async def test_failed_safety_scan_never_writes_observed_clear(db, monkeypatch):
    control = await _reset_control(db)
    user = await _user(db, "scan-failure")
    run = AgentRun(id="scan-failure-run", user_id=user.id, request_text="x", status="completed")
    db.add(run)
    await db.flush()
    step = AgentStep(
        id="scan-failure-step",
        run_id=run.id,
        step_index=0,
        step_key="scan-failure-write",
        tool_name="tasks.apply_changes",
        status="completed",
    )
    db.add(step)
    await db.flush()
    decided_at = utc_now() - timedelta(minutes=1)
    db.add(
        AgentApproval(
            run_id=run.id,
            step_id=step.id,
            status="approved",
            change_set={
                "version": 1,
                "operations": [
                    {"entity": "task", "entity_id": "missing", "field": "status"}
                ],
            },
            change_hash="invalid",
            decided_at=decided_at,
        )
    )
    record_event(
        db,
        run_id=run.id,
        step_id=step.id,
        event_type="executor.completed",
        actor="observer",
    )
    await db.commit()

    async def fail_ownership(*_args, **_kwargs):
        raise RuntimeError("scan dependency failed")

    monkeypatch.setattr(
        "src.services.beta_evidence_service._operation_owned_by_run_user", fail_ownership
    )
    with pytest.raises(RuntimeError, match="scan dependency failed"):
        await scan_hard_safety(
            db,
            audit_start=utc_now() - timedelta(minutes=2),
            audit_end=utc_now() + timedelta(minutes=1),
        )
    await db.refresh(control)
    assert control.safety_snapshot == {}


def test_beta_readiness_tasks_are_registered_with_beat():
    from src.celery_app import celery_app
    from src.tasks import beta_readiness_tasks as _beta_readiness_tasks  # noqa: F401

    assert "src.tasks.beta_readiness_tasks.scan_hard_safety" in celery_app.tasks
    assert "src.tasks.beta_readiness_tasks.normalize_review_samples" in celery_app.tasks
    assert "src.tasks.beta_readiness_tasks.cleanup_review_samples" in celery_app.tasks
    assert {
        "scan-beta-hard-safety",
        "normalize-beta-review-samples",
        "cleanup-beta-review-samples",
    } <= set(celery_app.conf.beat_schedule)


@pytest.mark.asyncio
async def test_admin_cannot_restore_new_actions_without_fresh_gate_and_clear_scan(db, monkeypatch):
    control = await _reset_control(db)
    admin = await _user(db, "restore")
    control.new_action_runs_enabled = False
    await db.commit()

    async def invalid_gate(_db):
        return {"valid": False, "blockers": ["runtime_gate_expired"]}

    async def clear_safety(_db, _control=None):
        return {"status": "observed_clear", "blockers": []}

    monkeypatch.setattr(
        "src.services.beta_evidence_service.runtime_gate_status", invalid_gate
    )
    monkeypatch.setattr("src.services.beta_evidence_service.safety_status", clear_safety)
    with pytest.raises(ValueError, match="runtime_gate_expired"):
        await update_control(
            db,
            actor_id=admin.id,
            reason="attempt boolean bypass",
            new_action_runs_enabled=True,
        )
