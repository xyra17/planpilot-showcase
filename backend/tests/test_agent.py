import json
import uuid
from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from src.config import settings
from src.models import AgentRun, CheckinRecord, LearningEvent, PendingActionIntent, Task


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
        state_input = None

        async def astream_events(self, *args, **kwargs):
            self.state_input = args[0]
            if False:
                yield None

        async def aget_state(self, config):
            return SimpleNamespace(
                next=[],
                values={
                    "actual_context_trace": {
                        "schema_version": "planpilot-chat-context-trace.v1",
                        "selected_keys": ["goal"],
                    }
                },
            )

    csrf = client.cookies.get(settings.auth_csrf_cookie_name)
    fake_agent = FakeAgent()
    prepared_context = {
        "goal": {"title": "测试目标"},
        "memories": [{"summary": "偏好短时学习"}],
        "knowledge_sources": [],
    }
    with (
        patch("src.core.agent.graph.get_agent", new=AsyncMock(return_value=fake_agent)),
        patch(
            "src.services.chat_context.build_chat_context",
            new=AsyncMock(return_value=(prepared_context, {"latency_ms": 12.0})),
        ),
    ):
        accepted = await client.post(
            "/api/v1/agent/stream",
            json=body,
            headers={"X-CSRF-Token": csrf},
        )
    assert accepted.status_code == 200
    assert "event: context_start" in accepted.text
    assert "event: context_ready" in accepted.text
    assert "event: context_trace" in accepted.text
    assert "event: done" in accepted.text
    assert fake_agent.state_input["chat_context"] == prepared_context


