"""PMF evidence collection and production decision precedence."""

from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import delete

from src.core.time import utc_now
from src.models import (
    LearningEvent,
    ProductFeedbackSignal,
    User,
    UserDataConsent,
)
from src.services.product_validation_service import (
    generate_product_validation,
    readiness_decision,
)


async def test_pmf_survey_requires_consent_and_is_idempotent(client, auth):
    request_id = f"pmf-{uuid.uuid4().hex}"
    body = {
        "disappointment": "very_disappointed",
        "primary_value": "帮助我持续完成学习任务",
        "request_id": request_id,
    }
    blocked = await client.post("/api/v1/product-evidence/pmf-survey", json=body, headers=auth)
    assert blocked.status_code == 403
    consent = await client.patch(
        "/api/v1/privacy/consent",
        json={"product_analytics_enabled": True, "request_id": f"consent-{uuid.uuid4().hex}"},
        headers=auth,
    )
    assert consent.status_code == 200
    created = await client.post("/api/v1/product-evidence/pmf-survey", json=body, headers=auth)
    retry = await client.post("/api/v1/product-evidence/pmf-survey", json=body, headers=auth)
    assert created.status_code == 201
    assert retry.status_code == 201
    assert retry.json()["id"] == created.json()["id"]


async def test_product_validation_uses_main_route_metric_cohorts_and_windows(db):
    now = utc_now()
    user_ids: list[str] = []
    for index in range(40):
        goal_created_at = now - timedelta(days=60)
        created_at = goal_created_at - timedelta(minutes=5)
        user = User(
            email=f"pmf-{index}-{uuid.uuid4().hex}@test.com",
            username=f"pmf_{uuid.uuid4().hex[:12]}",
            hashed_password="not-used",
            timezone="UTC",
            created_at=created_at,
        )
        db.add(user)
        await db.flush()
        user_ids.append(user.id)
        db.add(UserDataConsent(user_id=user.id, product_analytics_enabled=True))
        db.add(
            ProductFeedbackSignal(
                user_id=user.id,
                signal_type="pmf_survey",
                value={
                    "disappointment": (
                        "very_disappointed" if index < 16 else "somewhat_disappointed"
                    ),
                    "primary_value": "consistent execution",
                },
                request_id=f"pmf-signal-{uuid.uuid4().hex}",
                occurred_at=now,
            )
        )
        goal_id = f"goal-{uuid.uuid4().hex}"
        first_task_id = f"first-task-{uuid.uuid4().hex}"

        def add_event(
            event_type: str,
            *,
            at,
            aggregate_id: str,
            aggregate_type: str = "task",
            payload: dict | None = None,
            event_id: str | None = None,
        ) -> None:
            db.add(
                LearningEvent(
                    id=event_id or str(uuid.uuid4()),
                    user_id=user.id,
                    goal_id=goal_id,
                    aggregate_type=aggregate_type,
                    aggregate_id=aggregate_id,
                    event_type=event_type,
                    source="user_action",
                    payload=payload or {},
                    occurred_at=at,
                    version=1,
                )
            )

        add_event(
            "GoalCreated",
            at=goal_created_at,
            aggregate_id=goal_id,
            aggregate_type="goal",
        )
        add_event(
            "TaskStarted",
            at=goal_created_at + timedelta(hours=1),
            aggregate_id=first_task_id,
        )
        first_action_at = goal_created_at + timedelta(hours=6)
        add_event("TaskCompleted", at=first_action_at, aggregate_id=first_task_id)
        add_event(
            "MasteryEvidenceAdded",
            at=first_action_at + timedelta(hours=1),
            aggregate_id=first_task_id,
            aggregate_type="mastery_evidence",
            payload={"evidence_type": "explanation", "quality": "model_scored"},
        )

        for lifecycle_day, suffix in ((25, "w4"), (53, "w8")):
            action_at = goal_created_at + timedelta(days=lifecycle_day)
            task_id = f"{suffix}-task-{uuid.uuid4().hex}"
            add_event("TaskCompleted", at=action_at, aggregate_id=task_id)
            add_event(
                "MasteryEvidenceAdded",
                at=action_at + timedelta(minutes=10),
                aggregate_id=task_id,
                aggregate_type="mastery_evidence",
            )
            add_event(
                "CheckinSubmitted",
                at=action_at + timedelta(minutes=20),
                aggregate_id=f"{suffix}-checkin-{uuid.uuid4().hex}",
                aggregate_type="checkin",
                payload={"completion_rate": 1.0},
            )

        deviation_at = now - timedelta(days=10)
        deviation_id = f"deviation-{uuid.uuid4().hex}"
        add_event(
            "DeviationDetected",
            at=deviation_at,
            aggregate_id=deviation_id,
            aggregate_type="deviation",
            event_id=deviation_id,
        )
        add_event(
            "RecoverySelected",
            at=deviation_at + timedelta(hours=1),
            aggregate_id=deviation_id,
            aggregate_type="recovery",
            payload={"deviation_event_id": deviation_id, "strategy": "standard"},
        )
        add_event(
            "RecoveryCompleted",
            at=deviation_at + timedelta(hours=24),
            aggregate_id=deviation_id,
            aggregate_type="recovery",
            payload={"deviation_event_id": deviation_id, "within_72h": True},
        )
    await db.commit()

    report = await generate_product_validation(db)
    assert report["status"] == "supported"
    assert report["schema_version"] == "product-validation-v2"
    assert report["metrics"]["survey_count"] >= 40
    assert report["metrics"]["very_disappointed_rate"] >= 0.4
    assert report["metrics"]["goal_created_10m_rate"] == 1.0
    assert report["metrics"]["first_task_started_24h_rate"] == 1.0
    assert report["metrics"]["activation_24h_rate"] == 1.0
    assert report["metrics"]["first_action_evidence_rate"] == 1.0
    assert report["metrics"]["week4_wvlu_retention_rate"] == 1.0
    assert report["metrics"]["week8_wvlu_retention_rate"] == 1.0
    assert report["metrics"]["recovery_selected_rate"] == 1.0
    assert report["metrics"]["recovery_72h_rate"] == 1.0
    assert report["rate_details"]["activation_24h_rate"] == {
        "numerator": 40,
        "denominator": 40,
        "value": 1.0,
    }
    assert report["rate_details"]["overload_rate_28d"]["denominator"] > 0
    assert "左闭右开" in report["measurement_policy"]["interval"]

    await db.execute(delete(LearningEvent).where(LearningEvent.user_id.in_(user_ids)))
    await db.execute(
        delete(ProductFeedbackSignal).where(ProductFeedbackSignal.user_id.in_(user_ids))
    )
    await db.execute(delete(UserDataConsent).where(UserDataConsent.user_id.in_(user_ids)))
    await db.execute(delete(User).where(User.id.in_(user_ids)))
    await db.commit()


