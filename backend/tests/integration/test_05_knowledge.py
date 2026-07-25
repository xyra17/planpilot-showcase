import io

import pytest
from httpx import AsyncClient
from sqlalchemy import select

import src.database as database
from src.models import KnowledgeItem

pytestmark = pytest.mark.integration


async def test_upload_txt(client: AsyncClient, auth_headers: dict, shared: dict, seed: dict):
    txt = seed["knowledge_texts"][0]
    content = txt["content"].encode("utf-8")
    r = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": (txt["filename"], io.BytesIO(content), "text/plain")},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["name"] == txt["filename"]
    assert data["type"] == "txt"
    shared["item_id_txt"] = data["id"]


async def test_upload_md(client: AsyncClient, auth_headers: dict, shared: dict, seed: dict):
    md = seed["knowledge_texts"][2]
    content = md["content"].encode("utf-8")
    r = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": (md["filename"], io.BytesIO(content), "text/markdown")},
        headers=auth_headers,
    )
    assert r.status_code == 200
    data = r.json()
    assert data["type"] == "md"
    shared["item_id_md"] = data["id"]


async def test_list_files(client: AsyncClient, auth_headers: dict, shared: dict, seed: dict):
    r = await client.get("/api/v1/knowledge/files", headers=auth_headers)
    assert r.status_code == 200
    items = r.json().get("items", r.json())
    names = [i["name"] for i in items]
    assert seed["knowledge_texts"][0]["filename"] in names
    assert seed["knowledge_texts"][2]["filename"] in names


async def test_create_kb(client: AsyncClient, auth_headers: dict, shared: dict):
    r = await client.post(
        "/api/v1/knowledge/kbs",
        json={"name": "CPA备考资料库", "description": "CPA相关学习资料"},
        headers=auth_headers,
    )
    assert r.status_code in (200, 201), r.text
    data = r.json()
    assert data["name"] == "CPA备考资料库"
    assert data["item_count"] == 0
    shared["kb_id"] = data["id"]


async def test_list_kbs(client: AsyncClient, auth_headers: dict, shared: dict):
    r = await client.get("/api/v1/knowledge/kbs", headers=auth_headers)
    assert r.status_code == 200
    items = r.json().get("items", r.json())
    names = [kb["name"] for kb in items]
    assert "CPA备考资料库" in names


async def test_search_knowledge_keyword(client: AsyncClient, auth_headers: dict, seed: dict):
    # 上传专用搜索文件
    cpa_txt = seed["knowledge_texts"][1]
    content = cpa_txt["content"].encode("utf-8")
    uploaded = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": (cpa_txt["filename"], io.BytesIO(content), "text/plain")},
        headers=auth_headers,
    )
    async with database.AsyncSessionLocal() as db:
        item = (await db.execute(
            select(KnowledgeItem).where(KnowledgeItem.id == uploaded.json()["id"])
        )).scalar_one()
        item.content = cpa_txt["content"]
        item.content_length = len(item.content)
        item.processing_status = "ready"
        await db.commit()
    r = await client.get("/api/v1/knowledge/search?q=资产", headers=auth_headers)
    assert r.status_code == 200
    results = r.json()
    assert isinstance(results, list)
    assert len(results) > 0
    assert "id" in results[0]
    assert "title" in results[0]
    assert "snippet" in results[0]


async def test_create_note(client: AsyncClient, auth_headers: dict, shared: dict, seed: dict):
    goal_id = shared.get("goal_id_1")
    if not goal_id:
        goal_response = await client.post(
            "/api/v1/goals",
            json=seed["goals"][0],
            headers=auth_headers,
        )
        assert goal_response.status_code == 201, goal_response.text
        goal_id = goal_response.json()["id"]
        shared["goal_id_1"] = goal_id
    r = await client.post(
        "/api/v1/knowledge/notes",
        json={"goalId": goal_id, "content": seed["notes"][0]},
        headers=auth_headers,
    )
    assert r.status_code in (200, 201), r.text
    data = r.json()
    assert "id" in data
    shared["note_id"] = data["id"]


async def test_update_note(client: AsyncClient, auth_headers: dict, shared: dict):
    new_content = "更新后的笔记内容：会计六大要素的详细分析与练习"
    r = await client.patch(
        f"/api/v1/knowledge/notes/{shared['note_id']}",
        json={"content": new_content},
        headers=auth_headers,
    )
    assert r.status_code == 200


async def test_delete_file(client: AsyncClient, auth_headers: dict, shared: dict):
    # 删除 MD 文件，保留 TXT 文件供后续 agent 测试使用
    r = await client.delete(
        f"/api/v1/knowledge/{shared['item_id_md']}",
        headers=auth_headers,
    )
    assert r.status_code in (200, 204)
