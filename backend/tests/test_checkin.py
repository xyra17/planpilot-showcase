
from httpx import AsyncClient


async def test_checkin_quick_all_done(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={"mode": "quick", "quick_status": "all_done"},
        headers=auth,
    )
    assert r.status_code == 200
    data = r.json()
    assert data["stats"]["completion_rate"] == 1.0
    assert "太棒了" in data["feedback"]


async def test_checkin_quick_barely_done(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={"mode": "quick", "quick_status": "barely_done"},
        headers=auth,
    )
    assert r.status_code == 200
    assert r.json()["stats"]["completion_rate"] == 0.1


async def test_checkin_natural(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={"mode": "natural", "text": "今天学了函数和类，感觉还好"},
        headers=auth,
    )
    assert r.status_code == 200
    assert r.json()["stats"]["completion_rate"] == 0.5


async def test_checkin_task_list(client: AsyncClient, auth: dict, goal_id: str):
    r = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={
            "mode": "task_list",
            "tasks": [
                {"task_id": "t1", "status": "completed"},
                {"task_id": "t2", "status": "partial"},
                {"task_id": "t3", "status": "skipped"},
            ],
        },
        headers=auth,
    )
    assert r.status_code == 200
    data = r.json()
    stats = data["stats"]
    assert stats["completed"] == 1
    assert stats["partial"] == 1
    assert stats["skipped"] == 1
    # completion_rate = (1 + 0.5*1) / 3
    assert abs(stats["completion_rate"] - 0.5) < 0.01


async def test_checkin_unknown_goal(client: AsyncClient, auth: dict):
    r = await client.post(
        "/api/v1/checkin/nonexistent",
        json={"mode": "quick", "quick_status": "all_done"},
        headers=auth,
    )
    assert r.status_code == 404


async def test_checkin_replan_triggered(client: AsyncClient, auth: dict, goal_id: str):
    # 连续提交3次低完成率，第3次应触发 replan
    for _ in range(3):
        r = await client.post(
            f"/api/v1/checkin/{goal_id}",
            json={"mode": "quick", "quick_status": "barely_done"},
            headers=auth,
        )
        assert r.status_code == 200
    # 最后一次应该触发重规划
    assert r.json()["replan_triggered"] is True