async def test_overload_rate_is_unknown_without_task_outcome_denominator(db):
    report = await generate_product_validation(db)
    assert report["metrics"]["task_outcome_28d_count"] == 0
    assert report["metrics"]["overload_rate_28d"] is None
    assert report["rate_details"]["overload_rate_28d"] == {
        "numerator": 0,
        "denominator": 0,
        "value": None,
    }


async def test_first_action_evidence_rate_excludes_unmatured_24h_window(db):
    now = utc_now()
    user_ids: list[str] = []

    async def add_activated_user(
        *,
        label: str,
        goal_created_at,
        first_action_at,
        with_evidence: bool,
    ) -> None:
        user = User(
            email=f"evidence-{label}-{uuid.uuid4().hex}@test.com",
            username=f"evidence_{uuid.uuid4().hex[:12]}",
            hashed_password="not-used",
            timezone="UTC",
            created_at=goal_created_at - timedelta(minutes=5),
        )
        db.add(user)
        await db.flush()
        user_ids.append(user.id)
        db.add(UserDataConsent(user_id=user.id, product_analytics_enabled=True))

        goal_id = f"goal-{uuid.uuid4().hex}"
        task_id = f"task-{uuid.uuid4().hex}"
        db.add_all(
            [
                LearningEvent(
                    user_id=user.id,
                    goal_id=goal_id,
                    aggregate_type="goal",
                    aggregate_id=goal_id,
                    event_type="GoalCreated",
                    source="user_action",
                    payload={},
                    occurred_at=goal_created_at,
                    version=1,
                ),
                LearningEvent(
                    user_id=user.id,
                    goal_id=goal_id,
                    aggregate_type="task",
                    aggregate_id=task_id,
                    event_type="TaskCompleted",
                    source="user_action",
                    payload={},
                    occurred_at=first_action_at,
                    version=1,
                ),
            ]
        )
        if with_evidence:
            db.add(
                LearningEvent(
                    user_id=user.id,
                    goal_id=goal_id,
                    aggregate_type="mastery_evidence",
                    aggregate_id=task_id,
                    event_type="MasteryEvidenceAdded",
                    source="user_action",
                    payload={"evidence_type": "explanation"},
                    occurred_at=first_action_at + timedelta(hours=1),
                    version=1,
                )
            )

    # 已满 24 小时的首次完成进入分母；没有证据，因此是一个失败样本。
    await add_activated_user(
        label="mature",
        goal_created_at=now - timedelta(hours=48),
        first_action_at=now - timedelta(hours=25),
        with_evidence=False,
    )
    # 尚未满 24 小时的首次完成即使已有证据，也不能提前进入分母或分子。
    await add_activated_user(
        label="unmature",
        goal_created_at=now - timedelta(hours=30),
        first_action_at=now - timedelta(hours=23),
        with_evidence=True,
    )
    await db.commit()

    report = await generate_product_validation(db)
    assert report["metrics"]["first_action_evidence_cohort"] == 1
    assert report["metrics"]["first_action_evidence_rate"] == 0.0

    await db.execute(delete(LearningEvent).where(LearningEvent.user_id.in_(user_ids)))
    await db.execute(delete(UserDataConsent).where(UserDataConsent.user_id.in_(user_ids)))
    await db.execute(delete(User).where(User.id.in_(user_ids)))
    await db.commit()


def test_release_decision_prioritizes_safety_then_evidence_then_go():
    supported_core = {"all_supported": True}
    supported_product = {"status": "supported"}
    safe_canary = {
        "status": "running",
        "current_stage": "100",
        "advance_blockers": [],
    }
    assert readiness_decision(
        core=supported_core, product=supported_product, canary=safe_canary
    ) == ("go", [])

    hold, hold_reasons = readiness_decision(
        core={"all_supported": False}, product=supported_product, canary=safe_canary
    )
    assert hold == "hold"
    assert "core_experiments_not_supported" in hold_reasons

    rollback, rollback_reasons = readiness_decision(
        core={"all_supported": False},
        product={"status": "insufficient_data"},
        canary={
            "status": "running",
            "current_stage": "5",
            "advance_blockers": ["critical_safety_incident", "minimum_exposures"],
        },
    )
    assert rollback == "rollback"
    assert rollback_reasons[0] == "critical_safety_incident"
