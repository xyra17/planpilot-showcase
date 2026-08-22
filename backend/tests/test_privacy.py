"""Learning-data consent, portability, and evidence quality contracts."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from unittest.mock import AsyncMock, patch

from sqlalchemy import func, select

from src.core.time import utc_now
from src.intelligence.cognitive_model import CognitiveProfileBuilder
from src.models import (
    ConsentAuditEvent,
    DataExportAudit,
    DataQualitySnapshot,
    DecisionProposal,
    KnowledgeBase,
    KnowledgeChunk,
    KnowledgeEdge,
    KnowledgeItem,
    KnowledgeItemFileVersion,
    KnowledgeItemGoalLink,
    KnowledgeItemLibraryLink,
    LearnerCognitiveProfile,
    LearnerPattern,
    LearnerProfile,
    LearningConcept,
    LearningEvent,
    LearningMemory,
    ProposalFeedback,
    Task,
    TaskMasteryRecord,
    User,
)
from src.services import privacy_service
from src.services.chat_context import build_chat_context


async def _current_user(client, auth, db) -> User:
    response = await client.get("/api/v1/auth/me", headers=auth)
    return await db.get(User, response.json()["id"])


async def test_consent_can_disable_then_erase_retained_derivatives_idempotently(client, auth, db):
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
    db.add(
        LearningMemory(
            user_id=user.id,
            goal_id=None,
            memory_type="coach_preference",
            summary="用户偏好晚上学习",
            importance=0.8,
            occurred_at=utc_now(),
        )
    )
    await db.commit()

    disabled = await client.patch(
        "/api/v1/privacy/consent",
        json={
            "personalization_enabled": False,
            "request_id": f"privacy-{uuid.uuid4().hex}",
        },
        headers=auth,
    )
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["derived_data_erased"] is False
    assert await db.scalar(
        select(func.count()).select_from(LearnerProfile).where(LearnerProfile.user_id == user.id)
    ) == 1
    with patch(
        "src.services.chat_context._load_knowledge",
        new=AsyncMock(
            return_value=[
                {"title": "用户主动检索的笔记", "snippet": "资料正文", "score": 0.9}
            ]
        ),
    ):
        chat_context, _ = await build_chat_context(
            user_id=user.id, goal_id=None, message="根据我上传的资料回答"
        )
    assert chat_context.get("profile") is None
    assert chat_context.get("cognitive_profile") is None
    assert chat_context.get("patterns") == []
    assert chat_context.get("memories") == []
    assert chat_context.get("recent_events") == []
    assert chat_context["knowledge_sources"][0]["title"] == "用户主动检索的笔记"

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
    assert await db.scalar(
        select(func.count()).select_from(LearningMemory).where(LearningMemory.user_id == user.id)
    ) == 0
    blocked = await client.post("/api/v1/learner/profile/rebuild", headers=auth)
    assert blocked.status_code == 403

    retry = await client.patch("/api/v1/privacy/consent", json=body, headers=auth)
    assert retry.status_code == 200
    assert retry.json()["derived_data_erased"] is True
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
    goal_id = created.json()["id"]
    kb = KnowledgeBase(user_id=user.id, goal_id=goal_id, name="算法资料")
    task = Task(
        goal_id=goal_id,
        title="复习二分查找",
        scheduled_date=date.today().isoformat(),
        estimated_mins=25,
    )
    item = KnowledgeItem(
        user_id=user.id,
        goal_id=goal_id,
        title="二分查找笔记",
        content="每次折半缩小搜索区间。",
        file_path="/server/private/upload.md",
        embedding=[0.1] * 1024,
    )
    concept = LearningConcept(
        user_id=user.id,
        goal_id=goal_id,
        name="二分查找",
        normalized_name="二分查找",
        description="有序数组搜索",
    )
    memory = LearningMemory(
        user_id=user.id,
        goal_id=goal_id,
        memory_type="export_regression",
        summary="用于验证元数据列可序列化",
        metadata_json={"source": "privacy-test"},
        occurred_at=utc_now(),
    )
    db.add_all([kb, task, item, concept, memory])
    await db.flush()
    db.add_all(
        [
            TaskMasteryRecord(
                task_id=task.id,
                goal_id=goal_id,
                user_id=user.id,
                mastery_level="L2",
                source="manual",
                notes="用户手动更新",
            ),
            KnowledgeItemGoalLink(item_id=item.id, goal_id=goal_id),
            KnowledgeItemLibraryLink(item_id=item.id, kb_id=kb.id),
            KnowledgeItemFileVersion(
                item_id=item.id,
                file_path="/server/private/version.md",
                filename="version.md",
                content="版本正文",
            ),
            KnowledgeChunk(
                item_id=item.id,
                chunk_index=0,
                content="折半搜索片段",
                start_char=0,
                end_char=6,
                embedding=[0.2] * 1024,
            ),
            KnowledgeEdge(
                user_id=user.id,
                source_concept_id=concept.id,
                resource_item_id=item.id,
                relation_type="supported_by",
            ),
        ]
    )
    await db.commit()
    exported = await client.get("/api/v1/privacy/export", headers=auth)
    assert exported.status_code == 200, exported.text
    assert "attachment" in exported.headers["content-disposition"]
    payload = exported.json()
    assert payload["schema_version"] == "planpilot-user-export-v1"
    assert payload["account"]["id"] == user.id
    assert "hashed_password" not in payload["account"]
    assert any(row["title"] == "可携带目标" for row in payload["data"]["goals"])
    assert any(row["title"] == "复习二分查找" for row in payload["data"]["tasks"])
    assert payload["data"]["goal_versions"][0]["title_snapshot"] == "可携带目标"
    assert payload["data"]["task_mastery_records"][0]["notes"] == "用户手动更新"
    assert payload["data"]["learning_concepts"][0]["name"] == "二分查找"
    assert payload["data"]["knowledge_edges"][0]["resource_item_id"] == item.id
    assert payload["data"]["knowledge_item_goal_links"][0]["goal_id"] == goal_id
    assert payload["data"]["knowledge_item_library_links"][0]["kb_id"] == kb.id
    assert payload["data"]["knowledge_item_file_versions"][0]["content"] == "版本正文"
    assert "file_path" not in payload["data"]["knowledge_item_file_versions"][0]
    assert payload["data"]["knowledge_chunks"][0]["content"] == "折半搜索片段"
    assert "embedding" not in payload["data"]["knowledge_chunks"][0]
    assert payload["data"]["learning_memories"][0]["metadata"] == {
        "source": "privacy-test"
    }
    exported_item = next(row for row in payload["data"]["knowledge_items"] if row["id"] == item.id)
    assert "file_path" not in exported_item
    assert "embedding" not in exported_item
    assert "authentication_secrets" in payload["scope"]["excluded"]
    assert await db.scalar(
        select(func.count()).select_from(DataExportAudit).where(DataExportAudit.user_id == user.id)
    ) == 1


async def test_sensitive_inference_is_opt_in_and_cleared_when_disabled(client, auth, db):
    user = await _current_user(client, auth, db)
    await client.get("/api/v1/privacy/consent", headers=auth)
    db.add(
        LearningEvent(
            user_id=user.id,
            goal_id=None,
            aggregate_type="task",
            aggregate_id=f"sensitive-{uuid.uuid4().hex}",
            event_type="TaskSkipped",
            source="user_action",
            payload={},
            occurred_at=utc_now(),
            version=1,
        )
    )
    proposal = DecisionProposal(
        user_id=user.id,
        proposal_type="schedule_adjustment",
        title="敏感推断测试提案",
        summary="只用于验证关闭时不加载反馈",
        confidence=0.8,
        status="accepted",
    )
    db.add(proposal)
    await db.flush()
    db.add(
        ProposalFeedback(
            proposal_id=proposal.id,
            user_id=user.id,
            outcome="helpful",
        )
    )
    await db.commit()

    execute_spy = AsyncMock(wraps=db.execute)
    with patch.object(db, "execute", new=execute_spy), patch.object(
        CognitiveProfileBuilder,
        "_calculate_sensitive_metrics",
        autospec=True,
    ) as sensitive_calculator:
        await CognitiveProfileBuilder.build_for_user(db, user.id)
    sensitive_calculator.assert_not_called()
    assert not any(
        "proposal_feedback" in str(call.args[0]).lower()
        for call in execute_spy.call_args_list
        if call.args
    )
    await db.commit()
    profile = await db.scalar(
        select(LearnerCognitiveProfile).where(
            LearnerCognitiveProfile.user_id == user.id,
            LearnerCognitiveProfile.goal_id.is_(None),
        )
    )
    assert profile is not None
    assert profile.forgetting_rate is not None
    assert profile.procrastination_score is None
    assert profile.persistence_score is None
    assert profile.challenge_tolerance is None
    assert profile.feedback_acceptance is None
    default_context, _ = await build_chat_context(
        user_id=user.id, goal_id=None, message="根据我的情况复盘"
    )
    cognitive_context = default_context.get("cognitive_profile") or {}
    assert "procrastination_score" not in cognitive_context
    assert "persistence_score" not in cognitive_context
    assert "challenge_tolerance" not in cognitive_context
    assert "feedback_acceptance" not in cognitive_context

    enabled = await client.patch(
        "/api/v1/privacy/consent",
        json={
            "sensitive_inference_enabled": True,
            "request_id": f"privacy-{uuid.uuid4().hex}",
        },
        headers=auth,
    )
    assert enabled.status_code == 200
    await CognitiveProfileBuilder.build_for_user(db, user.id)
    await db.commit()
    await db.refresh(profile)
    assert profile.procrastination_score is not None
    enabled_context, _ = await build_chat_context(
        user_id=user.id, goal_id=None, message="根据我的情况复盘"
    )
    assert (enabled_context.get("cognitive_profile") or {}).get("procrastination_score") is not None

    disabled = await client.patch(
        "/api/v1/privacy/consent",
        json={
            "sensitive_inference_enabled": False,
            "request_id": f"privacy-{uuid.uuid4().hex}",
        },
        headers=auth,
    )
    assert disabled.status_code == 200
    await db.refresh(profile)
    assert profile.procrastination_score is None
    assert profile.persistence_score is None
    assert profile.challenge_tolerance is None
    assert profile.feedback_acceptance is None


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
