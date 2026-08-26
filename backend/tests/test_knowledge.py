import io
from datetime import date, timedelta
from unittest.mock import patch

from httpx import AsyncClient
from sqlalchemy import select

from src.core.agent_v2.registry import build_registry
from src.core.agent_v2.schemas import ToolContext
from src.core.embedding import EmbeddingUnavailableError
from src.models import KnowledgeChunk, KnowledgeItem, KnowledgeItemFileVersion
from src.services.object_storage import get_object_storage


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


async def test_delete_file_cleans_source_versions_and_chunks(
    client: AsyncClient,
    auth: dict,
    db,
):
    content = b"delete me"
    r_up = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("del.txt", io.BytesIO(content), "text/plain")},
        headers=auth,
    )
    item_id = r_up.json()["id"]
    item = await db.get(KnowledgeItem, item_id)
    assert item is not None and item.file_path
    source_reference = item.file_path
    storage = get_object_storage()
    version_reference = await storage.put(
        f"knowledge/versions/{item_id}/test.txt",
        b"old version",
        "text/plain",
    )
    db.add(
        KnowledgeItemFileVersion(
            item_id=item_id,
            file_path=version_reference,
            filename="del.txt",
            size_bytes=11,
        )
    )
    db.add(
        KnowledgeChunk(
            item_id=item_id,
            chunk_index=0,
            content="delete me",
            start_char=0,
            end_char=9,
        )
    )
    await db.commit()

    r_del = await client.delete(f"/api/v1/knowledge/{item_id}", headers=auth)
    assert r_del.status_code == 204
    assert await db.get(KnowledgeItem, item_id) is None
    assert (
        await db.execute(select(KnowledgeChunk).where(KnowledgeChunk.item_id == item_id))
    ).scalar_one_or_none() is None
    assert not await storage.exists(source_reference)
    assert not await storage.exists(version_reference)


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


async def test_kb_goal_association(client: AsyncClient, auth: dict, goal_id: str):
    created = await client.post(
        "/api/v1/knowledge/kbs",
        json={"name": "目标资料库", "goal_id": goal_id},
        headers=auth,
    )
    assert created.status_code == 201
    assert created.json()["goal_id"] == goal_id

    updated = await client.patch(
        f"/api/v1/knowledge/kbs/{created.json()['id']}",
        json={"name": "重命名资料库", "goal_id": None},
        headers=auth,
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "重命名资料库"
    assert updated.json()["goal_id"] is None


async def test_update_file_metadata(client: AsyncClient, auth: dict):
    uploaded = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("metadata.txt", io.BytesIO(b"metadata"), "text/plain")},
        headers=auth,
    )
    updated = await client.patch(
        f"/api/v1/knowledge/files/{uploaded.json()['id']}",
        json={"title": "新的资料标题", "summary": "可持久化的资料摘要"},
        headers=auth,
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "新的资料标题"
    assert updated.json()["summary"] == "可持久化的资料摘要"


async def test_file_can_link_to_multiple_libraries_and_persist_edits(
    client: AsyncClient,
    auth: dict,
):
    first = await client.post("/api/v1/knowledge/kbs", json={"name": "产品资料"}, headers=auth)
    second = await client.post("/api/v1/knowledge/kbs", json={"name": "复习资料"}, headers=auth)
    uploaded = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("editable.md", io.BytesIO(b"# original"), "text/markdown")},
        data={"kb_ids": [first.json()["id"], second.json()["id"]]},
        headers=auth,
    )
    assert uploaded.status_code == 200
    assert set(uploaded.json()["kbIds"]) == {first.json()["id"], second.json()["id"]}

    updated = await client.patch(
        f"/api/v1/knowledge/files/{uploaded.json()['id']}",
        json={
            "kb_ids": [second.json()["id"]],
            "content": "<h1>edited</h1>",
            "content_format": "html",
        },
        headers=auth,
    )
    assert updated.status_code == 200
    assert updated.json()["kbIds"] == [second.json()["id"]]
    assert updated.json()["content"] == "<h1>edited</h1>"
    assert updated.json()["contentFormat"] == "html"


