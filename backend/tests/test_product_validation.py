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


async def test_product_validation_uses_matured_activation_retention_and_pmf_cohorts(db):
    now = utc_now()
    user_ids: list[str] = []
    for index in range(40):
        created_at = now - timedelta(days=40)
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
        for completed_index in range(3):
            db.add(
                LearningEvent(
                    user_id=user.id,
                    goal_id=None,
                    aggregate_type="task",
                    aggregate_id=f"activation-{completed_index}-{uuid.uuid4().hex}",
                    event_type="TaskCompleted",
                    source="user_action",
                    payload={},
                    occurred_at=created_at + timedelta(days=completed_index + 1),
                    version=1,
                )
            )
        db.add(
            LearningEvent(
                user_id=user.id,
                goal_id=None,
                aggregate_type="checkin",
                aggregate_id=f"retention-{uuid.uuid4().hex}",
                event_type="CheckinSubmitted",
                source="user_action",
                payload={"completion_rate": 1.0},
                occurred_at=created_at + timedelta(days=25),
                version=1,
            )
        )
    await db.commit()

    report = await generate_product_validation(db)
    assert report["status"] == "supported"
    assert report["metrics"]["survey_count"] >= 40
    assert report["metrics"]["very_disappointed_rate"] >= 0.4
    assert report["metrics"]["activation_rate"] == 1.0
    assert report["metrics"]["week4_retention_rate"] == 1.0

    await db.execute(delete(LearningEvent).where(LearningEvent.user_id.in_(user_ids)))
    await db.execute(
        delete(ProductFeedbackSignal).where(ProductFeedbackSignal.user_id.in_(user_ids))
    )
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
