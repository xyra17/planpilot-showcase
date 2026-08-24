import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from src.core.agent_v2.orchestrator import advance_run, claim_queued_run, create_run
from src.core.agent_v2.planner import deterministic_plan, parse_constraints
from src.core.agent_v2.registry import build_registry
from src.models import (
    AgentFeedbackEvent,
    AgentRun,
    CheckinRecord,
    DecisionProposal,
    Goal,
    InsightActionRun,
    Task,
)
from src.services.proposal_service import (
    ProposalCreate,
    convert_insight_to_action_run,
    create_proposal,
)


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
async def test_completed_task_again_finishes_as_visible_noop_without_approval_or_executor(
    client, auth, goal_id, db
):
    task = (
        await client.post(
            "/api/v1/tasks",
            headers=auth,
            json={
                "title": "已经完成的任务",
                "goalId": goal_id,
                "done": True,
                "estimatedMinutes": 30,
                "date": (date.today() + timedelta(days=1)).isoformat(),
            },
        )
    ).json()
    response = await client.post(
        "/api/v2/agent/runs",
        headers=auth,
        json={"request": "完成任务“已经完成的任务”", "goal_id": goal_id},
    )
    assert response.status_code == 201, response.text
    run = response.json()
    stored = (await db.execute(select(AgentRun).where(AgentRun.id == run["id"]))).scalar_one()
    await advance_run(db, user_id=stored.user_id, run_id=stored.id)
    detail = (await client.get(f"/api/v2/agent/runs/{run['id']}", headers=auth)).json()
    assert detail["status"] == "completed"
    assert detail["approvals"] == []
    assert detail["result"]["summary"] == "当前状态已经符合请求，无需修改"
    assert detail["result"]["undo_available"] is False
    event_types = [event["type"] for event in detail["events"]]
    assert "action.noop" in event_types
    assert "approval.requested" not in event_types
    assert "executor.started" not in event_types
    task_after = next(
        item for item in (await client.get("/api/v1/tasks", headers=auth)).json()
        if item["id"] == task["id"]
    )
    assert task_after == task


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
async def test_generated_goal_plan_uses_action_approval_executor_and_undo(
    client, auth, goal_id, db
):
    user_goal = await db.get(Goal, goal_id)
    assert user_goal is not None
    goal_id = str(uuid.uuid4())
    task_id = str(uuid.uuid4())
    proposal = await create_proposal(
        user_goal.user_id,
        ProposalCreate(
            proposal_type="GOAL_PLAN_CREATE",
            title="创建目标",
            reasoning=["测试草案"],
            proposed_changes={
                "goal": {
                    "id": goal_id,
                    "type": "skill",
                    "title": "算法体系",
                    "deadline": (date.today() + timedelta(days=60)).isoformat(),
                    "daily_hours": 1.5,
                    "current_level": "beginner",
                    "status": "active",
                    "meta": {},
                    "version": 1,
                },
                "tasks": [
                    {
                        "id": task_id,
                        "title": "数组基础",
                        "estimated_mins": 30,
                        "status": "pending",
                        "priority": "medium",
                        "scheduled_date": date.today().isoformat(),
                        "mastery_level": "unknown",
                        "type": "study",
                        "kb_refs": [],
                        "version": 1,
                    }
                ],
            },
            confidence=0.9,
        ),
        db,
    )
    run = await convert_insight_to_action_run(user_goal.user_id, proposal["id"], db)
    stored = await db.get(AgentRun, run["id"])
    assert stored is not None
    insight = await db.get(DecisionProposal, proposal["id"])
    link = await db.scalar(select(InsightActionRun).where(InsightActionRun.run_id == stored.id))
    assert insight is not None and insight.status == "pending"
    assert insight.lifecycle_status == "converted"
    assert link is not None and link.status == "converted" and link.is_active is True
    await advance_run(db, user_id=stored.user_id, run_id=stored.id)
    detail = (await client.get(f"/api/v2/agent/runs/{stored.id}", headers=auth)).json()
    approval = detail["approvals"][0]
    approved = await client.post(
        f"/api/v2/agent/runs/{stored.id}/approve",
        headers=auth,
        json={
            "approval_id": approval["id"],
            "change_hash": approval["change_hash"],
            "change_set_version": approval["change_set_version"],
            "run_state_version": approval["run_state_version"],
        },
    )
    assert approved.status_code == 200, approved.text
    await db.refresh(insight)
    await db.refresh(link)
    assert insight.status == "accepted"
    assert insight.lifecycle_status == "action_approved"
    assert link.status == "action_approved"
    await advance_run(db, user_id=stored.user_id, run_id=stored.id)
    await db.refresh(insight)
    await db.refresh(link)
    assert insight.status == "applied"
    assert insight.lifecycle_status == "applied"
    assert link.status == "applied" and link.is_active is False
    assert await db.get(Goal, goal_id) is not None
    assert await db.get(Task, task_id) is not None

    undone = await client.post(f"/api/v2/agent/runs/{stored.id}/undo", headers=auth, json={})
    assert undone.status_code == 200, undone.text
    await db.refresh(insight)
    await db.refresh(link)
    assert insight.status == "pending"
    assert insight.lifecycle_status == "rolled_back"
    assert link.status == "rolled_back" and link.is_active is False
    feedback_types = set(
        (
            await db.execute(
                select(AgentFeedbackEvent.feedback_type).where(
                    AgentFeedbackEvent.run_id == stored.id
                )
            )
        ).scalars()
    )
    assert {
        "insight_converted",
        "action_approved",
        "action_applied",
        "action_rolled_back",
    }.issubset(feedback_types)
    assert await db.get(Task, task_id) is None
    assert await db.get(Goal, goal_id) is None


