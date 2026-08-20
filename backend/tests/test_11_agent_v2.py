from datetime import date, timedelta

import pytest
from sqlalchemy import select

from src.core.agent_v2.orchestrator import advance_run, claim_queued_run, create_run
from src.core.agent_v2.planner import deterministic_plan, parse_constraints
from src.core.agent_v2.registry import build_registry
from src.models import AgentRun


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
    analysis = deterministic_plan(registry, "检查最近两周执行情况", None)
    assert [step.tool_name for step in analysis.steps] == [
        "context.load",
        "analytics.execution_summary",
    ]
    research = deterministic_plan(registry, "搜索我的知识库里的线性代数资料", None)
    assert research.objective["intent"] == "knowledge_research"
    assert [step.tool_name for step in research.steps] == ["knowledge.search"]
    assert all(tool["input_schema"] for tool in registry.public_catalog())


@pytest.mark.asyncio
async def test_background_run_can_only_be_claimed_once(db):
    from src.models import User

    user = User(
        email="agent-claim@test.com",
        username="agentclaim",
        hashed_password="not-used",
    )
    db.add(user)
    await db.commit()
    run = await create_run(
        db,
        user_id=user.id,
        request="检查最近两周执行情况",
        goal_id=None,
        step_budget=10,
        token_budget=10000,
        auto_advance=False,
    )
    assert run.status == "queued"
    assert await claim_queued_run(db, user_id=user.id, run_id=run.id) is True
    assert await claim_queued_run(db, user_id=user.id, run_id=run.id) is False


@pytest.mark.asyncio
async def test_agent_run_approval_apply_and_undo(client, auth, goal_id, db):
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
    assert run["status"] == "queued"
    stored = (await db.execute(select(AgentRun).where(AgentRun.id == run["id"]))).scalar_one()
    await advance_run(db, user_id=stored.user_id, run_id=stored.id)
    run = (await client.get(f"/api/v2/agent/runs/{run['id']}", headers=auth)).json()
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
            "change_set_version": approval["change_set_version"],
            "run_state_version": approval["run_state_version"],
        },
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "queued"
    await advance_run(db, user_id=stored.user_id, run_id=stored.id)
    completed = (await client.get(f"/api/v2/agent/runs/{run['id']}", headers=auth)).json()
    assert completed["status"] == "completed"
    assert completed["result"]["undo_available"] is True

    changed = await client.get("/api/v1/tasks", headers=auth)
    assert next(row for row in changed.json() if row["id"] == task_id)["date"] == operation["after"]

    undone = await client.post(f"/api/v2/agent/runs/{run['id']}/undo", headers=auth, json={})
    assert undone.status_code == 200, undone.text
    assert undone.json()["status"] == "rolled_back"
    restored = await client.get("/api/v1/tasks", headers=auth)
    assert next(row for row in restored.json() if row["id"] == task_id)["date"] == old_date


