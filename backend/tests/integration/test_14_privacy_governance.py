"""PostgreSQL privacy lifecycle and physical account erasure."""

import uuid
from datetime import date, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from tests.integration.database import IntegrationSessionLocal as AsyncSessionLocal
from src.models import (
    ConsentAuditEvent,
    DataExportAudit,
    DataQualitySnapshot,
    Goal,
    User,
    UserDataConsent,
)

pytestmark = pytest.mark.integration


async def test_privacy_lifecycle_and_account_erasure(client: AsyncClient):
    suffix = uuid.uuid4().hex[:12]
    registered = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"privacy-{suffix}@test.com",
            "username": f"privacy_{suffix}",
            "password": "testpass123",
        },
    )
    assert registered.status_code == 201, registered.text
    user_id = registered.json()["user"]["id"]
    token = registered.cookies.get("pp_access")
    headers = {"Authorization": f"Bearer {token}"}

    consent = await client.patch(
        "/api/v1/privacy/consent",
        headers=headers,
        json={
            "personalization_enabled": True,
            "experiments_enabled": True,
            "request_id": f"integration-{suffix}",
        },
    )
    assert consent.status_code == 200, consent.text
    goal = await client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "type": "skill",
            "title": "隐私删除验证",
            "deadline": (date.today() + timedelta(days=30)).isoformat(),
        },
    )
    assert goal.status_code == 201, goal.text
    assert (await client.get("/api/v1/privacy/export", headers=headers)).status_code == 200
    assert (
        await client.post("/api/v1/privacy/quality-report", headers=headers)
    ).status_code == 200

    deleted = await client.delete("/api/v1/auth/me", headers=headers)
    assert deleted.status_code == 204, deleted.text

    async with AsyncSessionLocal() as db:
        for model in (
            User,
            Goal,
            UserDataConsent,
            ConsentAuditEvent,
            DataExportAudit,
            DataQualitySnapshot,
        ):
            column = model.id if model is User else model.user_id
            count = await db.scalar(
                select(func.count()).select_from(model).where(column == user_id)
            )
            assert count == 0, model.__tablename__
