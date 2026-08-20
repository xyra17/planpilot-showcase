"""Learning-data consent, portability, and evidence quality contracts."""

from __future__ import annotations

import uuid
from datetime import date, timedelta

from sqlalchemy import func, select

from src.core.time import utc_now
from src.models import (
    ConsentAuditEvent,
    DataExportAudit,
    DataQualitySnapshot,
    LearnerPattern,
    LearnerProfile,
    LearningEvent,
    User,
)
from src.services import privacy_service


async def _current_user(client, auth, db) -> User:
    response = await client.get("/api/v1/auth/me", headers=auth)
    return await db.get(User, response.json()["id"])


async def test_consent_withdrawal_is_idempotent_and_erases_derivatives(client, auth, db):
    user = await _current_user(client, auth, db)
    defaults = await client.get("/api/v1/privacy/consent", headers=auth)
    assert defaults.status_code == 200
    assert defaults.json()["personalization_enabled"] is True
    assert defaults.json()["experiments_enabled"] is False

    db.add(
        LearnerProfile(
            user_id=user.id,
            goal_id=None,
            event_count=20,
            observation_window_days=30,
        )
    )
    db.add(
        LearnerPattern(
            user_id=user.id,
            goal_id=None,
            pattern_type="preferred_study_time",
            pattern_value={"hour": 20},
            confidence=0.8,
            evidence_count=20,
            scope="user",
            decay_rate=0.05,
            status="active",
            first_observed_at=utc_now(),
            last_confirmed_at=utc_now(),
        )
    )
    await db.commit()

    request_id = f"privacy-{uuid.uuid4().hex}"
    body = {
        "personalization_enabled": False,
        "erase_derived_data": True,
        "request_id": request_id,
    }
    withdrawn = await client.patch("/api/v1/privacy/consent", json=body, headers=auth)
    assert withdrawn.status_code == 200, withdrawn.text
    assert withdrawn.json()["derived_data_erased"] is True
    assert await db.scalar(
        select(func.count()).select_from(LearnerProfile).where(LearnerProfile.user_id == user.id)
    ) == 0
    assert await db.scalar(
        select(func.count()).select_from(LearnerPattern).where(LearnerPattern.user_id == user.id)
    ) == 0
    blocked = await client.post("/api/v1/learner/profile/rebuild", headers=auth)
    assert blocked.status_code == 403

    retry = await client.patch("/api/v1/privacy/consent", json=body, headers=auth)
    assert retry.status_code == 200
    audit_count = await db.scalar(
        select(func.count())
        .select_from(ConsentAuditEvent)
        .where(ConsentAuditEvent.request_id == request_id)
    )
    assert audit_count == 1


async def test_user_export_is_allowlisted_and_audited(client, auth, db):
    user = await _current_user(client, auth, db)
    created = await client.post(
        "/api/v1/goals",
        headers=auth,
        json={
            "type": "skill",
            "title": "可携带目标",
            "deadline": (date.today() + timedelta(days=30)).isoformat(),
        },
    )
    assert created.status_code == 201
    exported = await client.get("/api/v1/privacy/export", headers=auth)
    assert exported.status_code == 200, exported.text
    assert "attachment" in exported.headers["content-disposition"]
    payload = exported.json()
    assert payload["schema_version"] == "planpilot-user-export-v1"
    assert payload["account"]["id"] == user.id
    assert "hashed_password" not in payload["account"]
    assert any(row["title"] == "可携带目标" for row in payload["data"]["goals"])
    assert await db.scalar(
        select(func.count()).select_from(DataExportAudit).where(DataExportAudit.user_id == user.id)
    ) == 1


async def test_quality_report_exposes_evidence_gaps_and_persists_snapshot(client, auth, db):
    user = await _current_user(client, auth, db)
    for index in range(30):
        db.add(
            LearningEvent(
                user_id=user.id,
                goal_id=None,
                aggregate_type="checkin",
                aggregate_id=f"quality-{uuid.uuid4().hex}",
                event_type="CheckinSubmitted",
                source="user_action",
                payload={"completion_rate": 0.5},
                occurred_at=utc_now() - timedelta(days=index % 15),
                version=1,
            )
        )
    await db.commit()

    response = await client.post(
        "/api/v1/privacy/quality-report?window_days=90", headers=auth
    )
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["metrics"]["event_count"] >= 30
    assert report["metrics"]["active_days"] >= 14
    assert report["checks"]["minimum_event_volume"] is True
    assert report["experiment_readiness"]["pattern"] is True
    assert await db.scalar(
        select(func.count())
        .select_from(DataQualitySnapshot)
        .where(DataQualitySnapshot.user_id == user.id)
    ) == 1


async def test_retention_policy_deletes_only_expired_learning_events(
    client, auth, db, monkeypatch
):
    user = await _current_user(client, auth, db)
    now = utc_now()
    monkeypatch.setattr(privacy_service.settings, "learning_event_retention_days", 30)
    old = LearningEvent(
        user_id=user.id,
        goal_id=None,
        aggregate_type="task",
        aggregate_id="old-retention-event",
        event_type="TaskCompleted",
        source="user_action",
        payload={},
        occurred_at=now - timedelta(days=31),
        version=1,
    )
    current = LearningEvent(
        user_id=user.id,
        goal_id=None,
        aggregate_type="task",
        aggregate_id="current-retention-event",
        event_type="TaskCompleted",
        source="user_action",
        payload={},
        occurred_at=now - timedelta(days=29),
        version=1,
    )
    db.add_all([old, current])
    await db.commit()

    result = await privacy_service.apply_retention_policy(db, now=now)
    assert result["learning_events"] >= 1
    assert await db.get(LearningEvent, old.id) is None
    assert await db.get(LearningEvent, current.id) is not None
