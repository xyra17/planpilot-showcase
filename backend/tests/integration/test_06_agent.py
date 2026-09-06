import os

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration

HAS_LLM = (
    os.getenv("PLANPILOT_RUN_LIVE_LLM_TESTS") == "1"
    and bool(os.getenv("SMART_API_KEY"))
    and os.getenv("SMART_API_KEY") != "test"
)


async def test_plan_context_reads_goal_linked_reference_files(
    client: AsyncClient, auth: dict, goal_id: str
):
    """新式 goal_ids 资料关联必须进入计划上下文，不能只读取旧 kb_id。"""
    upload = await client.post(
        "/api/v1/knowledge/upload",
        headers=auth,
        files={
            "file": (
                "阶段规划参考.txt",
                "第一阶段先理解基础概念，第二阶段完成综合练习。".encode(),
                "text/plain",
            )
        },
        data={"goal_ids": goal_id},
    )
    assert upload.status_code == 200, upload.text

    response = await client.get(f"/api/v1/agent/plan-context/{goal_id}", headers=auth)
    assert response.status_code == 200, response.text
    titles = [item["title"] for item in response.json()["kb_overview"]]
    assert "阶段规划参考.txt" in titles


async def test_macro_plan_generate(client: AsyncClient, auth_headers: dict, shared: dict):
    """生成宏观计划（真实LLM调用，需 SMART_API_KEY）"""
    if not HAS_LLM:
        pytest.skip("未配置 SMART_API_KEY，跳过 LLM 测试")
    goal_id = shared["goal_id_1"]
    r = await client.post(f"/api/v1/agent/macro-plan/{goal_id}", headers=auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "plan_id" in data
    assert "phases" in data
    assert len(data["phases"]) >= 2
    assert data["total_tasks"] > 0
    shared["plan_id"] = data["plan_id"]
    # 验证阶段结构
    phase = data["phases"][0]
    assert "name" in phase
    assert "tasks" in phase
    assert len(phase["tasks"]) > 0
    assert data["status"] == "draft"
    confirm = await client.post(
        f"/api/v1/agent/macro-plan/{goal_id}/{data['plan_id']}/confirm",
        headers=auth_headers,
    )
    assert confirm.status_code == 200, confirm.text
    assert confirm.json()["created_tasks"] == data["total_tasks"]


async def test_daily_brief_after_checkin(client: AsyncClient, auth_headers: dict, shared: dict):
    """打卡后获取每日简报（需 SMART_API_KEY）"""
    if not HAS_LLM:
        pytest.skip("未配置 SMART_API_KEY，跳过 LLM 测试")
    r = await client.get("/api/v1/agent/daily-brief", headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    assert data is not None
    assert "summary" in data
    assert "goalReviews" in data
    assert "insight" in data


async def test_daily_brief_cached(client: AsyncClient, auth_headers: dict):
    """再次请求应从 DB 缓存返回（无需重复 LLM 调用）"""
    if not HAS_LLM:
        pytest.skip("未配置 SMART_API_KEY，跳过 LLM 测试")
    r = await client.get("/api/v1/agent/daily-brief", headers=auth_headers)
    assert r.status_code == 200
    # 两次请求结果应相同（缓存命中）
    r2 = await client.get("/api/v1/agent/daily-brief", headers=auth_headers)
    assert r2.status_code == 200
    assert r.json()["summary"] == r2.json()["summary"]


async def test_verify_start(client: AsyncClient, auth_headers: dict, shared: dict):
    """开始掌握度验证（真实 LLM 生成题目）"""
    if not HAS_LLM:
        pytest.skip("未配置 SMART_API_KEY，跳过 LLM 测试")
    task_id = shared["task_ids"][1]
    r = await client.post(
        "/api/v1/agent/verify",
        json={"goal_id": shared["goal_id_1"], "task_id": task_id},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "question" in data
    assert len(data["question"]) > 5
    assert "answer_hint" in data
    shared["verify_task_id"] = task_id


async def test_verify_answer_pass(client: AsyncClient, auth_headers: dict, shared: dict):
    """提交答案并获取评分"""
    if not HAS_LLM:
        pytest.skip("未配置 SMART_API_KEY，跳过 LLM 测试")
    r = await client.post(
        "/api/v1/agent/verify/answer",
        json={
            "goal_id": shared["goal_id_1"],
            "task_id": shared["verify_task_id"],
            "answer": "资产负债表包含资产、负债和所有者权益三大部分，遵循会计恒等式：资产=负债+所有者权益。流动资产一般在一年内可变现，非流动资产包括固定资产和无形资产。",
        },
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "passed" in data
    assert "score" in data
    assert "feedback" in data
    assert isinstance(data["score"], int)
    assert 0 <= data["score"] <= 100


async def test_daily_tasks_generate(client: AsyncClient, auth_headers: dict):
    """生成今日任务建议"""
    if not HAS_LLM:
        pytest.skip("未配置 SMART_API_KEY，跳过 LLM 测试")
    r = await client.post("/api/v1/agent/daily-tasks", headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    if len(data) > 0:
        plan = data[0]
        assert "goal_id" in plan
        assert "tasks" in plan