async def test_replace_and_restore_file_preserves_associations(
    client: AsyncClient,
    auth: dict,
    goal_id: str,
):
    library = await client.post(
        "/api/v1/knowledge/kbs",
        json={"name": "本地编辑测试"},
        headers=auth,
    )
    original_bytes = b"original-image-bytes"
    uploaded = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("diagram.png", io.BytesIO(original_bytes), "image/png")},
        data={"kb_ids": library.json()["id"], "goal_ids": goal_id},
        headers=auth,
    )
    item_id = uploaded.json()["id"]

    replacement_bytes = b"edited-image-bytes"
    replaced = await client.post(
        f"/api/v1/knowledge/files/{item_id}/replace",
        files={"file": ("diagram.png", io.BytesIO(replacement_bytes), "image/png")},
        headers=auth,
    )
    assert replaced.status_code == 200
    assert replaced.json()["goalIds"] == [goal_id]
    assert replaced.json()["kbIds"] == [library.json()["id"]]

    served_replacement = await client.get(
        f"/api/v1/knowledge/files/{item_id}/serve",
        headers=auth,
    )
    assert served_replacement.content == replacement_bytes

    versions = await client.get(
        f"/api/v1/knowledge/files/{item_id}/versions",
        headers=auth,
    )
    assert versions.status_code == 200
    assert len(versions.json()) == 1

    restored = await client.post(
        f"/api/v1/knowledge/files/{item_id}/versions/{versions.json()[0]['id']}/restore",
        headers=auth,
    )
    assert restored.status_code == 200
    assert restored.json()["goalIds"] == [goal_id]
    assert restored.json()["kbIds"] == [library.json()["id"]]
    served_original = await client.get(
        f"/api/v1/knowledge/files/{item_id}/serve",
        headers=auth,
    )
    assert served_original.content == original_bytes


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
    item = (
        await db.execute(select(KnowledgeItem).where(KnowledgeItem.id == uploaded.json()["id"]))
    ).scalar_one()
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
    item = (
        await db.execute(select(KnowledgeItem).where(KnowledgeItem.id == uploaded.json()["id"]))
    ).scalar_one()
    item.content = content.decode()
    item.content_length = len(item.content)
    item.processing_status = "ready"
    db.add(
        KnowledgeChunk(
            item_id=item.id,
            chunk_index=1,
            content="unique retrieval phrase appears in the second section",
            start_char=11,
            end_char=len(item.content),
        )
    )
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


async def test_ui_and_agent_share_the_same_retrieval_contract(
    client: AsyncClient, auth: dict, db
):
    uploaded = await client.post(
        "/api/v1/knowledge/upload",
        files={
            "file": (
                "unified-retrieval.txt",
                io.BytesIO(b"one retrieval service contract"),
                "text/plain",
            )
        },
        headers=auth,
    )
    item = (
        await db.execute(select(KnowledgeItem).where(KnowledgeItem.id == uploaded.json()["id"]))
    ).scalar_one()
    item.content = "one retrieval service contract"
    item.processing_status = "ready"
    await db.commit()

    with patch(
        "src.services.retrieval_service.embed_text",
        side_effect=EmbeddingUnavailableError("offline contract test"),
    ):
        ui_response = await client.get(
            "/api/v1/knowledge/search?q=one+retrieval+service+contract",
            headers=auth,
        )
        registry = build_registry()
        agent_response = await registry.invoke(
            db,
            registry.get("knowledge.search"),
            ToolContext(user_id=item.user_id, run_id="run-1", step_id="search-1"),
            {"query": "one retrieval service contract"},
        )

    assert ui_response.status_code == 200
    ui_result = ui_response.json()[0]
    agent_result = agent_response["results"][0]
    for field in (
        "id",
        "title",
        "snippet",
        "score",
        "citation",
        "retrieval_method",
        "source_url",
    ):
        assert agent_result[field] == ui_result[field]
    assert ui_result["id"] == item.id
    assert ui_result["retrieval_method"] == "keyword_item"