@pytest.mark.asyncio
async def test_agent_run_is_private_to_owner_and_deletable_when_stopped(client, auth, goal_id, db):
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
    other_auth = {"Authorization": f"Bearer {other.cookies.get('pp_access')}"}
    hidden = await client.get(f"/api/v2/agent/runs/{response.json()['id']}", headers=other_auth)
    assert hidden.status_code == 404
    active_delete = await client.delete(f"/api/v2/agent/runs/{response.json()['id']}", headers=auth)
    assert active_delete.status_code == 409
    stored = (
        await db.execute(select(AgentRun).where(AgentRun.id == response.json()["id"]))
    ).scalar_one()
    await advance_run(db, user_id=stored.user_id, run_id=stored.id)
    deleted = await client.delete(f"/api/v2/agent/runs/{response.json()['id']}", headers=auth)
    assert deleted.status_code == 204
    missing = await client.get(f"/api/v2/agent/runs/{response.json()['id']}", headers=auth)
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_agent_can_edit_create_changeset_then_apply_and_undo(client, auth, goal_id, db):
    response = await client.post(
        "/api/v2/agent/runs",
        headers=auth,
        json={
            "request": "创建两个任务“复习章节”，明天安排，修改前确认",
            "goal_id": goal_id,
        },
    )
    run = response.json()
    stored = (await db.execute(select(AgentRun).where(AgentRun.id == run["id"]))).scalar_one()
    await advance_run(db, user_id=stored.user_id, run_id=stored.id)
    run = (await client.get(f"/api/v2/agent/runs/{run['id']}", headers=auth)).json()
    approval = run["approvals"][0]
    assert len(approval["change_set"]["operations"]) == 2
    first = approval["change_set"]["operations"][0]
    first["label"] = "复习第一章"
    first["after"]["title"] = "复习第一章"
    edited_set = {
        **approval["change_set"],
        "summary": "只创建一项任务",
        "operations": [first],
    }
    edited = await client.patch(
        f"/api/v2/agent/runs/{run['id']}/approvals/{approval['id']}",
        headers=auth,
        json={"change_set": edited_set},
    )
    assert edited.status_code == 200, edited.text
    edited_approval = edited.json()["approvals"][0]
    assert edited_approval["change_hash"] != approval["change_hash"]

    approved = await client.post(
        f"/api/v2/agent/runs/{run['id']}/approve",
        headers=auth,
        json={
            "approval_id": approval["id"],
            "change_hash": edited_approval["change_hash"],
        },
    )
    assert approved.status_code == 200
    await advance_run(db, user_id=stored.user_id, run_id=stored.id)
    tasks = (await client.get("/api/v1/tasks", headers=auth)).json()
    created = [task for task in tasks if task["title"] == "复习第一章"]
    assert len(created) == 1
    assert not any(task["title"] == "复习章节 2" for task in tasks)

    undone = await client.post(f"/api/v2/agent/runs/{run['id']}/undo", headers=auth, json={})
    assert undone.status_code == 200
    tasks = (await client.get("/api/v1/tasks", headers=auth)).json()
    assert not any(task["title"] == "复习第一章" for task in tasks)


@pytest.mark.asyncio
async def test_agent_delete_task_is_approval_gated_and_reversible(client, auth, goal_id, db):
    old_date = (date.today() + timedelta(days=2)).isoformat()
    task = (
        await client.post(
            "/api/v1/tasks",
            headers=auth,
            json={
                "title": "待删除任务",
                "goalId": goal_id,
                "estimatedMinutes": 30,
                "date": old_date,
            },
        )
    ).json()
    response = await client.post(
        "/api/v2/agent/runs",
        headers=auth,
        json={
            "request": "删除任务“待删除任务”，执行前让我确认",
            "goal_id": goal_id,
        },
    )
    run = response.json()
    stored = (await db.execute(select(AgentRun).where(AgentRun.id == run["id"]))).scalar_one()
    await advance_run(db, user_id=stored.user_id, run_id=stored.id)
    run = (await client.get(f"/api/v2/agent/runs/{run['id']}", headers=auth)).json()
    approval = run["approvals"][0]
    assert approval["change_set"]["operations"][0]["field"] == "__delete__"
    unconfirmed = await client.post(
        f"/api/v2/agent/runs/{run['id']}/approve",
        headers=auth,
        json={
            "approval_id": approval["id"],
            "change_hash": approval["change_hash"],
        },
    )
    assert unconfirmed.status_code == 409
    approved = await client.post(
        f"/api/v2/agent/runs/{run['id']}/approve",
        headers=auth,
        json={
            "approval_id": approval["id"],
            "change_hash": approval["change_hash"],
            "change_set_version": approval["change_set_version"],
            "run_state_version": approval["run_state_version"],
            "high_risk_confirmed": True,
        },
    )
    assert approved.status_code == 200
    await advance_run(db, user_id=stored.user_id, run_id=stored.id)
    tasks = (await client.get("/api/v1/tasks", headers=auth)).json()
    assert not any(row["id"] == task["id"] for row in tasks)
    await client.post(f"/api/v2/agent/runs/{run['id']}/undo", headers=auth, json={})
    tasks = (await client.get("/api/v1/tasks", headers=auth)).json()
    assert any(row["id"] == task["id"] for row in tasks)
