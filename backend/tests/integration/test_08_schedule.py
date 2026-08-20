import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


async def test_schedule_get_today_structure(client: AsyncClient, auth_headers: dict):
    r = await client.get("/api/v1/schedule/today", headers=auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "date" in data
    assert "blocks" in data
    assert isinstance(data["blocks"], list)


async def test_schedule_blocks_saved_by_test_03(
    client: AsyncClient, auth_headers: dict, seed: dict
):
    """test_03 已写入3个时间块，这里验证持久化结果。"""
    r = await client.get("/api/v1/schedule/today", headers=auth_headers)
    assert r.status_code == 200
    blocks = r.json()["blocks"]
    assert len(blocks) >= 1
    block = blocks[0]
    assert "label" in block
    assert "startHour" in block
    assert "durationMinutes" in block


async def test_schedule_overwrite_blocks(client: AsyncClient, auth_headers: dict):
    new_blocks = [
        {
            "id": "block-ovr-1",
            "label": "专项攻坚",
            "taskId": None,
            "goalTitle": "CPA备考2026",
            "startHour": 9.0,
            "durationMinutes": 120,
            "color": "#8b5cf6",
            "progress": 0.0,
        },
        {
            "id": "block-ovr-2",
            "label": "错题复盘",
            "taskId": None,
            "goalTitle": "CPA备考2026",
            "startHour": 14.0,
            "durationMinutes": 60,
            "color": "#ef4444",
            "progress": 0.0,
        },
    ]
    r = await client.put(
        "/api/v1/schedule/today",
        json={"blocks": new_blocks},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert len(data["blocks"]) == 2
    labels = [b["label"] for b in data["blocks"]]
    assert "专项攻坚" in labels
    assert "错题复盘" in labels


async def test_schedule_other_user_isolated(client: AsyncClient, shared: dict):
    """第二用户的日程应独立，不受第一用户数据影响。"""
    headers = {"Authorization": f"Bearer {shared['user2_token']}"}
    r = await client.get("/api/v1/schedule/today", headers=headers)
    assert r.status_code == 200
    assert r.json()["blocks"] == []


async def test_schedule_empty_blocks_allowed(client: AsyncClient, auth_headers: dict):
    r = await client.put(
        "/api/v1/schedule/today",
        json={"blocks": []},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["blocks"] == []


@pytest.mark.parametrize(
    "blocks",
    [
        [
            {
                "id": "cross-midnight",
                "label": "late",
                "startHour": 23.5,
                "durationMinutes": 31,
                "color": "#000",
            }
        ],
        [
            {
                "id": "first",
                "label": "first",
                "startHour": 9,
                "durationMinutes": 60,
                "color": "#000",
            },
            {
                "id": "second",
                "label": "second",
                "startHour": 9.5,
                "durationMinutes": 60,
                "color": "#000",
            },
        ],
    ],
)
async def test_schedule_rejects_ambiguous_time_blocks(
    client: AsyncClient, auth_headers: dict, blocks: list[dict]
):
    r = await client.put(
        "/api/v1/schedule/today", json={"blocks": blocks}, headers=auth_headers
    )
    assert r.status_code == 422
