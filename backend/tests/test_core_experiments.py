"""Evidence tests for the four core product-learning claims."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from sqlalchemy import delete, func, select

from src.core.time import utc_now
from src.models import (
    AgentFeedbackEvent,
    AgentInvocation,
    DecisionProposal,
    Experiment,
    ExperimentAssignment,
    ExperimentVariant,
    LearnerCognitiveProfile,
    LearnerPattern,
    LearningEvent,
    LearningExperimentReport,
    PredictionObservation,
    ProposalFeedback,
    User,
    UserDataConsent,
)
from src.services.agent_control_service import ensure_baseline
from src.services.core_experiment_service import latest_public_snapshot, run_core_experiments
from src.services.proposal_service import generate_proposal


async def _cleanup_users(db, user_ids: list[str]) -> None:
    for model in (
        AgentFeedbackEvent,
        AgentInvocation,
        ProposalFeedback,
        DecisionProposal,
        PredictionObservation,
        LearnerCognitiveProfile,
        LearnerPattern,
        LearningEvent,
        ExperimentAssignment,
        UserDataConsent,
    ):
        await db.execute(delete(model).where(model.user_id.in_(user_ids)))
    await db.execute(delete(User).where(User.id.in_(user_ids)))
    await db.commit()


async def test_three_observable_claims_are_supported_and_reports_are_persisted(db):
    report_count_before = int(
        await db.scalar(select(func.count()).select_from(LearningExperimentReport)) or 0
    )
    user = User(
        email=f"core-experiment-{uuid.uuid4().hex}@test.com",
        username=f"core_exp_{uuid.uuid4().hex[:10]}",
        hashed_password="not-used",
        timezone="UTC",
    )
    db.add(user)
    await db.flush()
    db.add(
        UserDataConsent(
            user_id=user.id,
            personalization_enabled=True,
            experiments_enabled=True,
        )
    )
    now = utc_now()

    for index in range(30):
        for hour, rate, label in ((15, 0.41, "afternoon"), (20, 0.82, "evening")):
            occurred_at = datetime.combine(
                (now - timedelta(days=index)).date(), datetime.min.time()
            ).replace(hour=hour)
            db.add(
                LearningEvent(
                    user_id=user.id,
                    goal_id=None,
                    aggregate_type="checkin",
                    aggregate_id=f"{label}-{index}-{uuid.uuid4().hex}",
                    event_type="CheckinSubmitted",
                    source="user_action",
                    payload={"completion_rate": rate},
                    occurred_at=occurred_at,
                    version=1,
                )
            )

    for index in range(100):
        db.add(
            PredictionObservation(
                user_id=user.id,
                goal_id=None,
                task_id=None,
                prediction_type="task_failure",
                algorithm_version="failure-heuristic-v1",
                predicted_probability=0.72,
                feature_snapshot={},
                prediction_key=f"calibration-{uuid.uuid4().hex}",
                predicted_at=now - timedelta(days=1),
                outcome_due_at=now - timedelta(hours=1),
                actual_outcome=index < 72,
                actual_value=1.0 if index < 72 else 0.0,
                outcome_source="test_outcome",
                outcome_recorded_at=now,
            )
        )

    for _ in range(50):
        proposal = DecisionProposal(
            user_id=user.id,
            goal_id=None,
            proposal_type="reduce_daily_load",
            title="降低负荷",
            confidence=0.8,
            status="applied",
            applied_at=now - timedelta(days=8),
        )
        db.add(proposal)
        await db.flush()
        for days, completion, delta in ((1, 0.5, 0.1), (7, 0.7, 0.3)):
            db.add(
                AgentFeedbackEvent(
                    user_id=user.id,
                    goal_id=None,
                    proposal_id=proposal.id,
                    feedback_type=f"completion_rate_{days}d",
                    value={
                        "completion_rate": completion,
                        "baseline_completion_rate": completion - delta,
                        "completion_delta": delta,
                    },
                    attribution_window=f"{days}d",
                    metric_version="v1",
                    dedupe_key=f"proposal:{proposal.id}:completion_rate_{days}d:v1",
                    occurred_at=now,
                )
            )
    await db.commit()

    suite = await run_core_experiments(db, window_days=90)
    reports = {row["experiment_key"]: row for row in suite["reports"]}
    assert reports["pattern_validity"]["status"] == "supported"
    assert reports["pattern_validity"]["buckets"]["evening"]["completion_rate"] == 0.82
    assert reports["pattern_validity"]["buckets"]["afternoon"]["completion_rate"] == 0.41
    assert reports["prediction_calibration"]["status"] == "supported"
    assert reports["prediction_calibration"]["expected_calibration_error"] == 0.0
    assert reports["proposal_utility"]["status"] == "supported"
    assert reports["proposal_utility"]["seven_day"]["mean_delta"] == 0.3
    assert reports["personalization_lift"]["status"] == "not_configured"
    assert suite["all_supported"] is False
    snapshot = await latest_public_snapshot(db)
    latest = {row["experiment_key"]: row for row in snapshot["reports"]}
    assert latest["pattern_validity"]["status"] == "supported"
    assert latest["prediction_calibration"]["result"]["brier_score"] is not None
    assert latest["pattern_validity"]["provenance"]["data_origin"] == "consented_learning_data"
    assert latest["pattern_validity"]["provenance"]["window_days"] == 90
    assert snapshot["generated_at"]
    report_count_after = int(
        await db.scalar(select(func.count()).select_from(LearningExperimentReport)) or 0
    )
    assert report_count_after == report_count_before + 4
    await _cleanup_users(db, [user.id])


async def test_personalization_experiment_measures_lift_and_overload_guardrail(db):
    runtime = await ensure_baseline(db)
    experiment = Experiment(
        name=f"personalization-{uuid.uuid4().hex}",
        hypothesis="Learner Model improves long-term outcomes",
        agent_type="coach",
        environment="test",
        status="completed",
        allocation_percent=100,
        primary_metric="completion",
        minimum_sample_size=20,
        created_by="test",
    )
    db.add(experiment)
    await db.flush()
    control = ExperimentVariant(
        experiment_id=experiment.id,
        key="no_personalization",
        display_name="No personalization",
        traffic_weight=0.5,
        prompt_version_id=runtime.prompt.id,
        model_config_id=runtime.model.id,
        policy_version_id=runtime.policy.id,
        is_control=True,
    )
    treatment = ExperimentVariant(
        experiment_id=experiment.id,
        key="learner_model",
        display_name="Learner Model personalization",
        traffic_weight=0.5,
        prompt_version_id=runtime.prompt.id,
        model_config_id=runtime.model.id,
        policy_version_id=runtime.policy.id,
        is_control=False,
    )
    db.add_all([control, treatment])
    await db.flush()
    assigned_at = utc_now() - timedelta(days=2)
    created_users = []
    for variant, completed_count, skipped_count, retention in (
        (control, 5, 5, 0.60),
        (treatment, 8, 2, 0.75),
    ):
        for user_index in range(20):
            user = User(
                email=f"{variant.key}-{user_index}-{uuid.uuid4().hex}@test.com",
                username=f"exp_{uuid.uuid4().hex[:12]}",
                hashed_password="not-used",
                timezone="UTC",
            )
            db.add(user)
            await db.flush()
            created_users.append(user)
            db.add(UserDataConsent(user_id=user.id, experiments_enabled=True))
            db.add(
                ExperimentAssignment(
                    experiment_id=experiment.id,
                    user_id=user.id,
                    variant_id=variant.id,
                    bucket=user_index,
                    assignment_version="v1",
                    eligibility_snapshot={"eligible": True},
                    assigned_at=assigned_at,
                )
            )
            db.add(
                LearnerCognitiveProfile(
                    user_id=user.id,
                    goal_id=None,
                    retention_rate=retention,
                    sample_count=20,
                    confidence=0.8,
                )
            )
            for event_index in range(completed_count):
                db.add(
                    LearningEvent(
                        user_id=user.id,
                        goal_id=None,
                        aggregate_type="task",
                        aggregate_id=f"completed-{uuid.uuid4().hex}",
                        event_type="TaskCompleted",
                        source="user_action",
                        payload={"days_overdue": int(event_index < completed_count / 2)},
                        occurred_at=utc_now() - timedelta(days=1),
                        version=1,
                    )
                )
            for _ in range(skipped_count):
                db.add(
                    LearningEvent(
                        user_id=user.id,
                        goal_id=None,
                        aggregate_type="task",
                        aggregate_id=f"skipped-{uuid.uuid4().hex}",
                        event_type="TaskSkipped",
                        source="user_action",
                        payload={},
                        occurred_at=utc_now() - timedelta(days=1),
                        version=1,
                    )
                )
            for mastery_index in range(5):
                db.add(
                    LearningEvent(
                        user_id=user.id,
                        goal_id=None,
                        aggregate_type="task",
                        aggregate_id=f"mastery-{uuid.uuid4().hex}",
                        event_type="MasteryRecorded",
                        source="user_action",
                        payload={
                            "to_level": (
                                "L3"
                                if mastery_index < (2 if variant.is_control else 4)
                                else "L2"
                            )
                        },
                        occurred_at=utc_now() - timedelta(days=1),
                        version=1,
                    )
                )
    await db.commit()

    suite = await run_core_experiments(
        db, window_days=90, experiment_id=experiment.id
    )
    report = next(
        row for row in suite["reports"] if row["experiment_key"] == "personalization_lift"
    )
    assert report["status"] == "supported"
    assert report["treatment_minus_control"]["completion"] == 0.3
    assert report["treatment_minus_control"]["retention"] == 0.15
    assert report["treatment_minus_control"]["overload"] == -0.3
    await _cleanup_users(db, [user.id for user in created_users])
    await db.delete(experiment)
    await db.commit()


async def test_no_personalization_variant_uses_real_scrubbed_control_path(db):
    runtime = await ensure_baseline(db)
    user = User(
        email=f"control-{uuid.uuid4().hex}@test.com",
        username=f"control_{uuid.uuid4().hex[:12]}",
        hashed_password="not-used",
        timezone="UTC",
    )
    db.add(user)
    await db.flush()
    db.add(UserDataConsent(user_id=user.id, experiments_enabled=True))
    db.add(
        LearnerPattern(
            user_id=user.id,
            goal_id=None,
            pattern_type="delay_pattern",
            pattern_value={"chronic_delay_rate": 0.8},
            confidence=0.9,
            evidence_count=30,
            scope="user",
            decay_rate=0.05,
            status="active",
            first_observed_at=utc_now() - timedelta(days=30),
            last_confirmed_at=utc_now(),
        )
    )
    experiment = Experiment(
        name=f"real-control-{uuid.uuid4().hex}",
        hypothesis="A real no-personalization control is required",
        agent_type="coach",
        environment=runtime.deployment.environment,
        status="running",
        allocation_percent=100,
        primary_metric="completion",
        minimum_sample_size=20,
        created_by="test",
        start_at=utc_now() - timedelta(minutes=1),
    )
    db.add(experiment)
    await db.flush()
    for key, is_control in (("control_a", True), ("control_b", False)):
        db.add(
            ExperimentVariant(
                experiment_id=experiment.id,
                key=key,
                display_name=key,
                traffic_weight=0.5,
                prompt_version_id=runtime.prompt.id,
                model_config_id=runtime.model.id,
                policy_version_id=runtime.policy.id,
                is_control=is_control,
                treatment_config={"personalization_enabled": False},
            )
        )
    await db.commit()

    proposals = await generate_proposal(user.id, db, goal_id=None)
    assert len(proposals) == 1
    assert proposals[0]["proposal_type"] == "learning_nudge"
    assert proposals[0]["evidence_references"] == []
    assert "不使用长期学习画像" in proposals[0]["summary"]
    invocation = await db.scalar(
        select(AgentInvocation).where(AgentInvocation.proposal_id == proposals[0]["id"])
    )
    assert invocation.experiment_id == experiment.id

    await db.delete(experiment)
    await db.commit()
    await _cleanup_users(db, [user.id])
