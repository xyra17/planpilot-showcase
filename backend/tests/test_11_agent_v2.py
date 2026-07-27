from datetime import date, timedelta

import pytest

from src.core.agent_v2.planner import create_plan, parse_constraints
from src.core.agent_v2.registry import build_registry


def test_registry_enforces_one_main_many_subagents_boundary():
    catalog = build_registry().public_catalog()
    writes = [tool for tool in catalog if tool["effect"] == "write"]
    assert len(writes) == 1
    assert writes[0]["role"] == "main"
    assert writes[0]["requires_approval"] is True
    assert {tool["role"] for tool in catalog if tool["effect"] != "write"} >= {
        "learning_analyst",
        "schedule_optimizer",
        "plan_reviewer",
    }


def test_planner_extracts_unavailable_weekday_and_time_granularity():
    constraints = parse_constraints("周三晚上不要排任务，修改前让我确认")
    assert constraints["excluded_weekdays"] == [2]
    assert constraints["requires_confirmation"] is True
    assert "按整天避开" in constraints["time_granularity_note"]


def test_planner_retrieves_tools_for_analysis_and_knowledge():
    registry = build_registry()
    _objective, analysis = create_plan(registry, "检查最近两周执行情况", None)
    assert [step.tool_name for step in analysis] == [
        "context.load",
        "analytics.execution_summary",
    ]
    objective, research = create_plan(registry, "搜索我的知识库里的线性代数资料", None)
    assert objective["intent"] == "knowledge_research"
    assert [step.tool_name for step in research] == ["knowledge.search"]
    assert all(tool["input_schema"] for tool in registry.public_catalog())


@pytest.mark.asyncio
async def test_agent_run_approval_apply_and_undo(client, auth, goal_id):
    old_date = (date.today() - timedelta(days=3)).isoformat()
    created = await client.post(
        "/api/v1/tasks",
        headers=auth,
        json={
            "title": "补做逾期练习",
            "goalId": goal_id,
            "estimatedMinutes": 45,
            "date": old_date,
            "priority": "high",
        },
    )
    assert created.status_code == 201, created.text
    task_id = created.json()["id"]

    response = await client.post(
        "/api/v2/agent/runs",
        headers=auth,
        json={
            "request": (
                "检查我最近两周的执行情况，把落后的任务重新安排到下周。"
                "周三晚上不要排任务，修改前让我确认。"
            ),
            "goal_id": goal_id,
        },
    )
    assert response.status_code == 201, response.text
    run = response.json()
    assert run["status"] == "waiting_approval"
    assert [step["status"] for step in run["steps"][:4]] == ["completed"] * 4
    assert run["steps"][4]["status"] == "waiting_approval"
    approval = run["approvals"][0]
    operation = approval["change_set"]["operations"][0]
    assert operation["entity_id"] == task_id
    assert operation["before"] == old_date
    assert date.fromisoformat(operation["after"]).weekday() != 2

    unchanged = await client.get("/api/v1/tasks", headers=auth)
    assert next(row for row in unchanged.json() if row["id"] == task_id)["date"] == old_date

    approved = await client.post(
        f"/api/v2/agent/runs/{run['id']}/approve",
        headers=auth,
        json={
            "approval_id": approval["id"],
            "change_hash": approval["change_hash"],
        },
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "completed"
    assert approved.json()["result"]["undo_available"] is True

    changed = await client.get("/api/v1/tasks", headers=auth)
    assert next(row for row in changed.json() if row["id"] == task_id)["date"] == operation["after"]

    undone = await client.post(
        f"/api/v2/agent/runs/{run['id']}/undo", headers=auth, json={}
    )
    assert undone.status_code == 200, undone.text
    assert undone.json()["status"] == "undone"
    restored = await client.get("/api/v1/tasks", headers=auth)
    assert next(row for row in restored.json() if row["id"] == task_id)["date"] == old_date


@pytest.mark.asyncio
async def test_agent_run_is_private_to_owner(client, auth, goal_id):
    response = await client.post(
        "/api/v2/agent/runs",
        headers=auth,
        json={"request": "检查执行情况并给我调整建议", "goal_id": goal_id},
    )
    assert response.status_code == 201
    other = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "agent-v2-other@test.com",
            "username": "agentv2other",
            "password": "testpass123",
        },
    )
    other_auth = {"Authorization": f"Bearer {other.json()['access_token']}"}
    hidden = await client.get(
        f"/api/v2/agent/runs/{response.json()['id']}", headers=other_auth
    )
    assert hidden.status_code == 404
