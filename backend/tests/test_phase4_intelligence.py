"""Phase 4 cognitive, memory, adaptive planning, graph and evaluation tests."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select

from src.core.agent_v2.orchestrator import advance_run
from src.core.time import utc_now
from src.intelligence.cognitive_model import knowledge_retention, retention_curve
from src.intelligence.evaluation import evaluate_benchmark, persist_report
from src.intelligence.knowledge_graph import KnowledgeGraphService
from src.intelligence.memory_system import MemoryBuilder
from src.models import (
    AgentRun,
    Goal,
    KnowledgeItem,
    KnowledgeMapVersion,
    LearningConcept,
    LearningEvent,
    MasteryEvidence,
    Task,
    TaskMasteryRecord,
)


def test_forgetting_curve_is_monotonic_and_bounded():
    curve = retention_curve(0.9, 0.05)
    values = [point["retention"] for point in curve]
    assert values == sorted(values, reverse=True)
    assert knowledge_retention(1.5, -1, -3) == 1.0
    assert values[-1] < values[0]


@pytest.mark.asyncio
async def test_cognitive_profile_build_and_context(client, auth, goal_id, db):
    goal = await db.scalar(select(Goal).where(Goal.id == goal_id))
    assert goal is not None
    task = Task(
        id=str(uuid.uuid4()),
        goal_id=goal_id,
        title="认知画像任务",
        estimated_mins=90,
        scheduled_date=date.today().isoformat(),
        status="completed",
        mastery_level="L3",
    )
    db.add(task)
    db.add(
        TaskMasteryRecord(
            task_id=task.id,
            goal_id=goal_id,
            user_id=goal.user_id,
            mastery_level="L3",
            source="manual",
            created_at=utc_now() - timedelta(days=7),
        )
    )
    for event_type in ("TaskCompleted", "CheckinSubmitted"):
        db.add(
            LearningEvent(
                user_id=goal.user_id,
                goal_id=goal_id,
                aggregate_type="task",
                aggregate_id=task.id,
                event_type=event_type,
                payload={"completion_rate": 0.8, "mastery_rate": 0.75},
                occurred_at=utc_now(),
            )
        )
    await db.commit()

    rebuilt = await client.post("/api/v1/learner/profile/rebuild", headers=auth)
    assert rebuilt.status_code == 200, rebuilt.text
    response = await client.get(
        f"/api/v1/learner/cognitive-profile?goal_id={goal_id}", headers=auth
    )
    assert response.status_code == 200
    profile = response.json()["profile"]
    assert profile["retention_rate"] is not None
    assert 0 <= profile["forgetting_rate"] <= 1
    assert len(profile["retention_curve"]) == 6

    context = await client.get(f"/api/v1/learner/decision-context?goal_id={goal_id}", headers=auth)
    assert context.status_code == 200
    assert context.json()["cognitive_profile"]["id"] == profile["id"]
    assert "memories" in context.json()
    assert "knowledge_gaps" in context.json()


@pytest.mark.asyncio
async def test_memory_builder_and_retrieval(client, auth, goal_id, db):
    goal = await db.scalar(select(Goal).where(Goal.id == goal_id))
    assert goal is not None
    event = LearningEvent(
        id=str(uuid.uuid4()),
        user_id=goal.user_id,
        goal_id=goal_id,
        aggregate_type="task",
        aggregate_id=str(uuid.uuid4()),
        event_type="TaskSkipped",
        payload={"title": "闭包练习", "skip_reason": "too_hard"},
        occurred_at=utc_now(),
    )
    db.add(event)
    await db.commit()
    assert await MemoryBuilder.run_batch(db, batch_size=500) > 0

    response = await client.get(
        f"/api/v1/learner/memories?goal_id={goal_id}&query=闭包", headers=auth
    )
    assert response.status_code == 200
    memories = response.json()
    assert any(row["source_event_id"] == event.id for row in memories["episodic"])
    assert {"short_term", "episodic", "semantic"} == set(memories)


@pytest.mark.asyncio
async def test_knowledge_graph_gap_and_next_concept(client, auth, goal_id):
    prerequisite = await client.post(
        "/api/v1/intelligence/concepts",
        headers=auth,
        json={"goal_id": goal_id, "name": "Python Function", "mastery_score": 0.9},
    )
    target = await client.post(
        "/api/v1/intelligence/concepts",
        headers=auth,
        json={"goal_id": goal_id, "name": "Decorator", "mastery_score": 0.2},
    )
    assert prerequisite.status_code == target.status_code == 201
    edge = await client.post(
        "/api/v1/intelligence/edges",
        headers=auth,
        json={
            "source_concept_id": prerequisite.json()["id"],
            "target_concept_id": target.json()["id"],
            "relation_type": "prerequisite",
        },
    )
    assert edge.status_code == 201, edge.text

    gaps = await client.get(f"/api/v1/intelligence/knowledge-gaps?goal_id={goal_id}", headers=auth)
    assert gaps.status_code == 200
    assert any(row["id"] == target.json()["id"] for row in gaps.json())
    explanation = await client.get(
        f"/api/v1/intelligence/concepts/{target.json()['id']}/explain", headers=auth
    )
    assert explanation.status_code == 200
    assert explanation.json()["recommendation"]
    next_rows = await client.get(
        f"/api/v1/intelligence/next-concepts?goal_id={goal_id}", headers=auth
    )
    assert any(row["id"] == target.json()["id"] for row in next_rows.json())


@pytest.mark.asyncio
async def test_build_knowledge_map_is_source_linked_and_reviewable(client, auth, goal_id, db):
    goal = await db.scalar(select(Goal).where(Goal.id == goal_id))
    assert goal is not None
    item = KnowledgeItem(
        id=str(uuid.uuid4()),
        user_id=goal.user_id,
        goal_id=goal_id,
        title="Python 学习路径.md",
        content="# 条件判断\n## 循环结构\n写出两个可运行示例。",
        normalized_content="# 条件判断\n## 循环结构\n写出两个可运行示例。",
        content_length=36,
        processing_status="ready",
        source_role="scope",
    )
    reference_item = KnowledgeItem(
        id=str(uuid.uuid4()),
        user_id=goal.user_id,
        goal_id=goal_id,
        title="练习参考.md",
        content="# 不应扩大范围的参考章节",
        normalized_content="# 不应扩大范围的参考章节",
        content_length=16,
        processing_status="ready",
        source_role="reference",
    )
    db.add_all([item, reference_item])
    await db.commit()

    response = await client.post(
        "/api/v1/intelligence/knowledge-map/build",
        headers=auth,
        json={"goal_id": goal_id},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "draft"
    assert payload["generated_by"] == "structured_extraction"
    assert any(row["title"] == item.title for row in payload["sources"])
    assert any(
        row["item_id"] == reference_item.id and row["concept_count"] == 0
        for row in payload["sources"]
    )
    concepts = payload["graph"]["concepts"]
    edges = payload["graph"]["edges"]
    assert all(row["review_status"] == "draft" for row in concepts)
    assert all(row["source_refs"] for row in concepts)
    assert all(
        reference_item.id not in {ref["item_id"] for ref in row["source_refs"]} for row in concepts
    )
    assert any(
        row["relation_type"] == "explained_by"
        and row["basis"] == "source_backed"
        and row["review_status"] == "confirmed"
        for row in edges
    )
    assert any(
        row["relation_type"] == "prerequisite"
        and row["basis"] == "inferred"
        and row["review_status"] == "draft"
        for row in edges
    )

    reviewed = await client.post(
        "/api/v1/intelligence/knowledge-map/review",
        headers=auth,
        json={
            "goal_id": goal_id,
            "concept_ids": [row["id"] for row in concepts],
            "edge_ids": [row["id"] for row in edges if row["review_status"] == "draft"],
            "action": "confirmed",
        },
    )
    assert reviewed.status_code == 200, reviewed.text
    assert reviewed.json()["status"] == "confirmed"
    assert all(row["review_status"] == "confirmed" for row in reviewed.json()["graph"]["concepts"])


@pytest.mark.asyncio
async def test_mastery_evidence_only_updates_confirmed_task_concepts(goal_id, db):
    goal = await db.scalar(select(Goal).where(Goal.id == goal_id))
    assert goal is not None
    confirmed = LearningConcept(
        user_id=goal.user_id,
        goal_id=goal_id,
        name="已确认知识点",
        normalized_name="已确认知识点",
        review_status="confirmed",
        mastery_score=0.2,
    )
    draft = LearningConcept(
        user_id=goal.user_id,
        goal_id=goal_id,
        name="待确认知识点",
        normalized_name="待确认知识点",
        review_status="draft",
        provenance_type="structured_extraction",
        mastery_score=0.2,
    )
    db.add_all([confirmed, draft])
    await db.commit()

    updated = await KnowledgeGraphService.record_task_evidence(
        db,
        goal.user_id,
        goal_id=goal_id,
        execution_guide={"concept_refs": [{"id": confirmed.id}, {"id": draft.id}]},
        score=0.9,
        evidence_source="ai_assessment",
    )
    await db.commit()
    await db.refresh(confirmed)
    await db.refresh(draft)
    assert updated == [confirmed.id]
    assert confirmed.evidence_count == 1
    assert confirmed.mastery_score == 0.9
    assert draft.evidence_count == 0
    assert draft.mastery_score == 0.2


@pytest.mark.asyncio
async def test_adaptive_task_split_still_requires_review_and_apply(client, auth, goal_id, db):
    response = await client.post(
        "/api/v1/tasks",
        headers=auth,
        json={
            "goalId": goal_id,
            "title": "超大高风险任务",
            "date": (date.today() - timedelta(days=8)).isoformat(),
            "estimatedMinutes": 300,
            "priority": "high",
        },
    )
    assert response.status_code == 201
    task_id = response.json()["id"]
    assessment = await client.get(
        f"/api/v1/learner/adaptive-plan/{goal_id}/assessment", headers=auth
    )
    assert assessment.status_code == 200
    assert assessment.json()["risks"][0]["risk_level"] == "high"

    generated = await client.post(f"/api/v1/learner/adaptive-plan/{goal_id}/proposal", headers=auth)
    assert generated.status_code == 201, generated.text
    proposal = generated.json()
    assert proposal["proposal_type"] == "TASK_SPLIT"
    original = await db.scalar(select(Task).where(Task.id == task_id))
    assert original.status == "pending"

    action = await client.post(
        f"/api/v1/learner/proposals/{proposal['id']}/action-run", headers=auth
    )
    assert action.status_code == 200, action.text
    assert action.json()["status"] == "queued"
    assert action.json()["plan"][-1]["tool_name"] == "tasks.apply_changes"
    applied = await client.post(f"/api/v1/learner/proposals/{proposal['id']}/apply", headers=auth)
    assert applied.status_code == 409
    await db.refresh(original)
    assert original.status == "pending"
    run = await db.get(AgentRun, action.json()["id"])
    assert run is not None
    await advance_run(db, user_id=run.user_id, run_id=run.id)
    preview = (await client.get(f"/api/v2/agent/runs/{run.id}", headers=auth)).json()
    assert preview["status"] == "waiting_approval"
    approval = preview["approvals"][0]
    approved = await client.post(
        f"/api/v2/agent/runs/{run.id}/approve",
        headers=auth,
        json={
            "approval_id": approval["id"],
            "change_hash": approval["change_hash"],
            "change_set_version": approval["change_set_version"],
            "run_state_version": approval["run_state_version"],
        },
    )
    assert approved.status_code == 200, approved.text
    await advance_run(db, user_id=run.user_id, run_id=run.id)
    await db.refresh(original)
    assert original.status == "skipped"
    split_tasks = list(
        (
            await db.execute(
                select(Task).where(Task.goal_id == goal_id, Task.title.like("超大高风险任务（%"))
            )
        ).scalars()
    )
    assert len(split_tasks) == 2


@pytest.mark.asyncio
async def test_phase4_benchmark_has_twenty_cases_and_persists(client, auth, db):
    path = Path(__file__).parents[1] / "evals" / "agent_benchmark_v2.json"
    report = evaluate_benchmark(path)
    assert report["total"] >= 20
    assert report["passed"] == report["total"]
    assert set(report["category_scores"]) >= {
        "new_user",
        "procrastinator",
        "high_frequency",
        "recovery",
        "long_term_goal",
    }
    assert await persist_report(db, report, path) == report["total"]
    summary = await client.get("/api/v1/intelligence/evaluations/summary", headers=auth)
    assert summary.status_code == 200
    assert summary.json()["total"] >= 20
    assert summary.json()["pass_rate"] == 1.0


@pytest.mark.asyncio
async def test_knowledge_map_versions_merge_split_and_typed_evidence(client, auth, goal_id, db):
    goal = await db.scalar(select(Goal).where(Goal.id == goal_id))
    item = KnowledgeItem(
        user_id=goal.user_id,
        goal_id=goal_id,
        title="线性代数范围.md",
        content="# 行列式\n## 矩阵运算\n## 向量组线性相关",
        normalized_content="# 行列式\n## 矩阵运算\n## 向量组线性相关",
        content_length=32,
        processing_status="ready",
        source_role="scope",
        source_metadata={"learning_use": ["define_scope", "plan_sequence"]},
    )
    db.add(item)
    await db.commit()

    built = await client.post(
        "/api/v1/intelligence/knowledge-map/build",
        headers=auth,
        json={"goal_id": goal_id, "extraction_mode": "structural"},
    )
    assert built.status_code == 200, built.text
    payload = built.json()
    assert payload["map_version"]["version"] == 1
    concept_ids = [row["id"] for row in payload["graph"]["concepts"]]
    edge_ids = [row["id"] for row in payload["graph"]["edges"] if row["review_status"] == "draft"]
    reviewed = await client.post(
        "/api/v1/intelligence/knowledge-map/review",
        headers=auth,
        json={
            "goal_id": goal_id,
            "concept_ids": concept_ids,
            "edge_ids": edge_ids,
            "action": "confirmed",
        },
    )
    assert reviewed.status_code == 200, reviewed.text
    assert reviewed.json()["map_version"]["status"] == "active"

    merged = await client.post(
        "/api/v1/intelligence/concepts/merge",
        headers=auth,
        json={
            "goal_id": goal_id,
            "target_concept_id": concept_ids[0],
            "source_concept_ids": [concept_ids[1]],
        },
    )
    assert merged.status_code == 200, merged.text
    assert merged.json()["target"]["aliases"]

    split = await client.post(
        f"/api/v1/intelligence/concepts/{concept_ids[0]}/split",
        headers=auth,
        json={
            "goal_id": goal_id,
            "parts": [{"name": "二阶行列式"}, {"name": "高阶行列式"}],
        },
    )
    assert split.status_code == 200, split.text
    versions = await client.get(
        f"/api/v1/intelligence/knowledge-map/{goal_id}/versions", headers=auth
    )
    assert versions.status_code == 200
    assert len(versions.json()["items"]) == 4
    assert await db.scalar(
        select(KnowledgeMapVersion).where(KnowledgeMapVersion.goal_id == goal_id)
    )

    active_concept = split.json()["parts"][0]
    task = Task(
        goal_id=goal_id,
        title="解释二阶行列式",
        scheduled_date=date.today().isoformat(),
        execution_guide={"concept_refs": [{"id": active_concept["id"]}]},
    )
    db.add(task)
    await db.commit()
    await KnowledgeGraphService.record_task_evidence(
        db,
        goal.user_id,
        goal_id=goal_id,
        task_id=task.id,
        execution_guide=task.execution_guide,
        score=0.82,
        evidence_source="verification",
        evidence_type="explanation_assessment",
        summary="能解释计算步骤",
    )
    await db.commit()
    evidence = await db.scalar(select(MasteryEvidence).where(MasteryEvidence.task_id == task.id))
    assert evidence is not None
    assert evidence.reliability == 1.0


@pytest.mark.asyncio
async def test_source_metadata_proposal_review_and_impact_preview(client, auth, goal_id, db):
    goal = await db.scalar(select(Goal).where(Goal.id == goal_id))
    item = KnowledgeItem(
        user_id=goal.user_id,
        goal_id=goal_id,
        title="2027 全国硕士研究生招生考试数学（一）考试大纲",
        content="考试内容包括高等数学、线性代数与概率论。",
        normalized_content="考试内容包括高等数学、线性代数与概率论。",
        content_length=24,
        processing_status="ready",
        source_role="reference",
    )
    db.add(item)
    await db.commit()
    proposed = await client.post(
        f"/api/v1/knowledge/files/{item.id}/metadata-proposals", headers=auth
    )
    assert proposed.status_code == 201, proposed.text
    proposal = proposed.json()
    assert proposal["proposed_role"] == "scope"
    accepted = await client.post(
        f"/api/v1/knowledge/files/{item.id}/metadata-proposals/{proposal['id']}/review",
        headers=auth,
        json={"action": "accepted"},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["file"]["sourceRole"] == "scope"
    assert accepted.json()["file"]["sourceMetadata"]["authority"] == "official"

    impact = await client.post(
        "/api/v1/intelligence/knowledge-map/impact-preview",
        headers=auth,
        json={
            "goal_id": goal_id,
            "source_item_id": item.id,
            "proposed_source_role": "reference",
            "proposed_source_metadata": {"learning_use": ["answer_question"]},
        },
    )
    assert impact.status_code == 200, impact.text
    assert impact.json()["map_requires_review"] is True
