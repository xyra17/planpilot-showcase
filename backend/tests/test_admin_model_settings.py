import json

import pytest

from src.config import settings
from src.models import User
from src.services import runtime_model_config


@pytest.mark.asyncio
async def test_admin_can_save_encrypted_hot_runtime_model_config(client, auth, db, tmp_path, monkeypatch):
    me = await client.get("/api/v1/auth/me", headers=auth)
    assert me.status_code == 200
    user = await db.get(User, me.json()["id"])
    assert user is not None

    forbidden = await client.get("/api/v1/admin/model-settings", headers=auth)
    assert forbidden.status_code == 403

    user.is_admin = True
    await db.commit()
    target = tmp_path / "model-runtime.json"
    monkeypatch.setattr(settings, "runtime_model_config_path", str(target))
    monkeypatch.setattr(runtime_model_config, "_cached_config", None)
    monkeypatch.setattr(runtime_model_config, "_cached_signature", None)

    response = await client.put(
        "/api/v1/admin/model-settings",
        headers=auth,
        json={
            "local_enabled": True,
            "local_base_url": "http://host.docker.internal:8080/v1",
            "local_model_name": "qwen-local",
            "local_api_key": "local",
            "local_max_concurrency": 2,
            "cloud_enabled": True,
            "cloud_provider": "zhipu",
            "cloud_base_url": "https://open.bigmodel.cn/api/paas/v4",
            "cloud_model_name": "glm-5",
            "cloud_pro_model_name": "glm-5",
            "cloud_api_key": "super-secret-cloud-key",
            "cloud_routine_max_concurrency": 6,
            "cloud_pro_max_concurrency": 2,
            "embedding_enabled": True,
            "embedding_base_url": "http://host.docker.internal:1234/v1",
            "embedding_model_name": "qwen-embedding",
            "embedding_api_key": "local",
            "embedding_dimensions": 1024,
            "embedding_max_concurrency": 3,
            "coach_agent_enabled": True,
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["cloud_provider"] == "zhipu"
    assert payload["cloud_api_key_configured"] is True
    assert payload["cloud_routine_max_concurrency"] == 6
    assert payload["cloud_pro_max_concurrency"] == 2
    assert "cloud_api_key" not in payload

    raw = target.read_text(encoding="utf-8")
    assert "super-secret-cloud-key" not in raw
    assert target.stat().st_mode & 0o777 == 0o600
    assert json.loads(raw)["cloud"]["api_key"]
    runtime = runtime_model_config.get_runtime_model_config()
    assert runtime.cloud_api_key == "super-secret-cloud-key"
    assert runtime.cloud_model_name == "glm-5"
    assert runtime.local_max_concurrency == 2
    assert runtime.embedding_max_concurrency == 3
