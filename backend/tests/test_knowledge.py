import io

from httpx import AsyncClient
from sqlalchemy import select

from src.models import KnowledgeChunk, KnowledgeItem


async def test_upload_txt(client: AsyncClient, auth: dict):
    content = b"Python \xe5\x9f\xba\xe7\xa1\x80\xe7\x9f\xa5\xe8\xaf\x86\xef\xbc\x9a\xe5\x8f\x98\xe9\x87\x8f\xe3\x80\x81\xe5\x87\xbd\xe6\x95\xb0\xe3\x80\x81\xe7\xb1\xbb"
    r = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("test.txt", io.BytesIO(content), "text/plain")},
        headers=auth,
    )
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "test.txt"
    assert data["type"] == "txt"
    assert data["status"] == "queued"
    return data["id"]


async def test_list_files(client: AsyncClient, auth: dict):
    content = b"test content"
    await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("list_test.txt", io.BytesIO(content), "text/plain")},
        headers=auth,
    )
    r = await client.get("/api/v1/knowledge/files", headers=auth)
    assert r.status_code == 200
    names = [i["name"] for i in r.json()["items"]]
    assert "list_test.txt" in names


async def test_delete_file(client: AsyncClient, auth: dict):
    content = b"delete me"
    r_up = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("del.txt", io.BytesIO(content), "text/plain")},
        headers=auth,
    )
    item_id = r_up.json()["id"]
    r_del = await client.delete(f"/api/v1/knowledge/{item_id}", headers=auth)
    assert r_del.status_code == 204


async def test_delete_file_not_found(client: AsyncClient, auth: dict):
    r = await client.delete("/api/v1/knowledge/nonexistent", headers=auth)
    assert r.status_code == 404


async def test_create_kb(client: AsyncClient, auth: dict):
    r = await client.post(
        "/api/v1/knowledge/kbs",
        json={"name": "Python 知识库", "description": "Python 学习资料"},
        headers=auth,
    )
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == "Python 知识库"
    assert data["item_count"] == 0
    return data["id"]


async def test_list_kbs(client: AsyncClient, auth: dict):
    await client.post(
        "/api/v1/knowledge/kbs",
        json={"name": "列表测试 KB"},
        headers=auth,
    )
    r = await client.get("/api/v1/knowledge/kbs", headers=auth)
    assert r.status_code == 200
    names = [kb["name"] for kb in r.json()["items"]]
    assert "列表测试 KB" in names


async def test_add_item_to_kb(client: AsyncClient, auth: dict):
    r_kb = await client.post(
        "/api/v1/knowledge/kbs",
        json={"name": "关联 KB"},
        headers=auth,
    )
    kb_id = r_kb.json()["id"]
    content = b"test linking"
    r_file = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("link.txt", io.BytesIO(content), "text/plain")},
        headers=auth,
    )
    item_id = r_file.json()["id"]
    r = await client.post(
        f"/api/v1/knowledge/kbs/{kb_id}/items/{item_id}",
        headers=auth,
    )
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


async def test_delete_kb(client: AsyncClient, auth: dict):
    r_kb = await client.post(
        "/api/v1/knowledge/kbs",
        json={"name": "待删 KB"},
        headers=auth,
    )
    kb_id = r_kb.json()["id"]
    r = await client.delete(f"/api/v1/knowledge/kbs/{kb_id}", headers=auth)
    assert r.status_code == 204


async def test_search_knowledge(client: AsyncClient, auth: dict, db):
    content = b"Python decorators and metaclasses explained"
    uploaded = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("search.txt", io.BytesIO(content), "text/plain")},
        headers=auth,
    )
    item = (await db.execute(
        select(KnowledgeItem).where(KnowledgeItem.id == uploaded.json()["id"])
    )).scalar_one()
    item.content = content.decode()
    item.content_length = len(item.content)
    item.processing_status = "ready"
    await db.commit()
    r = await client.get("/api/v1/knowledge/search?q=python+decorators", headers=auth)
    assert r.status_code == 200
    results = r.json()
    assert len(results) > 0
    assert results[0]["score"] > 0


