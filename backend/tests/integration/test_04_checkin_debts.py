import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


async def test_checkin_quick_all_done(client: AsyncClient, auth_headers: dict, shared: dict):
    goal_id = shared["goal_id_1"]
    r = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={"mode": "quick", "quick_status": "all_done"},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["stats"]["completion_rate"] == 1.0
    assert "feedback" in data
    assert data["debt_added"] == 0


async def test_checkin_quick_mostly_done(client: AsyncClient, auth_headers: dict, shared: dict):
    goal_id = shared["goal_id_1"]
    r = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={"mode": "quick", "quick_status": "mostly_done"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["stats"]["completion_rate"] == 0.75


async def test_checkin_natural(client: AsyncClient, auth_headers: dict, shared: dict):
    goal_id = shared["goal_id_2"]
    r = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={"mode": "natural", "text": "今天完成了Python函数章节的学习，理解了装饰器的用法"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    data = r.json()
    assert 0.0 <= data["stats"]["completion_rate"] <= 1.0
    assert "feedback" in data


async def test_checkin_task_list_with_skip_creates_debt(
    client: AsyncClient, auth_headers: dict, shared: dict
):
    goal_id = shared["goal_id_1"]
    task_ids = shared["task_ids"]
    r = await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={
            "mode": "task_list",
            "tasks": [
                {"task_id": task_ids[1], "status": "completed"},
                {"task_id": task_ids[2], "status": "partial"},
                {"task_id": task_ids[3], "status": "skipped", "note": "时间不够"},
            ],
        },
        headers=auth_headers,
    )
    assert r.status_code == 200
    data = r.json()
    assert data["stats"]["skipped"] == 1
    assert data["debt_added"] >= 1


async def test_list_debts(client: AsyncClient, auth_headers: dict, shared: dict):
    goal_id = shared["goal_id_1"]
    r = await client.get(f"/api/v1/debts/{goal_id}", headers=auth_headers)
    assert r.status_code == 200
    debts = r.json()
    assert len(debts) >= 1
    debt = debts[0]
    assert "id" in debt
    assert "content" in debt
    assert "status" in debt
    assert debt["status"] == "open"
    shared["debt_id"] = debt["id"]


async def test_resolve_debt(client: AsyncClient, auth_headers: dict, shared: dict):
    r = await client.patch(
        f"/api/v1/debts/{shared['debt_id']}/resolve",
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["status"] == "resolved"


async def test_debts_after_resolve(client: AsyncClient, auth_headers: dict, shared: dict):
    goal_id = shared["goal_id_1"]
    r = await client.get(f"/api/v1/debts/{goal_id}", headers=auth_headers)
    assert r.status_code == 200
    # 已解决的债务不应在 open 列表中
    open_ids = [d["id"] for d in r.json() if d["status"] == "open"]
    assert shared["debt_id"] not in open_ids
