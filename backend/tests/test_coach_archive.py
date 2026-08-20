from datetime import datetime

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_coach_archive_round_trip(client: AsyncClient, auth: dict):
    sent_at = datetime.now().isoformat()
    conversation = {
        "id": "coach-test-conversation",
        "session_id": "coach-test-session",
        "goal_id": None,
        "goal_title": "跨目标对话",
        "title": "测试持久化",
        "summary": "确认会话正文进入账户数据库",
        "pilo_feedback": "这条回应应能在重新登录后恢复",
        "messages": [
            {"id": "u1", "role": "user", "content": "请保存这条消息", "created_at": sent_at},
            {"id": "a1", "role": "assistant", "content": "已经保存", "created_at": sent_at},
        ],
        "association": "跨目标 · 2 条消息",
        "is_favorite": True,
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }
    response = await client.put(
        "/api/v1/coach/conversations/coach-test-conversation", json=conversation, headers=auth
    )
    assert response.status_code == 200

    preference_response = await client.put(
        "/api/v1/coach/preferences",
        json={
            "tone": "warm",
            "initiative": "balanced",
            "detail": "balanced",
            "celebrateProgress": True,
            "motion": "calm",
        },
        headers=auth,
    )
    assert preference_response.status_code == 200

    archive = await client.get("/api/v1/coach/archive", headers=auth)
    assert archive.status_code == 200
    payload = archive.json()
    assert payload["conversations"][0]["messages"][0]["content"] == "请保存这条消息"
    assert payload["conversations"][0]["messages"][0]["created_at"] == sent_at
    assert payload["conversations"][0]["is_favorite"] is True
    assert payload["preferences"]["tone"] == "warm"

    deleted = await client.delete(
        "/api/v1/coach/conversations/coach-test-conversation", headers=auth
    )
    assert deleted.status_code == 204
    archive_after_delete = await client.get("/api/v1/coach/archive", headers=auth)
    assert archive_after_delete.json()["conversations"] == []


@pytest.mark.asyncio
async def test_account_preferences_merge_and_persist(client: AsyncClient, auth: dict):
    favorites = await client.patch(
        "/api/v1/auth/me",
        json={"account_preferences": {"knowledge_favorites": ["note-1", "file-2"]}},
        headers=auth,
    )
    assert favorites.status_code == 200
    assert favorites.json()["account_preferences"]["knowledge_favorites"] == ["note-1", "file-2"]

    learned = await client.patch(
        "/api/v1/auth/me",
        json={
            "account_preferences": {
                "pilo_learned_preferences": {"tone": "warm", "initiative": "balanced"},
                "study_preferences": {
                    "reminder_enabled": True,
                    "focus_target": "90",
                    "weekend_intensity": "light",
                },
            }
        },
        headers=auth,
    )
    assert learned.status_code == 200
    payload = learned.json()["account_preferences"]
    assert payload["knowledge_favorites"] == ["note-1", "file-2"]
    assert payload["pilo_learned_preferences"]["tone"] == "warm"
    assert payload["study_preferences"]["focus_target"] == "90"