async def test_chunk_search_returns_source_citation(client: AsyncClient, auth: dict, db):
    content = b"intro text\nunique retrieval phrase appears in the second section"
    uploaded = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("citation.txt", io.BytesIO(content), "text/plain")},
        headers=auth,
    )
    item = (await db.execute(
        select(KnowledgeItem).where(KnowledgeItem.id == uploaded.json()["id"])
    )).scalar_one()
    item.content = content.decode()
    item.content_length = len(item.content)
    item.processing_status = "ready"
    db.add(KnowledgeChunk(
        item_id=item.id,
        chunk_index=1,
        content="unique retrieval phrase appears in the second section",
        start_char=11,
        end_char=len(item.content),
    ))
    await db.commit()

    response = await client.get(
        "/api/v1/knowledge/search?q=unique+retrieval+phrase",
        headers=auth,
    )
    assert response.status_code == 200
    result = response.json()[0]
    assert result["id"] == item.id
    assert result["chunk_index"] == 1
    assert result["citation"] == "citation.txt · 第 2 段"
    assert result["start_char"] == 11


async def test_search_quality_evaluation(client: AsyncClient, auth: dict, db):
    content = b"quality benchmark needle"
    uploaded = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("quality.txt", io.BytesIO(content), "text/plain")},
        headers=auth,
    )
    item = (await db.execute(
        select(KnowledgeItem).where(KnowledgeItem.id == uploaded.json()["id"])
    )).scalar_one()
    item.content = content.decode()
    item.processing_status = "ready"
    await db.commit()

    response = await client.post(
        "/api/v1/knowledge/search/evaluate",
        json={
            "cases": [{
                "query": "quality benchmark needle",
                "expected_item_ids": [item.id],
            }],
            "limit": 5,
        },
        headers=auth,
    )
    assert response.status_code == 200
    metrics = response.json()
    assert metrics["recall_at_k"] == 1.0
    assert metrics["mrr"] == 1.0


async def test_rejects_unsupported_and_empty_files(client: AsyncClient, auth: dict):
    unsupported = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("malware.exe", io.BytesIO(b"MZ"), "application/octet-stream")},
        headers=auth,
    )
    assert unsupported.status_code == 415

    empty = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("empty.txt", io.BytesIO(b""), "text/plain")},
        headers=auth,
    )
    assert empty.status_code == 400


async def test_rejects_invalid_or_multiple_goal_links(client: AsyncClient, auth: dict):
    invalid_goal = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("goal.txt", io.BytesIO(b"content"), "text/plain")},
        data={"goal_ids": "not-a-user-goal"},
        headers=auth,
    )
    assert invalid_goal.status_code == 404

    multiple_goals = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("goals.txt", io.BytesIO(b"content"), "text/plain")},
        data={"goal_ids": ["goal-a", "goal-b"]},
        headers=auth,
    )
    assert multiple_goals.status_code == 422


async def test_retry_failed_file(client: AsyncClient, auth: dict, db):
    uploaded = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("retry.txt", io.BytesIO(b"retry me"), "text/plain")},
        headers=auth,
    )
    item = (await db.execute(
        select(KnowledgeItem).where(KnowledgeItem.id == uploaded.json()["id"])
    )).scalar_one()
    item.processing_status = "failed"
    item.processing_error = "temporary error"
    await db.commit()

    response = await client.post(
        f"/api/v1/knowledge/{item.id}/retry",
        headers=auth,
    )
    assert response.status_code == 200
    assert response.json()["status"] == "queued"
    assert response.json()["error"] is None


async def test_reindex_legacy_ready_file(client: AsyncClient, auth: dict, db):
    uploaded = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("legacy.txt", io.BytesIO(b"legacy content"), "text/plain")},
        headers=auth,
    )
    item = (await db.execute(
        select(KnowledgeItem).where(KnowledgeItem.id == uploaded.json()["id"])
    )).scalar_one()
    item.content = "legacy content"
    item.processing_status = "ready"
    await db.commit()

    response = await client.post("/api/v1/knowledge/reindex", headers=auth)
    assert response.status_code == 200
    assert item.id in response.json()["item_ids"]
    await db.refresh(item)
    assert item.processing_status == "queued"


async def test_search_no_results(client: AsyncClient, auth: dict):
    r = await client.get("/api/v1/knowledge/search?q=zzznomatch999", headers=auth)
    assert r.status_code == 200
    assert r.json() == []