@pytest.mark.asyncio
async def test_natural_checkin_requires_action_approval_and_is_undoable(client, auth, goal_id, db):
    goal = await db.get(Goal, goal_id)
    assert goal is not None
    proposal = await create_proposal(
        goal.user_id,
        ProposalCreate(
            goal_id=goal.id,
            proposal_type="CHECKIN_RECORD",
            title="确认打卡",
            reasoning=["自然语言推断需确认"],
            proposed_changes={
                "goal_id": goal.id,
                "date": date.today().isoformat(),
                "natural_text": "今天完成了一半",
                "completion_rate": 0.5,
            },
            confidence=0.75,
        ),
        db,
    )
    run = await convert_insight_to_action_run(goal.user_id, proposal["id"], db)
    stored = await db.get(AgentRun, run["id"])
    assert stored is not None
    await advance_run(db, user_id=stored.user_id, run_id=stored.id)
    detail = (await client.get(f"/api/v2/agent/runs/{stored.id}", headers=auth)).json()
    approval = detail["approvals"][0]
    assert await db.scalar(select(CheckinRecord).where(CheckinRecord.goal_id == goal.id)) is None
    approved = await client.post(
        f"/api/v2/agent/runs/{stored.id}/approve",
        headers=auth,
        json={
            "approval_id": approval["id"],
            "change_hash": approval["change_hash"],
            "change_set_version": approval["change_set_version"],
            "run_state_version": approval["run_state_version"],
        },
    )
    assert approved.status_code == 200, approved.text
    await advance_run(db, user_id=stored.user_id, run_id=stored.id)
    checkin = await db.scalar(select(CheckinRecord).where(CheckinRecord.goal_id == goal.id))
    assert checkin is not None and checkin.completion_rate == 0.5
    undone = await client.post(f"/api/v2/agent/runs/{stored.id}/undo", headers=auth, json={})
    assert undone.status_code == 200, undone.text
    assert await db.scalar(select(CheckinRecord.id).where(CheckinRecord.id == checkin.id)) is None