async def test_search_quality_evaluation(client: AsyncClient, auth: dict, db):
    content = b"quality benchmark needle"
    uploaded = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("quality.txt", io.BytesIO(content), "text/plain")},
        headers=auth,
    )
    item = (
        await db.execute(select(KnowledgeItem).where(KnowledgeItem.id == uploaded.json()["id"]))
    ).scalar_one()
    item.content = content.decode()
    item.processing_status = "ready"
    await db.commit()

    response = await client.post(
        "/api/v1/knowledge/search/evaluate",
        json={
            "cases": [
                {
                    "query": "quality benchmark needle",
                    "expected_item_ids": [item.id],
                }
            ],
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


async def test_validates_and_supports_multiple_goal_links(
    client: AsyncClient,
    auth: dict,
    goal_id: str,
):
    invalid_goal = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("goal.txt", io.BytesIO(b"content"), "text/plain")},
        data={"goal_ids": "not-a-user-goal"},
        headers=auth,
    )
    assert invalid_goal.status_code == 404

    second_goal = await client.post(
        "/api/v1/goals",
        json={
            "type": "skill",
            "title": "第二个测试目标",
            "deadline": (date.today() + timedelta(days=365)).isoformat(),
            "daily_hours": 2.0,
        },
        headers=auth,
    )
    assert second_goal.status_code == 201
    second_goal_id = second_goal.json()["id"]

    multiple_goals = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("goals.txt", io.BytesIO(b"content"), "text/plain")},
        data={"goal_ids": [goal_id, second_goal_id]},
        headers=auth,
    )
    assert multiple_goals.status_code == 200
    assert multiple_goals.json()["goalIds"] == [goal_id, second_goal_id]

    updated = await client.patch(
        f"/api/v1/knowledge/files/{multiple_goals.json()['id']}",
        json={"goal_ids": [second_goal_id]},
        headers=auth,
    )
    assert updated.status_code == 200
    assert updated.json()["goalIds"] == [second_goal_id]


async def test_search_matches_any_linked_goal(
    client: AsyncClient,
    auth: dict,
    goal_id: str,
    db,
):
    second_goal = await client.post(
        "/api/v1/goals",
        json={
            "type": "skill",
            "title": "检索范围目标",
            "deadline": (date.today() + timedelta(days=365)).isoformat(),
            "daily_hours": 2.0,
        },
        headers=auth,
    )
    assert second_goal.status_code == 201
    second_goal_id = second_goal.json()["id"]
    uploaded = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("multi-search.txt", io.BytesIO(b"shared retrieval phrase"), "text/plain")},
        data={"goal_ids": [goal_id, second_goal_id]},
        headers=auth,
    )
    assert uploaded.status_code == 200
    item = (
        await db.execute(select(KnowledgeItem).where(KnowledgeItem.id == uploaded.json()["id"]))
    ).scalar_one()
    item.content = "shared retrieval phrase"
    item.processing_status = "ready"
    await db.commit()

    response = await client.get(
        f"/api/v1/knowledge/search?q=shared+retrieval+phrase&goal_id={second_goal_id}",
        headers=auth,
    )
    assert response.status_code == 200
    assert [result["id"] for result in response.json()] == [item.id]


async def test_deleting_goal_unlinks_reusable_file(
    client: AsyncClient,
    auth: dict,
    goal_id: str,
):
    second_goal = await client.post(
        "/api/v1/goals",
        json={
            "type": "skill",
            "title": "保留资料目标",
            "deadline": (date.today() + timedelta(days=365)).isoformat(),
            "daily_hours": 2.0,
        },
        headers=auth,
    )
    assert second_goal.status_code == 201
    second_goal_id = second_goal.json()["id"]
    uploaded = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("shared-file.txt", io.BytesIO(b"shared"), "text/plain")},
        data={"goal_ids": [goal_id, second_goal_id]},
        headers=auth,
    )
    assert uploaded.status_code == 200

    deleted = await client.delete(f"/api/v1/goals/{goal_id}", headers=auth)
    assert deleted.status_code == 204

    listed = await client.get("/api/v1/knowledge/files", headers=auth)
    assert listed.status_code == 200
    resource = next(item for item in listed.json()["items"] if item["id"] == uploaded.json()["id"])
    assert resource["goalIds"] == [second_goal_id]


async def test_retry_failed_file(client: AsyncClient, auth: dict, db):
    uploaded = await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("retry.txt", io.BytesIO(b"retry me"), "text/plain")},
        headers=auth,
    )
    item = (
        await db.execute(select(KnowledgeItem).where(KnowledgeItem.id == uploaded.json()["id"]))
    ).scalar_one()
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
    item = (
        await db.execute(select(KnowledgeItem).where(KnowledgeItem.id == uploaded.json()["id"]))
    ).scalar_one()
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
