"""学习记录专项测试（8 用例）"""
import io

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


# ── 辅助：注册并登录第二用户 ─────────────────────────────────────────────

async def _auth_headers_user2(client: AsyncClient, seed: dict) -> dict:
    r = await client.post("/api/v1/auth/register", json=seed["user2"])
    if r.status_code == 400:
        r = await client.post(
            "/api/v1/auth/login",
            json={"email": seed["user2"]["email"], "password": seed["user2"]["password"]},
        )
    assert r.status_code in (200, 201), r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# ── 1. 同一天可创建多篇笔记 ──────────────────────────────────────────────

async def test_multiple_notes_same_day(
    client: AsyncClient, auth_headers: dict, shared: dict
):
    date = "2026-01-15"
    ids = []
    for i in range(2):
        r = await client.post(
            "/api/v1/knowledge/notes",
            json={"content": f"学习记录第{i+1}篇", "noteType": "daily_log", "noteDate": date},
            headers=auth_headers,
        )
        assert r.status_code in (200, 201), r.text
        ids.append(r.json()["id"])

    r = await client.get(
        f"/api/v1/knowledge/notes?note_type=daily_log&date={date}",
        headers=auth_headers,
    )
    assert r.status_code == 200
    returned_ids = {n["id"] for n in r.json()}
    assert set(ids).issubset(returned_ids)
    shared["sn_note_ids"] = ids
    shared["sn_date"] = date


# ── 2. 历史日期笔记按 note_date 过滤 ────────────────────────────────────

async def test_historical_date_filter(
    client: AsyncClient, auth_headers: dict
):
    hist_date = "2025-03-20"
    r = await client.post(
        "/api/v1/knowledge/notes",
        json={"content": "三月历史笔记", "noteType": "daily_log", "noteDate": hist_date},
        headers=auth_headers,
    )
    assert r.status_code in (200, 201), r.text
    note_id = r.json()["id"]

    r = await client.get(
        f"/api/v1/knowledge/notes?note_type=daily_log&date={hist_date}",
        headers=auth_headers,
    )
    assert r.status_code == 200
    returned_ids = {n["id"] for n in r.json()}
    assert note_id in returned_ids

    r2 = await client.get(
        "/api/v1/knowledge/notes?note_type=daily_log&date=2025-03-21",
        headers=auth_headers,
    )
    assert r2.status_code == 200
    other_ids = {n["id"] for n in r2.json()}
    assert note_id not in other_ids


# ── 3. PATCH 笔记可更新 goalId ──────────────────────────────────────────

async def test_update_goal_id(
    client: AsyncClient, auth_headers: dict, shared: dict, seed: dict
):
    goal_id = shared.get("goal_id_1")
    if not goal_id:
        gr = await client.post("/api/v1/goals", json=seed["goals"][0], headers=auth_headers)
        assert gr.status_code == 201, gr.text
        goal_id = gr.json()["id"]
        shared["goal_id_1"] = goal_id

    r = await client.post(
        "/api/v1/knowledge/notes",
        json={"content": "初始无目标", "noteType": "daily_log", "noteDate": "2026-01-16"},
        headers=auth_headers,
    )
    assert r.status_code in (200, 201), r.text
    note_id = r.json()["id"]

    r = await client.patch(
        f"/api/v1/knowledge/notes/{note_id}",
        json={"goalId": goal_id},
        headers=auth_headers,
    )
    assert r.status_code == 200

    r = await client.patch(
        f"/api/v1/knowledge/notes/{note_id}",
        json={"goalId": ""},
        headers=auth_headers,
    )
    assert r.status_code == 200
    shared["sn_note_id_no_goal"] = note_id


# ── 4. 上传附件时传入 note_id 关联笔记 ──────────────────────────────────

async def test_attachment_linked_to_note(
    client: AsyncClient, auth_headers: dict, shared: dict
):
    note_ids = shared.get("sn_note_ids", [])
    assert note_ids, "depends on test_multiple_notes_same_day"
    note_id = note_ids[0]

    content = b"%PDF-1.4 fake pdf content"
    r = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("attachment.pdf", io.BytesIO(content), "application/pdf")},
        data={"note_id": note_id},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    shared["sn_attachment_id"] = r.json()["id"]


# ── 5. 附件不出现在 /knowledge/files ─────────────────────────────────────

async def test_attachment_hidden_from_files_list(
    client: AsyncClient, auth_headers: dict, shared: dict
):
    att_id = shared.get("sn_attachment_id")
    assert att_id, "depends on test_attachment_linked_to_note"

    r = await client.get("/api/v1/knowledge/files", headers=auth_headers)
    assert r.status_code == 200
    items = r.json().get("items", r.json())
    ids = [i["id"] for i in items]
    assert att_id not in ids, "附件不应出现在知识库文件列表中"


# ── 6. 删除笔记后附件一并不可访问 ─────────────────────────────────────────

async def test_delete_note_with_attachment(
    client: AsyncClient, auth_headers: dict, shared: dict
):
    note_ids = shared.get("sn_note_ids", [])
    assert note_ids, "depends on test_multiple_notes_same_day"
    note_id = note_ids[0]
    att_id = shared.get("sn_attachment_id")

    r = await client.delete(f"/api/v1/knowledge/{note_id}", headers=auth_headers)
    assert r.status_code in (200, 204)

    if att_id:
        r2 = await client.get(f"/api/v1/knowledge/files/{att_id}/serve", headers=auth_headers)
        assert r2.status_code in (404, 403, 400)


# ── 7. 其他用户无法访问该笔记 ────────────────────────────────────────────

async def test_other_user_cannot_access_note(
    client: AsyncClient, auth_headers: dict, shared: dict, seed: dict
):
    note_id = shared.get("sn_note_ids", [None])[-1]
    assert note_id, "depends on earlier tests"

    headers2 = await _auth_headers_user2(client, seed)

    r = await client.patch(
        f"/api/v1/knowledge/notes/{note_id}",
        json={"content": "恶意修改"},
        headers=headers2,
    )
    assert r.status_code in (403, 404)

    r = await client.delete(f"/api/v1/knowledge/{note_id}", headers=headers2)
    assert r.status_code in (403, 404)


# ── 8. noteDate 格式非法返回 422 ─────────────────────────────────────────

async def test_invalid_note_date_format(
    client: AsyncClient, auth_headers: dict
):
    for bad_date in ("20260115", "2026/01/15", "not-a-date", "2026-13-01"):
        r = await client.post(
            "/api/v1/knowledge/notes",
            json={"content": "测试", "noteType": "daily_log", "noteDate": bad_date},
            headers=auth_headers,
        )
        assert r.status_code == 422, f"期望 422，实际 {r.status_code}，noteDate={bad_date}"
