import json
import uuid
from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from httpx import AsyncClient

from src.config import settings


def _mock_llm(content: str):
    m = MagicMock()
    m.ainvoke = AsyncMock(return_value=MagicMock(content=content))
    return m


async def test_stream_uses_cookie_and_csrf_contract(client: AsyncClient):
    uid = uuid.uuid4().hex[:8]
    registered = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"{uid}@test.com",
            "username": uid,
            "password": "testpass123",
        },
    )
    assert registered.status_code == 201
    body = {"message": "测试流式认证", "session_id": f"session-{uid}"}

    rejected = await client.post("/api/v1/agent/stream", json=body)
    assert rejected.status_code == 403

    class FakeAgent:
        async def astream_events(self, *args, **kwargs):
            if False:
                yield None

        async def aget_state(self, config):
            return SimpleNamespace(next=[], values={})

    csrf = client.cookies.get(settings.auth_csrf_cookie_name)
    with patch("src.core.agent.graph.get_agent", new=AsyncMock(return_value=FakeAgent())):
        accepted = await client.post(
            "/api/v1/agent/stream",
            json=body,
            headers={"X-CSRF-Token": csrf},
        )
    assert accepted.status_code == 200
    assert "event: done" in accepted.text


async def test_daily_brief_no_checkins(client: AsyncClient, auth: dict):
    r = await client.get("/api/v1/agent/daily-brief", headers=auth)
    assert r.status_code == 200
    # 没有打卡记录时返回 null
    assert r.json() is None


async def test_daily_brief_with_checkins(client: AsyncClient, auth: dict, goal_id: str):
    # 先打一次卡
    await client.post(
        f"/api/v1/checkin/{goal_id}",
        json={"mode": "quick", "quick_status": "all_done"},
        headers=auth,
    )
    r = await client.get("/api/v1/agent/daily-brief", headers=auth)
    assert r.status_code == 200
    data = r.json()
    assert data is not None
    assert "summary" in data
    assert "insight" in data
    assert "goalReviews" in data
    assert data["date"] == date.today().isoformat()


async def test_verify_start(client: AsyncClient, auth: dict, goal_id: str):
    today = date.today().isoformat()
    # 先创建任务
    r_task = await client.post(
        "/api/v1/tasks",
        json={"title": "Python 函数", "goalId": goal_id, "date": today},
        headers=auth,
    )
    task_id = r_task.json()["id"]

    mock = _mock_llm("请用自己的话解释 Python 函数的作用是什么？")
    with patch(
        "src.api.agent.ainvoke_routine_checked",
        new=AsyncMock(return_value=await mock.ainvoke([])),
    ):
        r = await client.post(
            "/api/v1/agent/verify",
            json={"goal_id": goal_id, "task_id": task_id},
            headers=auth,
        )
    assert r.status_code == 200
    data = r.json()
    assert "question" in data
    assert len(data["question"]) > 0


async def test_verify_task_not_found(client: AsyncClient, auth: dict, goal_id: str):
    mock = _mock_llm("任意问题")
    with patch(
        "src.api.agent.ainvoke_routine_checked",
        new=AsyncMock(return_value=await mock.ainvoke([])),
    ):
        r = await client.post(
            "/api/v1/agent/verify",
            json={"goal_id": goal_id, "task_id": "nonexistent"},
            headers=auth,
        )
    assert r.status_code == 404


async def test_verify_answer_pass(client: AsyncClient, auth: dict, goal_id: str):
    today = date.today().isoformat()
    r_task = await client.post(
        "/api/v1/tasks",
        json={"title": "Python 类", "goalId": goal_id, "date": today},
        headers=auth,
    )
    task_id = r_task.json()["id"]

    # 先生成问题（存入缓存）
    q_mock = _mock_llm("请解释 Python 类的概念")
    with patch(
        "src.api.agent.ainvoke_routine_checked",
        new=AsyncMock(return_value=await q_mock.ainvoke([])),
    ) as llm_factory:
        await client.post(
            "/api/v1/agent/verify",
            json={"goal_id": goal_id, "task_id": task_id},
            headers=auth,
        )
    assert llm_factory.call_args.kwargs["max_tokens"] == 500

    # 提交答案（passed=true）
    eval_resp = json.dumps({"passed": True, "feedback": "回答准确，概念理解到位！"})
    a_mock = _mock_llm(eval_resp)
    with patch("src.api.agent.create_pro_llm", return_value=a_mock) as llm_factory:
        r = await client.post(
            "/api/v1/agent/verify/answer",
            json={"goal_id": goal_id, "task_id": task_id, "answer": "类是对象的模板"},
            headers=auth,
        )
    assert llm_factory.call_args.kwargs["max_tokens"] == 700
    assert r.status_code == 200
    data = r.json()
    assert data["passed"] is True
    assert "feedback" in data


async def test_verify_answer_fail_with_suggestion(client: AsyncClient, auth: dict, goal_id: str):
    today = date.today().isoformat()
    r_task = await client.post(
        "/api/v1/tasks",
        json={"title": "Python 装饰器", "goalId": goal_id, "date": today},
        headers=auth,
    )
    task_id = r_task.json()["id"]

    q_mock = _mock_llm("解释装饰器的工作原理")
    with patch(
        "src.api.agent.ainvoke_routine_checked",
        new=AsyncMock(return_value=await q_mock.ainvoke([])),
    ):
        await client.post(
            "/api/v1/agent/verify",
            json={"goal_id": goal_id, "task_id": task_id},
            headers=auth,
        )

    eval_resp = json.dumps(
        {
            "score": 45,
            "passed": False,
            "feedback": "回答不够准确",
            "suggestion": "重新阅读装饰器概念，并完成一个日志装饰器练习。",
            "follow_up": None,
        }
    )
    a_mock = _mock_llm(eval_resp)
    with patch("src.api.agent.create_pro_llm", return_value=a_mock):
        r = await client.post(
            "/api/v1/agent/verify/answer",
            json={"goal_id": goal_id, "task_id": task_id, "answer": "不知道"},
            headers=auth,
        )
    assert r.status_code == 200
    data = r.json()
    assert data["passed"] is False
    assert "suggestion" in data
    assert "follow_up" not in data


async def test_legacy_direct_replan_endpoint_removed(client: AsyncClient, auth: dict, goal_id: str):
    response = await client.post(f"/api/v1/agent/replan/{goal_id}", headers=auth)
    assert response.status_code == 404
