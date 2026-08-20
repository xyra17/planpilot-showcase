from datetime import date, timedelta

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


def _block(label: str = "未来任务") -> dict:
    return {
        "id": "future-block-1",
        "label": label,
        "taskId": "pending",
        "goalTitle": "测试目标",
        "startHour": 10,
        "durationMinutes": 30,
        "color": "#8879ee",
        "progress": 0,
    }


async def test_schedule_can_read_and_write_future_local_date(
    client: AsyncClient, auth: dict
):
    future = (date.today() + timedelta(days=2)).isoformat()
    response = await client.put(
        f"/api/v1/schedule/{future}",
        json={"blocks": [_block()]},
        headers=auth,
    )
    assert response.status_code == 200, response.text
    assert response.json()["date"] == future
    loaded = await client.get(f"/api/v1/schedule/{future}", headers=auth)
    assert loaded.status_code == 200
    assert loaded.json()["blocks"][0]["label"] == "未来任务"


async def test_schedule_rejects_non_iso_date(client: AsyncClient, auth: dict):
    response = await client.get("/api/v1/schedule/2026-8-2", headers=auth)
    assert response.status_code == 422


async def test_create_task_with_schedule_is_atomic(
    client: AsyncClient, auth: dict, goal_id: str
):
    future = (date.today() + timedelta(days=3)).isoformat()
    response = await client.post(
        "/api/v1/tasks/with-schedule",
        json={
            "title": "原子创建任务",
            "goalId": goal_id,
            "estimatedMinutes": 30,
            "date": future,
            "priority": "medium",
            "blocks": [_block("原子创建任务")],
        },
        headers=auth,
    )
    assert response.status_code == 201, response.text
    task_id = response.json()["id"]
    schedule = await client.get(f"/api/v1/schedule/{future}", headers=auth)
    assert schedule.json()["blocks"][0]["taskId"] == task_id
    assert schedule.json()["blocks"][0]["id"] == f"task-schedule-{task_id}"


async def test_atomic_schedule_owns_and_normalizes_client_block_identity(
    client: AsyncClient, auth: dict, goal_id: str
):
    future = (date.today() + timedelta(days=5)).isoformat()
    block = {**_block("客户端不能绑定其它任务"), "id": "foreign-block", "taskId": "another-user-task"}
    response = await client.post(
        "/api/v1/tasks/with-schedule",
        json={
            "title": "规范化排程归属",
            "goalId": goal_id,
            "estimatedMinutes": 30,
            "date": future,
            "priority": "medium",
            "blocks": [block],
        },
        headers=auth,
    )
    assert response.status_code == 201, response.text
    task_id = response.json()["id"]
    saved = await client.get(f"/api/v1/schedule/{future}", headers=auth)
    saved_block = saved.json()["blocks"][0]
    assert saved_block["taskId"] == task_id
    assert saved_block["id"] == f"task-schedule-{task_id}"


async def test_create_task_with_invalid_schedule_does_not_create_task(
    client: AsyncClient, auth: dict, goal_id: str
):
    future = (date.today() + timedelta(days=4)).isoformat()
    before = await client.get(f"/api/v1/tasks?date={future}", headers=auth)
    invalid_blocks = [_block(), {**_block(), "id": "future-block-2", "startHour": 10.25}]
    response = await client.post(
        "/api/v1/tasks/with-schedule",
        json={
            "title": "不应写入",
            "goalId": goal_id,
            "estimatedMinutes": 30,
            "date": future,
            "priority": "medium",
            "blocks": invalid_blocks,
        },
        headers=auth,
    )
    assert response.status_code == 422
    after = await client.get(f"/api/v1/tasks?date={future}", headers=auth)
    assert len(after.json()) == len(before.json())


async def test_atomic_schedule_rejects_multiple_new_blocks(
    client: AsyncClient, auth: dict, goal_id: str
):
    future = (date.today() + timedelta(days=6)).isoformat()
    response = await client.post(
        "/api/v1/tasks/with-schedule",
        json={
            "title": "多个排程块应拒绝",
            "goalId": goal_id,
            "estimatedMinutes": 30,
            "date": future,
            "priority": "medium",
            "blocks": [_block(), {**_block(), "id": "second-block", "startHour": 12}],
        },
        headers=auth,
    )
    assert response.status_code == 422
