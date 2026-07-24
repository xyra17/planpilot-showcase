import io
from datetime import date, timedelta

import pytest
from httpx import AsyncClient


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


async def test_search_knowledge(client: AsyncClient, auth: dict):
    content = b"Python decorators and metaclasses explained"
    await client.post(
        "/api/v1/knowledge/upload",
        files={"file": ("search.txt", io.BytesIO(content), "text/plain")},
        headers=auth,
    )
    r = await client.get("/api/v1/knowledge/search?q=python+decorators", headers=auth)
    assert r.status_code == 200
    results = r.json()
    assert len(results) > 0
    assert results[0]["score"] > 0


async def test_search_no_results(client: AsyncClient, auth: dict):
    r = await client.get("/api/v1/knowledge/search?q=zzznomatch999", headers=auth)
    assert r.status_code == 200
    assert r.json() == []