async def test_explicit_checkin_skips_full_chat_context(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    class FakeAgent:
        state_input = None

        async def astream_events(self, *args, **kwargs):
            self.state_input = args[0]
            if False:
                yield None

        async def aget_state(self, config):
            return SimpleNamespace(
                next=[],
                values={"checkin_rate": 1.0, "checkin_text": "今天完成了学习任务"},
            )

    fake_agent = FakeAgent()
    context_builder = AsyncMock()
    with (
        patch("src.core.agent.graph.get_agent", new=AsyncMock(return_value=fake_agent)),
        patch("src.services.chat_context.build_chat_context", new=context_builder),
    ):
        response = await client.post(
            "/api/v1/agent/stream",
            json={
                "message": "今天完成了学习任务",
                "goal_id": goal_id,
                "session_id": "checkin-fast-path",
            },
            headers=auth,
        )

    assert response.status_code == 200
    context_builder.assert_not_awaited()
    assert fake_agent.state_input["chat_context"] == {}
    assert "event: action_run" in response.text
    assert "确认本次学习打卡" in response.text
    assert await db.scalar(select(CheckinRecord).where(CheckinRecord.goal_id == goal_id)) is None


async def test_supported_task_mutation_dispatches_durable_action_run(
    client: AsyncClient, auth: dict, db
):
    run = SimpleNamespace(id="run-action-1")
    detail = {
        "id": run.id,
        "status": "queued",
        "request": "把所有逾期任务重新安排到未来一周",
        "steps": [],
        "approvals": [],
        "events": [],
    }
    context_builder = AsyncMock()
    with (
        patch(
            "src.core.agent_v2.orchestrator.create_run", new=AsyncMock(return_value=run)
        ) as create,
        patch("src.core.agent_v2.orchestrator.run_detail", new=AsyncMock(return_value=detail)),
        patch("src.tasks.agent_runs.dispatch_agent_run") as dispatch,
        patch("src.services.chat_context.build_chat_context", new=context_builder),
    ):
        response = await client.post(
            "/api/v1/agent/stream",
            json={"message": detail["request"], "session_id": "action-dispatch"},
            headers=auth,
        )

    assert response.status_code == 200
    assert "请选择这项任务所属的学习目标" in response.text
    assert "event: action_run" not in response.text
    create.assert_not_awaited()
    dispatch.assert_not_called()
    context_builder.assert_not_awaited()
    pending = await db.scalar(
        select(PendingActionIntent).where(PendingActionIntent.session_id == "action-dispatch")
    )
    assert pending is not None
    assert "goal" in pending.missing_slots


async def test_goal_scoped_overdue_reschedule_dispatches_durable_action_run(
    client: AsyncClient, auth: dict, goal_id: str
):
    run = SimpleNamespace(id="run-action-goal-scoped")
    detail = {
        "id": run.id,
        "status": "queued",
        "request": "把所有逾期任务重新安排到未来一周",
        "steps": [],
        "approvals": [],
        "events": [],
    }
    with (
        patch(
            "src.core.agent_v2.orchestrator.create_run", new=AsyncMock(return_value=run)
        ) as create,
        patch("src.core.agent_v2.orchestrator.run_detail", new=AsyncMock(return_value=detail)),
        patch("src.tasks.agent_runs.dispatch_agent_run") as dispatch,
    ):
        response = await client.post(
            "/api/v1/agent/stream",
            json={
                "message": detail["request"],
                "goal_id": goal_id,
                "session_id": "action-dispatch-goal-scoped",
            },
            headers=auth,
        )

    assert response.status_code == 200
    assert "event: action_start" in response.text
    assert "event: action_run" in response.text
    create.assert_awaited_once()
    assert create.call_args.kwargs["deterministic_plan_only"] is True
    assert create.call_args.kwargs["action_intent"].goal_id == goal_id
    dispatch.assert_called_once()


@pytest.mark.parametrize(
    ("message", "expected_effect"),
    [
        ("欠着的项目帮我摊到下周，先出草案别落库。", "reschedule"),
        ("逾期那批请避开周三，逐项给新日期让我看。", "reschedule"),
        ("给测试目标记一条明早二十分钟的错题整理，先让我审。", "create"),
    ],
)
async def test_new_oral_action_categories_create_durable_sse_preview(
    client: AsyncClient, auth: dict, goal_id: str, message: str, expected_effect: str
):
    run = SimpleNamespace(id=f"run-oral-{expected_effect}")
    detail = {
        "id": run.id,
        "status": "queued",
        "request": message,
        "steps": [],
        "approvals": [],
        "events": [],
    }
    with (
        patch("src.core.agent_v2.orchestrator.create_run", new=AsyncMock(return_value=run)) as create,
        patch("src.core.agent_v2.orchestrator.run_detail", new=AsyncMock(return_value=detail)),
        patch("src.tasks.agent_runs.dispatch_agent_run") as dispatch,
    ):
        response = await client.post(
            "/api/v1/agent/stream",
            json={"message": message, "goal_id": goal_id, "session_id": f"oral-{expected_effect}"},
            headers=auth,
        )
    assert response.status_code == 200
    assert "event: action_run" in response.text
    create.assert_awaited_once()
    assert create.call_args.kwargs["action_intent"].requested_effect == expected_effect
    dispatch.assert_called_once()


@pytest.mark.parametrize(
    "message",
    [
        "如果我走确认链会怎样，只分析不要执行。",
        "我想了解减负草案，不要生成变更。",
        "能不能清掉章节练习？先说风险，不要执行。",
    ],
)
async def test_analysis_and_hypothetical_guards_use_conversation_sse_without_writes(
    client: AsyncClient, auth: dict, goal_id: str, db, message: str
):
    class FakeAgent:
        async def astream_events(self, *args, **kwargs):
            if False:
                yield None

        async def aget_state(self, config):
            return SimpleNamespace(next=[], values={"response": "仅分析，不执行。"})

    session_id = f"speech-guard-conversation-{uuid.uuid4().hex}"
    before = {
        "runs": int(await db.scalar(select(func.count(AgentRun.id))) or 0),
        "tasks": int(await db.scalar(select(func.count(Task.id))) or 0),
        "checkins": int(await db.scalar(select(func.count(CheckinRecord.id))) or 0),
    }
    with (
        patch("src.core.agent.graph.get_agent", new=AsyncMock(return_value=FakeAgent())),
        patch(
            "src.services.chat_context.build_chat_context",
            new=AsyncMock(return_value=({}, {"latency_ms": 0.0})),
        ),
        patch("src.core.agent_v2.orchestrator.create_run", new=AsyncMock()) as create,
    ):
        response = await client.post(
            "/api/v1/agent/stream",
            json={"message": message, "goal_id": goal_id, "session_id": session_id},
            headers=auth,
        )
    assert response.status_code == 200
    assert "event: action_start" not in response.text
    assert "event: action_run" not in response.text
    create.assert_not_awaited()
    assert await db.scalar(
        select(PendingActionIntent).where(PendingActionIntent.session_id == session_id)
    ) is None
    after = {
        "runs": int(await db.scalar(select(func.count(AgentRun.id))) or 0),
        "tasks": int(await db.scalar(select(func.count(Task.id))) or 0),
        "checkins": int(await db.scalar(select(func.count(CheckinRecord.id))) or 0),
    }
    assert after == before


@pytest.mark.parametrize(
    "message",
    [
        "章节练习可以清掉吗？只给高风险预览，别写。",
        "清掉章节练习，先给高风险预览。",
        "移除章节练习前把风险和恢复方式说清，先给预览。",
    ],
)
async def test_explicit_delete_preview_guard_enters_action_sse_without_business_write(
    client: AsyncClient, auth: dict, goal_id: str, db, message: str
):
    task = Task(
        id=f"speech-preview-{uuid.uuid4().hex}",
        goal_id=goal_id,
        title="章节练习",
        scheduled_date=date.today().isoformat(),
    )
    db.add(task)
    await db.flush()
    before = {
        "status": task.status,
        "date": task.scheduled_date,
        "version": task.version,
        "checkins": int(await db.scalar(select(func.count(CheckinRecord.id))) or 0),
    }
    run = SimpleNamespace(id=f"speech-preview-run-{uuid.uuid4().hex}")
    detail = {
        "id": run.id,
        "status": "queued",
        "request": message,
        "steps": [],
        "approvals": [],
        "events": [],
    }
    session_id = f"speech-preview-session-{uuid.uuid4().hex}"
    with (
        patch("src.core.agent_v2.orchestrator.create_run", new=AsyncMock(return_value=run)) as create,
        patch("src.core.agent_v2.orchestrator.run_detail", new=AsyncMock(return_value=detail)),
        patch("src.tasks.agent_runs.dispatch_agent_run") as dispatch,
    ):
        response = await client.post(
            "/api/v1/agent/stream",
            json={"message": message, "goal_id": goal_id, "session_id": session_id},
            headers=auth,
        )
    assert response.status_code == 200
    assert "event: action_start" in response.text
    assert "event: action_run" in response.text
    intent = create.call_args.kwargs["action_intent"]
    assert intent.requested_effect == "delete"
    assert [ref.entity_id for ref in intent.entity_refs if ref.entity == "task"] == [task.id]
    dispatch.assert_called_once()
    await db.refresh(task)
    assert {
        "status": task.status,
        "date": task.scheduled_date,
        "version": task.version,
        "checkins": int(await db.scalar(select(func.count(CheckinRecord.id))) or 0),
    } == before
    assert await db.scalar(
        select(PendingActionIntent).where(PendingActionIntent.session_id == session_id)
    ) is None


async def test_incomplete_action_clarifies_without_creating_run(
    client: AsyncClient, auth: dict, goal_id: str
):
    with patch("src.core.agent_v2.orchestrator.create_run", new=AsyncMock()) as create:
        response = await client.post(
            "/api/v1/agent/stream",
            json={
                "message": "新增任务“复习二分查找”",
                "goal_id": goal_id,
                "session_id": "action-clarification",
            },
            headers=auth,
        )

    assert response.status_code == 200
    assert "请补充执行日期" in response.text
    assert "event: action_run" not in response.text
    create.assert_not_awaited()


async def test_pending_action_intent_completes_across_turns(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    session_id = f"pending-{uuid.uuid4()}"
    first = await client.post(
        "/api/v1/agent/stream",
        json={
            "message": "新增任务“复习二分查找”",
            "goal_id": goal_id,
            "session_id": session_id,
        },
        headers=auth,
    )
    assert first.status_code == 200
    assert "请补充执行日期" in first.text
    pending = await db.scalar(
        select(PendingActionIntent).where(PendingActionIntent.session_id == session_id)
    )
    assert pending is not None

    second = await client.post(
        "/api/v1/agent/stream",
        json={"message": "明天", "goal_id": goal_id, "session_id": session_id},
        headers=auth,
    )
    assert second.status_code == 200
    assert "event: action_run" in second.text
    assert (
        await db.scalar(
            select(PendingActionIntent).where(PendingActionIntent.session_id == session_id)
        )
        is None
    )
    run = await db.scalar(select(AgentRun).where(AgentRun.request_text.contains("复习二分查找")))
    assert run is not None
    assert run.trace_context["need_frame"]["mode"] == "action"
    assert run.trace_context["action_intent"]["resolution_quality"] == "exact"


async def test_pending_action_intent_is_session_scoped_and_cancellable(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    first_session = f"pending-a-{uuid.uuid4()}"
    second_session = f"pending-b-{uuid.uuid4()}"
    await client.post(
        "/api/v1/agent/stream",
        json={
            "message": "新增任务“会话隔离任务”",
            "goal_id": goal_id,
            "session_id": first_session,
        },
        headers=auth,
    )
    unrelated = await client.post(
        "/api/v1/agent/stream",
        json={"message": "明天", "goal_id": goal_id, "session_id": second_session},
        headers=auth,
    )
    assert "event: action_run" not in unrelated.text
    cancelled = await client.post(
        "/api/v1/agent/stream",
        json={"message": "取消", "goal_id": goal_id, "session_id": first_session},
        headers=auth,
    )
    assert "已经取消" in cancelled.text
    assert (
        await db.scalar(
            select(PendingActionIntent).where(PendingActionIntent.session_id == first_session)
        )
        is None
    )


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
        "src.api.agent.ainvoke_structured_checked",
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
        "src.api.agent.ainvoke_structured_checked",
        new=AsyncMock(return_value=await mock.ainvoke([])),
    ):
        r = await client.post(
            "/api/v1/agent/verify",
            json={"goal_id": goal_id, "task_id": "nonexistent"},
            headers=auth,
        )
    assert r.status_code == 404


async def test_verify_answer_pass(client: AsyncClient, auth: dict, goal_id: str, db):
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
        "src.api.agent.ainvoke_structured_checked",
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
    with patch("src.api.agent.create_critical_llm", return_value=a_mock) as llm_factory:
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
    evidence_events = list(
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.aggregate_id == task_id,
                    LearningEvent.event_type.in_(
                        [
                            "MasteryAssessmentSubmitted",
                            "MasteryEvidenceAdded",
                            "MasteryRecorded",
                        ]
                    ),
                )
            )
        ).scalars()
    )
    assert {event.event_type for event in evidence_events} == {
        "MasteryAssessmentSubmitted",
        "MasteryEvidenceAdded",
        "MasteryRecorded",
    }
    evidence = next(
        event for event in evidence_events if event.event_type == "MasteryEvidenceAdded"
    )
    assert evidence.payload["evidence_type"] == "explanation"
    assert evidence.payload["contains_user_content"] is False


async def test_verify_answer_fail_with_suggestion(
    client: AsyncClient, auth: dict, goal_id: str, db
):
    today = date.today().isoformat()
    r_task = await client.post(
        "/api/v1/tasks",
        json={"title": "Python 装饰器", "goalId": goal_id, "date": today},
        headers=auth,
    )
    task_id = r_task.json()["id"]

    q_mock = _mock_llm("解释装饰器的工作原理")
    with patch(
        "src.api.agent.ainvoke_structured_checked",
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
    with patch("src.api.agent.create_critical_llm", return_value=a_mock):
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
    event_types = set(
        (
            await db.execute(
                select(LearningEvent.event_type).where(LearningEvent.aggregate_id == task_id)
            )
        ).scalars()
    )
    assert "MasteryAssessmentSubmitted" in event_types
    assert "MasteryEvidenceAdded" not in event_types


async def test_legacy_direct_replan_endpoint_removed(client: AsyncClient, auth: dict, goal_id: str):
    response = await client.post(f"/api/v1/agent/replan/{goal_id}", headers=auth)
    assert response.status_code == 404