@pytest.mark.asyncio
async def test_rejected_and_cancelled_insight_runs_allow_new_attempts(client, auth, goal_id, db):
    goal = await db.get(Goal, goal_id)
    assert goal is not None
    task = Task(
        goal_id=goal.id,
        title="生命周期任务",
        scheduled_date=date.today().isoformat(),
    )
    db.add(task)
    await db.flush()
    proposal = await create_proposal(
        goal.user_id,
        ProposalCreate(
            goal_id=goal.id,
            proposal_type="reschedule_overdue_tasks",
            title="生命周期建议",
            reasoning=["测试拒绝与取消"],
            proposed_changes={
                "task_updates": [
                    {
                        "task_id": task.id,
                        "scheduled_date": (date.today() + timedelta(days=2)).isoformat(),
                    }
                ]
            },
            confidence=0.8,
        ),
        db,
    )
    first = await convert_insight_to_action_run(goal.user_id, proposal["id"], db)
    first_run = await db.get(AgentRun, first["id"])
    assert first_run is not None
    await advance_run(db, user_id=goal.user_id, run_id=first_run.id)
    detail = (await client.get(f"/api/v2/agent/runs/{first_run.id}", headers=auth)).json()
    rejected = await client.post(
        f"/api/v2/agent/runs/{first_run.id}/reject",
        headers=auth,
        json={"approval_id": detail["approvals"][0]["id"], "reason": "先不调整"},
    )
    assert rejected.status_code == 200, rejected.text
    insight = await db.get(DecisionProposal, proposal["id"])
    first_link = await db.scalar(
        select(InsightActionRun).where(InsightActionRun.run_id == first_run.id)
    )
    assert insight is not None and insight.lifecycle_status == "action_rejected"
    assert insight.status == "pending"
    assert first_link is not None and first_link.is_active is False

    second = await convert_insight_to_action_run(goal.user_id, proposal["id"], db)
    assert second["id"] != first_run.id
    second_link = await db.scalar(
        select(InsightActionRun).where(InsightActionRun.run_id == second["id"])
    )
    assert second_link is not None and second_link.attempt_number == 2
    cancelled = await client.post(
        f"/api/v2/agent/runs/{second['id']}/cancel", headers=auth, json={}
    )
    assert cancelled.status_code == 200, cancelled.text
    await db.refresh(insight)
    await db.refresh(second_link)
    assert insight.lifecycle_status == "action_cancelled"
    assert second_link.is_active is False

    third = await convert_insight_to_action_run(goal.user_id, proposal["id"], db)
    assert third["id"] not in {first_run.id, second["id"]}


