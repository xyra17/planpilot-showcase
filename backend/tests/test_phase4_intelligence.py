"""Phase 4 cognitive, memory, adaptive planning, graph and evaluation tests."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select

from src.core.time import utc_now
from src.intelligence.cognitive_model import knowledge_retention, retention_curve
from src.intelligence.evaluation import evaluate_benchmark, persist_report
from src.intelligence.memory_system import MemoryBuilder
from src.models import Goal, LearningEvent, Task, TaskMasteryRecord


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

    await client.post(f"/api/v1/learner/proposals/{proposal['id']}/accept", headers=auth)
    applied = await client.post(f"/api/v1/learner/proposals/{proposal['id']}/apply", headers=auth)
    assert applied.status_code == 200, applied.text
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
