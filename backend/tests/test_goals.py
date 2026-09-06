from datetime import date, timedelta

from httpx import AsyncClient
from sqlalchemy import select

from src.models import (
    Goal,
    GoalVersion,
    LearnerCognitiveProfile,
    LearnerProfile,
    LearningEvent,
    Task,
)


def _future(days=365) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


async def test_create_goal(client: AsyncClient, auth: dict):
    r = await client.post(
        "/api/v1/goals",
        json={"type": "skill", "title": "学 Python", "deadline": _future(), "daily_hours": 2.0},
        headers=auth,
    )
    assert r.status_code == 201
    data = r.json()
    assert data["title"] == "学 Python"
    assert data["status"] == "active"


async def test_goal_contract_is_versioned_as_user_intent(client: AsyncClient, auth: dict):
    created = await client.post(
        "/api/v1/goals",
        json={
            "type": "language",
            "title": "三个月提升 N2 听力",
            "deadline": _future(),
            "baseline": "模拟题 22/60",
            "success_criteria": ["模拟题稳定达到 35/60"],
            "must_cover": ["即时应答", "概要理解"],
            "may_skip": ["N1 内容"],
        },
        headers=auth,
    )
    assert created.status_code == 201, created.text
    goal = created.json()
    assert goal["intent_version"] == 1
    assert goal["contract"]["baseline"] == "模拟题 22/60"

    updated = await client.patch(
        f"/api/v1/goals/{goal['id']}",
        json={
            "success_criteria": ["模拟题稳定达到 40/60"],
            "expected_version": goal["version"],
        },
        headers=auth,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["intent_version"] == 2
    assert updated.json()["contract"]["success_criteria"] == ["模拟题稳定达到 40/60"]


async def test_list_goals(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.get("/api/v1/goals", headers=auth)
    assert r.status_code == 200
    ids = [g["id"] for g in r.json()]
    assert goal_id in ids


async def test_get_goal(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.get(f"/api/v1/goals/{goal_id}", headers=auth)
    assert r.status_code == 200
    assert r.json()["id"] == goal_id


async def test_get_goal_not_found(client: AsyncClient, auth: dict):
    r = await client.get("/api/v1/goals/nonexistent", headers=auth)
    assert r.status_code == 404


async def test_patch_goal_status(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.patch(f"/api/v1/goals/{goal_id}", json={"status": "paused"}, headers=auth)
    assert r.status_code == 200
    assert r.json()["status"] == "paused"


async def test_patch_goal_invalid_status(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.patch(f"/api/v1/goals/{goal_id}", json={"status": "invalid"}, headers=auth)
    assert r.status_code == 422


async def test_patch_goal_validates_shared_fields_and_applies_type(
    client: AsyncClient, auth: dict, goal_id: str
):
    updated = await client.patch(
        f"/api/v1/goals/{goal_id}",
        json={
            "type": "language",
            "daily_hours": 3.0,
            "current_level": "advanced",
            "work_schedule": "weekend",
        },
        headers=auth,
    )
    assert updated.status_code == 200, updated.text
    data = updated.json()
    assert data["type"] == "language"
    assert data["daily_hours"] == 3.0
    assert data["current_level"] == "advanced"
    assert data["work_schedule"] == "weekend"

    invalid_payloads = (
        {"type": "unknown"},
        {"daily_hours": 0.25},
        {"current_level": "expert"},
        {"work_schedule": "weekday-evening"},
        {"deadline": "not-a-date"},
    )
    for payload in invalid_payloads:
        response = await client.patch(f"/api/v1/goals/{goal_id}", json=payload, headers=auth)
        assert response.status_code == 422, (payload, response.text)


async def test_work_schedule_plural_aliases_are_normalized_on_create_patch_and_read(
    client: AsyncClient, auth: dict, db
):
    created = await client.post(
        "/api/v1/goals",
        json={
            "type": "skill",
            "title": "复数工作日别名",
            "deadline": _future(),
            "work_schedule": "weekdays",
        },
        headers=auth,
    )
    assert created.status_code == 201, created.text
    goal = created.json()
    assert goal["work_schedule"] == "weekday"

    updated = await client.patch(
        f"/api/v1/goals/{goal['id']}",
        json={"work_schedule": "weekends"},
        headers=auth,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["work_schedule"] == "weekend"

    # Legacy rows are normalized in the response without rewriting the stored value.
    stored = await db.get(Goal, goal["id"])
    assert stored is not None
    stored.work_schedule = "weekdays"
    await db.commit()
    fetched = await client.get(f"/api/v1/goals/{goal['id']}", headers=auth)
    assert fetched.status_code == 200
    assert fetched.json()["work_schedule"] == "weekday"
    stored = await db.get(Goal, goal["id"])
    assert stored is not None
    assert stored.work_schedule == "weekdays"


async def test_goal_status_values_are_returned_without_server_side_remapping(
    client: AsyncClient, auth: dict, goal_id: str
):
    for status in ("active", "completed", "paused", "abandoned"):
        response = await client.patch(
            f"/api/v1/goals/{goal_id}", json={"status": status}, headers=auth
        )
        assert response.status_code == 200
        assert response.json()["status"] == status

        listed = await client.get("/api/v1/goals", headers=auth)
        assert listed.status_code == 200
        row = next(item for item in listed.json() if item["id"] == goal_id)
        assert row["status"] == status


async def test_patch_expired_goal_can_resubmit_same_deadline_and_change_title(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    goal = await db.get(Goal, goal_id)
    assert goal is not None
    goal.deadline = "2020-01-01"
    await db.commit()

    response = await client.patch(
        f"/api/v1/goals/{goal_id}",
        json={"title": "修复过期目标", "deadline": "2020-01-01"},
        headers=auth,
    )
    assert response.status_code == 200, response.text
    assert response.json()["title"] == "修复过期目标"
    assert response.json()["deadline"] == "2020-01-01"


async def test_patch_future_goal_rejects_past_deadline(
    client: AsyncClient, auth: dict, goal_id: str
):
    response = await client.patch(
        f"/api/v1/goals/{goal_id}",
        json={"deadline": (date.today() - timedelta(days=1)).isoformat()},
        headers=auth,
    )
    assert response.status_code == 422


async def test_patch_expired_goal_rejects_a_different_past_deadline(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    goal = await db.get(Goal, goal_id)
    assert goal is not None
    goal.deadline = "2020-01-01"
    await db.commit()

    response = await client.patch(
        f"/api/v1/goals/{goal_id}",
        json={"deadline": "2020-01-02"},
        headers=auth,
    )
    assert response.status_code == 422


async def test_patch_expired_goal_can_move_to_a_future_deadline(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    goal = await db.get(Goal, goal_id)
    assert goal is not None
    goal.deadline = "2020-01-01"
    await db.commit()
    future_deadline = _future(30)

    response = await client.patch(
        f"/api/v1/goals/{goal_id}",
        json={"deadline": future_deadline},
        headers=auth,
    )
    assert response.status_code == 200, response.text
    assert response.json()["deadline"] == future_deadline


async def test_patch_goal_rejects_invalid_iso_deadline(
    client: AsyncClient, auth: dict, goal_id: str
):
    response = await client.patch(
        f"/api/v1/goals/{goal_id}",
        json={"deadline": "2026-02-30"},
        headers=auth,
    )
    assert response.status_code == 422


async def test_delete_goal(client: AsyncClient, auth: dict):
    r_create = await client.post(
        "/api/v1/goals",
        json={"type": "exam", "title": "删除目标", "deadline": _future(), "daily_hours": 1.0},
        headers=auth,
    )
    gid = r_create.json()["id"]
    r_del = await client.delete(f"/api/v1/goals/{gid}", headers=auth)
    assert r_del.status_code == 204
    r_get = await client.get(f"/api/v1/goals/{gid}", headers=auth)
    assert r_get.status_code == 404


async def test_delete_goal_removes_goal_profiles_but_keeps_user_profiles(
    client: AsyncClient, auth: dict, db
):
    created = await client.post(
        "/api/v1/goals",
        json={"type": "skill", "title": "画像范围测试", "deadline": _future()},
        headers=auth,
    )
    assert created.status_code == 201
    goal_id = created.json()["id"]
    current_user = await client.get("/api/v1/auth/me", headers=auth)
    user_id = current_user.json()["id"]

    user_profile = LearnerProfile(user_id=user_id, goal_id=None)
    goal_profile = LearnerProfile(user_id=user_id, goal_id=goal_id)
    user_cognitive = LearnerCognitiveProfile(user_id=user_id, goal_id=None)
    goal_cognitive = LearnerCognitiveProfile(user_id=user_id, goal_id=goal_id)
    db.add_all([user_profile, goal_profile, user_cognitive, goal_cognitive])
    await db.commit()

    deleted = await client.delete(f"/api/v1/goals/{goal_id}", headers=auth)
    assert deleted.status_code == 204

    remaining_profiles = list(
        (
            await db.execute(select(LearnerProfile).where(LearnerProfile.user_id == user_id))
        ).scalars()
    )
    remaining_cognitive = list(
        (
            await db.execute(
                select(LearnerCognitiveProfile).where(LearnerCognitiveProfile.user_id == user_id)
            )
        ).scalars()
    )
    assert [profile.id for profile in remaining_profiles] == [user_profile.id]
    assert [profile.id for profile in remaining_cognitive] == [user_cognitive.id]


async def test_goal_requires_future_deadline(client: AsyncClient, auth: dict):
    r = await client.post(
        "/api/v1/goals",
        json={"type": "skill", "title": "过期目标", "deadline": "2020-01-01", "daily_hours": 2.0},
        headers=auth,
    )
    assert r.status_code == 422


async def test_goal_progress(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.get(f"/api/v1/goals/{goal_id}/progress", headers=auth)
    assert r.status_code == 200
    data = r.json()
    assert "total_tasks" in data
    assert "streak_days" in data


async def test_goal_progress_batch_returns_all_owned_goal_summaries(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    second = await client.post(
        "/api/v1/goals",
        json={"type": "reading", "title": "批量进度目标", "deadline": _future()},
        headers=auth,
    )
    assert second.status_code == 201
    second_goal_id = second.json()["id"]
    today = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    db.add_all(
        [
            Task(goal_id=goal_id, title="已完成任务", scheduled_date=today, status="completed"),
            Task(goal_id=goal_id, title="逾期任务", scheduled_date=yesterday, status="pending"),
        ]
    )
    await db.commit()

    response = await client.get("/api/v1/goals/progress", headers=auth)
    assert response.status_code == 200, response.text
    rows = {row["goal_id"]: row for row in response.json()}
    assert rows[goal_id]["total_tasks"] == 2
    assert rows[goal_id]["completed_tasks"] == 1
    assert rows[goal_id]["debt_count"] == 1
    assert rows[second_goal_id]["total_tasks"] == 0


async def test_goal_versions_are_append_only_and_stale_patch_is_rejected(
    client: AsyncClient, auth: dict, db
):
    created = await client.post(
        "/api/v1/goals",
        json={"type": "skill", "title": "版本目标", "deadline": _future()},
        headers=auth,
    )
    goal = created.json()
    assert goal["version"] == 1

    updated = await client.patch(
        f"/api/v1/goals/{goal['id']}",
        json={"title": "版本目标二", "expected_version": 1},
        headers=auth,
    )
    assert updated.status_code == 200
    assert updated.json()["version"] == 2
    stale = await client.patch(
        f"/api/v1/goals/{goal['id']}",
        json={"daily_hours": 3, "expected_version": 1},
        headers=auth,
    )
    assert stale.status_code == 409

    versions = list(
        (
            await db.execute(
                select(GoalVersion)
                .where(GoalVersion.goal_id == goal["id"])
                .order_by(GoalVersion.version)
            )
        ).scalars()
    )
    assert [row.version for row in versions] == [1, 2]
    assert versions[-1].title_snapshot == "版本目标二"

    events = list(
        (
            await db.execute(select(LearningEvent).where(LearningEvent.aggregate_id == goal["id"]))
        ).scalars()
    )
    assert [event.payload["aggregate_version"] for event in events] == [1, 2]

    stale_delete = await client.delete(
        f"/api/v1/goals/{goal['id']}?expected_version=1", headers=auth
    )
    assert stale_delete.status_code == 409
    current_delete = await client.delete(
        f"/api/v1/goals/{goal['id']}?expected_version=2", headers=auth
    )
    assert current_delete.status_code == 204
