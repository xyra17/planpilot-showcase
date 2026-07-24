import json
from datetime import date, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient


def _mock_llm(content: str):
    m = MagicMock()
    m.ainvoke = AsyncMock(return_value=MagicMock(content=content))
    return m


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
    with patch("src.api.agent.ChatOpenAI", return_value=mock):
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
    with patch("src.api.agent.ChatOpenAI", return_value=mock):
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
    with patch("src.api.agent.ChatOpenAI", return_value=q_mock):
        await client.post(
            "/api/v1/agent/verify",
            json={"goal_id": goal_id, "task_id": task_id},
            headers=auth,
        )

    # 提交答案（passed=true）
    eval_resp = json.dumps({"passed": True, "feedback": "回答准确，概念理解到位！"})
    a_mock = _mock_llm(eval_resp)
    with patch("src.api.agent.ChatOpenAI", return_value=a_mock):
        r = await client.post(
            "/api/v1/agent/verify/answer",
            json={"goal_id": goal_id, "task_id": task_id, "answer": "类是对象的模板"},
            headers=auth,
        )
    assert r.status_code == 200
    data = r.json()
    assert data["passed"] is True
    assert "feedback" in data


async def test_verify_answer_fail_with_followup(client: AsyncClient, auth: dict, goal_id: str):
    today = date.today().isoformat()
    r_task = await client.post(
        "/api/v1/tasks",
        json={"title": "Python 装饰器", "goalId": goal_id, "date": today},
        headers=auth,
    )
    task_id = r_task.json()["id"]

    q_mock = _mock_llm("解释装饰器的工作原理")
    with patch("src.api.agent.ChatOpenAI", return_value=q_mock):
        await client.post(
            "/api/v1/agent/verify",
            json={"goal_id": goal_id, "task_id": task_id},
            headers=auth,
        )

    eval_resp = json.dumps({
        "passed": False,
        "feedback": "回答不够准确",
        "follow_up": "能举个实际使用装饰器的例子吗？",
    })
    a_mock = _mock_llm(eval_resp)
    with patch("src.api.agent.ChatOpenAI", return_value=a_mock):
        r = await client.post(
            "/api/v1/agent/verify/answer",
            json={"goal_id": goal_id, "task_id": task_id, "answer": "不知道"},
            headers=auth,
        )
    assert r.status_code == 200
    data = r.json()
    assert data["passed"] is False
    assert "follow_up" in data


async def test_manual_replan(client: AsyncClient, auth: dict, goal_id: str):
    replan_tasks = json.dumps([
        {"title": "简化任务1", "estimated_mins": 20, "type": "study"},
        {"title": "简化任务2", "estimated_mins": 15, "type": "review"},
    ])
    mock = _mock_llm(replan_tasks)
    with patch("src.api.agent.ChatOpenAI", return_value=mock):
        r = await client.post(f"/api/v1/agent/replan/{goal_id}", headers=auth)
    assert r.status_code == 200
    tasks = r.json()["tasks"]
    assert len(tasks) == 2
    assert tasks[0]["title"] == "简化任务1"


async def test_manual_replan_unknown_goal(client: AsyncClient, auth: dict):
    mock = _mock_llm("[]")
    with patch("src.api.agent.ChatOpenAI", return_value=mock):
        r = await client.post("/api/v1/agent/replan/nonexistent", headers=auth)
    assert r.status_code == 404