@pytest.mark.asyncio
async def test_deadline_blocker_fails_run_and_reopens_insight(client, auth, goal_id, db):
    goal = await db.get(Goal, goal_id)
    assert goal is not None
    task = Task(
        goal_id=goal.id,
        title="截止日期阻断任务",
        scheduled_date=date.today().isoformat(),
    )
    db.add(task)
    await db.flush()
    proposal = await create_proposal(
        goal.user_id,
        ProposalCreate(
            goal_id=goal.id,
            proposal_type="reschedule_overdue_tasks",
            title="越过截止日期",
            reasoning=["测试 blocker"],
            proposed_changes={
                "task_updates": [
                    {
                        "task_id": task.id,
                        "scheduled_date": (
                            date.fromisoformat(goal.deadline) + timedelta(days=1)
                        ).isoformat(),
                    }
                ]
            },
            confidence=0.8,
        ),
        db,
    )
    detail = await convert_insight_to_action_run(goal.user_id, proposal["id"], db)
    await advance_run(db, user_id=goal.user_id, run_id=detail["id"])
    failed = (await client.get(f"/api/v2/agent/runs/{detail['id']}", headers=auth)).json()
    assert failed["status"] == "failed"
    assert failed["approvals"] == []
    assert failed["result"]["outcome"] == "safe_policy_rejection"
    assert failed["result"]["action_fulfilled"] is False
    assert failed["result"]["reason_code"] == "deadline_conflict"
    assert len(failed["result"]["alternatives"]) == 3
    assert any(event["type"] == "policy.denied" for event in failed["events"])
    insight = await db.get(DecisionProposal, proposal["id"])
    assert insight is not None and insight.lifecycle_status == "action_failed"
    assert insight.status == "pending"
    regenerated = await convert_insight_to_action_run(goal.user_id, proposal["id"], db)
    assert regenerated["id"] != detail["id"]


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
    assert edited_approval["reviewed_change_hash"] == edited_approval["change_hash"]
    assert edited_approval["review_hash"]
    assert edited_approval["review_snapshot"]["approved_for_preview"] is True

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
async def test_edit_changeset_past_deadline_re_reviews_and_blocks_approval(
    client, auth, goal_id, db
):
    goal = await db.get(Goal, goal_id)
    task_date = (date.today() + timedelta(days=2)).isoformat()
    await client.post(
        "/api/v1/tasks",
        headers=auth,
        json={
            "title": "截止日期审查任务",
            "goalId": goal_id,
            "estimatedMinutes": 30,
            "date": task_date,
        },
    )
    created = await client.post(
        "/api/v2/agent/runs",
        headers=auth,
        json={
            "request": "把任务“截止日期审查任务”改到明天，执行前确认",
            "goal_id": goal_id,
        },
    )
    run_id = created.json()["id"]
    await advance_run(db, user_id=goal.user_id, run_id=run_id)
    detail = (await client.get(f"/api/v2/agent/runs/{run_id}", headers=auth)).json()
    approval = detail["approvals"][0]
    edited_set = approval["change_set"]
    edited_set["operations"][0]["after"] = (
        date.fromisoformat(goal.deadline) + timedelta(days=1)
    ).isoformat()
    edited = await client.patch(
        f"/api/v2/agent/runs/{run_id}/approvals/{approval['id']}",
        headers=auth,
        json={"change_set": edited_set},
    )
    assert edited.status_code == 200, edited.text
    rebound = edited.json()["approvals"][0]
    assert rebound["reviewed_change_hash"] == rebound["change_hash"]
    assert rebound["policy_decision"]["outcome"] == "deny"
    assert "deadline_exceeded" in rebound["policy_decision"]["review_finding_codes"]
    old_hash = await client.post(
        f"/api/v2/agent/runs/{run_id}/approve",
        headers=auth,
        json={"approval_id": approval["id"], "change_hash": approval["change_hash"]},
    )
    assert old_hash.status_code == 409
    blocked = await client.post(
        f"/api/v2/agent/runs/{run_id}/approve",
        headers=auth,
        json={"approval_id": approval["id"], "change_hash": rebound["change_hash"]},
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "review_blocked"


@pytest.mark.asyncio
async def test_edit_changeset_into_severe_capacity_overload_requires_fresh_confirmation(
    client, auth, goal_id, db
):
    goal = await db.get(Goal, goal_id)
    source_date = (date.today() + timedelta(days=2)).isoformat()
    overloaded_date = (date.today() + timedelta(days=4)).isoformat()
    await client.post(
        "/api/v1/tasks",
        headers=auth,
        json={
            "title": "待移动容量任务",
            "goalId": goal_id,
            "estimatedMinutes": 30,
            "date": source_date,
        },
    )
    created = await client.post(
        "/api/v2/agent/runs",
        headers=auth,
        json={
            "request": "把任务“待移动容量任务”改到明天，执行前确认",
            "goal_id": goal_id,
        },
    )
    run_id = created.json()["id"]
    await advance_run(db, user_id=goal.user_id, run_id=run_id)
    detail = (await client.get(f"/api/v2/agent/runs/{run_id}", headers=auth)).json()
    approval = detail["approvals"][0]
    await client.post(
        "/api/v1/tasks",
        headers=auth,
        json={
            "title": "容量占用任务",
            "goalId": goal_id,
            "estimatedMinutes": 180,
            "date": overloaded_date,
        },
    )
    edited_set = approval["change_set"]
    edited_set["operations"][0]["after"] = overloaded_date
    edited = await client.patch(
        f"/api/v2/agent/runs/{run_id}/approvals/{approval['id']}",
        headers=auth,
        json={"change_set": edited_set},
    )
    assert edited.status_code == 200, edited.text
    rebound = edited.json()["approvals"][0]
    assert rebound["policy_decision"]["risk"] == "high"
    assert "daily_capacity_exceeded" in rebound["policy_decision"]["review_finding_codes"]
    unconfirmed = await client.post(
        f"/api/v2/agent/runs/{run_id}/approve",
        headers=auth,
        json={"approval_id": approval["id"], "change_hash": rebound["change_hash"]},
    )
    assert unconfirmed.status_code == 409
    confirmed = await client.post(
        f"/api/v2/agent/runs/{run_id}/approve",
        headers=auth,
        json={
            "approval_id": approval["id"],
            "change_hash": rebound["change_hash"],
            "change_set_version": rebound["change_set_version"],
            "run_state_version": rebound["run_state_version"],
            "high_risk_confirmed": True,
        },
    )
    assert confirmed.status_code == 200, confirmed.text


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
