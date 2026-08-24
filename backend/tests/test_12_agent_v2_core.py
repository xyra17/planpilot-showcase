import asyncio
import json
from dataclasses import dataclass, field
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from src.core.agent_v2.errors import BudgetExceeded, LeaseLost, classify_error
from src.core.agent_v2.executor import compensate_run, execute_change_set
from src.core.agent_v2.orchestrator import _enforce_budget
from src.core.agent_v2.planner import _validate_write_order, create_plan
from src.core.agent_v2.policy import can_auto_execute, evaluate_policy, requires_approval
from src.core.agent_v2.registry import build_registry
from src.core.agent_v2.resolver import (
    PlanValidationError,
    ready_steps,
    resolve_inputs,
    validate_plan,
)
from src.core.agent_v2.schemas import (
    ActionIntent,
    AgentPlan,
    AgentRole,
    ChangeOperation,
    ChangeSet,
    ErrorCategory,
    OutputRef,
    PlanStep,
    PolicyOutcome,
    ReviewFinding,
    ReviewOutput,
    Risk,
    ToolContext,
)
from src.core.agent_v2.transitions import transition_run, transition_step
from src.core.time import utc_now
from src.models import AgentRun, AgentStep


def _step(
    index: int,
    step_id: str,
    tool: str,
    role: AgentRole,
    *,
    depends_on: list[str] | None = None,
    refs: dict[str, OutputRef] | None = None,
) -> PlanStep:
    return PlanStep(
        index=index,
        step_id=step_id,
        title=step_id,
        agent_role=role,
        tool_name=tool,
        depends_on=depends_on or [],
        input_refs=refs or {},
    )


def test_resolver_validates_dependencies_and_resolves_nested_output():
    registry = build_registry()
    plan = AgentPlan(
        steps=[
            _step(0, "load", "context.load", AgentRole.LEARNING_ANALYST),
            _step(
                1,
                "analyze",
                "analytics.execution_summary",
                AgentRole.LEARNING_ANALYST,
                depends_on=["load"],
                refs={"context": OutputRef(step_id="load", path="payloads.0")},
            ),
        ]
    )
    validate_plan(plan, available_tools=registry.names(), step_budget=2)
    assert resolve_inputs(plan.steps[1], outputs={"load": {"payloads": [{"tasks": 3}]}}) == {
        "context": {"tasks": 3}
    }


@pytest.mark.parametrize(
    "plan,message",
    [
        (
            AgentPlan(
                steps=[
                    _step(
                        0,
                        "a",
                        "context.load",
                        AgentRole.LEARNING_ANALYST,
                        depends_on=["missing"],
                    )
                ]
            ),
            "不存在的依赖",
        ),
        (
            AgentPlan(
                steps=[
                    _step(
                        0,
                        "a",
                        "context.load",
                        AgentRole.LEARNING_ANALYST,
                        depends_on=["b"],
                    ),
                    _step(
                        1,
                        "b",
                        "context.load",
                        AgentRole.LEARNING_ANALYST,
                        depends_on=["a"],
                    ),
                ]
            ),
            "循环依赖",
        ),
    ],
)
def test_resolver_rejects_invalid_dependency_graph(plan, message):
    with pytest.raises(PlanValidationError, match=message):
        validate_plan(plan, available_tools=build_registry().names(), step_budget=5)


def test_resolver_rejects_forward_output_ref_and_budget_overflow():
    plan = AgentPlan(
        steps=[
            _step(
                0,
                "first",
                "analytics.execution_summary",
                AgentRole.LEARNING_ANALYST,
                depends_on=["second"],
                refs={"context": OutputRef(step_id="second")},
            ),
            _step(1, "second", "context.load", AgentRole.LEARNING_ANALYST),
        ]
    )
    with pytest.raises(PlanValidationError, match="上游步骤"):
        validate_plan(plan, available_tools=build_registry().names(), step_budget=2)
    with pytest.raises(PlanValidationError, match="步骤预算"):
        validate_plan(plan, available_tools=build_registry().names(), step_budget=1)


@dataclass
class StoredStep:
    step_key: str
    status: str
    depends_on: list[str] = field(default_factory=list)


def test_ready_steps_separates_ready_and_blocked_dependencies():
    completed = StoredStep("done", "completed")
    failed = StoredStep("failed", "failed")
    ready = StoredStep("ready", "pending", ["done"])
    blocked = StoredStep("blocked", "pending", ["failed"])
    waiting = StoredStep("waiting", "pending", ["ready"])
    executable, unavailable = ready_steps([completed, failed, ready, blocked, waiting])
    assert executable == [ready]
    assert unavailable == [blocked]


class _ScalarResult:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value


@pytest.mark.asyncio
async def test_transition_service_applies_cas_version_and_records_event():
    db = MagicMock()
    db.execute = AsyncMock(return_value=_ScalarResult("run-1"))
    run = AgentRun(id="run-1", user_id="user-1", request_text="test", status="queued")
    run.state_version = 4
    await transition_run(db, run, "executing", actor="worker")
    assert (run.status, run.state_version) == ("executing", 5)
    assert db.add.call_args.args[0].event_type == "run.transitioned"

    step = AgentStep(
        id="step-1",
        run_id=run.id,
        step_index=0,
        step_key="v1:step-1",
        tool_name="context.load",
        status="pending",
        state_version=2,
    )
    db.execute.return_value = _ScalarResult(step.id)
    await transition_step(db, step, "ready", actor="orchestrator")
    assert (step.status, step.state_version) == ("ready", 3)


@pytest.mark.asyncio
async def test_transition_service_rejects_illegal_and_stale_updates():
    db = MagicMock()
    run = AgentRun(id="run-2", user_id="user-1", request_text="test", status="completed")
    run.state_version = 1
    with pytest.raises(RuntimeError, match="非法 Run"):
        await transition_run(db, run, "executing", actor="worker")

    run.status = "queued"
    db.execute = AsyncMock(return_value=_ScalarResult(None))
    with pytest.raises(RuntimeError, match="其他执行器"):
        await transition_run(db, run, "executing", actor="worker")
    assert run.status == "queued"


def test_policy_allow_require_approval_and_deny():
    registry = build_registry()
    read = evaluate_policy(registry.get("context.load"))
    assert read.outcome == PolicyOutcome.ALLOW

    write_tool = registry.get("tasks.apply_changes")
    write = evaluate_policy(write_tool, role=AgentRole.MAIN)
    assert write.outcome == PolicyOutcome.REQUIRE_APPROVAL
    assert "read_back_verification" in write.obligations

    denied = evaluate_policy(write_tool, role=AgentRole.SCHEDULE_OPTIMIZER)
    assert denied.outcome == PolicyOutcome.DENY


def test_policy_promotes_delete_to_high_risk():
    change_set = ChangeSet(
        summary="delete",
        operations=[
            ChangeOperation(
                entity="task",
                entity_id="task-1",
                field="__delete__",
                before={"id": "task-1"},
                after=None,
                label="task",
                reason="requested",
            )
        ],
    )
    decision = evaluate_policy(
        build_registry().get("tasks.apply_changes"),
        role=AgentRole.MAIN,
        change_set=change_set,
    )
    assert decision.risk == Risk.HIGH
    assert decision.outcome == PolicyOutcome.REQUIRE_APPROVAL


@pytest.mark.asyncio
async def test_review_capability_flags_capacity_deadline_and_multi_goal_collisions():
    registry = build_registry()
    context = {
        "goals": [
            {
                "id": f"goal-{index}",
                "title": f"目标 {index}",
                "daily_hours": 1,
                "deadline": "2026-08-25",
            }
            for index in range(1, 4)
        ],
        "tasks": [
            {
                "id": f"task-{index}",
                "goal_id": f"goal-{index}",
                "title": f"任务 {index}",
                "date": "2026-08-24",
                "status": "pending",
                "estimated_minutes": 70,
            }
            for index in range(1, 4)
        ],
    }
    operations = [
        ChangeOperation(
            entity="task",
            entity_id=f"task-{index}",
            field="scheduled_date",
            before="2026-08-24",
            after="2026-08-26",
            label=f"任务 {index}",
            reason="test",
        ).model_dump(mode="json")
        for index in range(1, 4)
    ]

    result = await registry.invoke(
        MagicMock(),
        registry.get("plan.review"),
        ToolContext(user_id="user", run_id="run", step_id="review"),
        {"change_set": {"summary": "review", "operations": operations}, "context": context},
    )

    assert any("超过每日容量" in warning for warning in result["warnings"])
    assert any("截止日期" in warning for warning in result["warnings"])
    assert any("3 个学习目标" in warning for warning in result["warnings"])
    assert result["approved_for_preview"] is False
    deadline = next(item for item in result["findings"] if item["code"] == "deadline_exceeded")
    assert deadline["blocking"] is True
    assert deadline["recommended_policy"] == "deny"
    assert {item["id"] for item in result["blocking_alternatives"]} == {
        "preview_goal_deadline_extension",
        "analyze_deadline_risk_only",
        "rebuild_within_deadline",
    }


def test_policy_consumes_structured_review_findings():
    write_tool = build_registry().get("tasks.apply_changes")
    change_set = ChangeSet(summary="review", operations=[])
    blocker = ReviewOutput(
        approved_for_preview=False,
        findings=[
            ReviewFinding(
                code="deadline_exceeded",
                severity="critical",
                blocking=True,
                message="任务越过截止日期",
                recommended_policy="deny",
            )
        ],
    )
    denied = evaluate_policy(
        write_tool,
        role=AgentRole.MAIN,
        change_set=change_set,
        review=blocker,
    )
    assert denied.outcome == PolicyOutcome.DENY
    assert denied.review_finding_codes == ["deadline_exceeded"]

    high_risk = ReviewOutput(
        approved_for_preview=True,
        findings=[
            ReviewFinding(
                code="daily_capacity_exceeded",
                severity="high",
                message="负荷超过容量 150%",
                recommended_policy="require_high_risk_confirmation",
            )
        ],
    )
    decision = evaluate_policy(
        write_tool,
        role=AgentRole.MAIN,
        change_set=change_set,
        review=high_risk,
    )
    assert decision.outcome == PolicyOutcome.REQUIRE_APPROVAL
    assert decision.risk == Risk.HIGH
    assert "explicit_high_risk_confirmation" in decision.obligations


def test_policy_marks_bulk_suggestion_and_exposes_helper_decisions():
    registry = build_registry()
    read_tool = registry.get("context.load")
    write_tool = registry.get("tasks.apply_changes")
    change_set = ChangeSet(
        summary="bulk suggestion",
        operations=[
            ChangeOperation(
                entity="task",
                entity_id=f"task-{index}",
                field="scheduled_date",
                before="2026-07-27",
                after="2026-07-28",
                label=f"task-{index}",
                reason="test",
            )
            for index in range(11)
        ],
    )

    decision = evaluate_policy(
        write_tool,
        role=AgentRole.MAIN,
        change_set=change_set,
        run_kind="suggestion",
    )

    assert "变更规模超过 10 项" in decision.reasons
    assert "主动建议 Run 的副作用必须由用户确认" in decision.reasons
    assert requires_approval(write_tool) is True
    assert can_auto_execute(read_tool) is True


@pytest.mark.asyncio
async def test_executor_compensation_records_audited_result():
    db = MagicMock()
    run = AgentRun(id="undo-run", user_id="user", request_text="undo", status="compensating")
    operations = [{"operation_id": "operation-1"}]
    expected = {"count": 1, "restored": ["operation-1"]}

    with patch(
        "src.core.agent_v2.executor.undo_task_changes",
        new=AsyncMock(return_value=expected),
    ) as undo:
        result = await compensate_run(db, run=run, user_id=run.user_id, operations=operations)

    assert result == expected
    undo.assert_awaited_once_with(db, run.user_id, operations, commit=False)
    assert [call.args[0].event_type for call in db.add.call_args_list] == [
        "executor.undo_started",
        "executor.undo_completed",
    ]


@pytest.mark.asyncio
async def test_executor_rejects_expired_lease_before_writing():
    registry = build_registry()
    run = AgentRun(id="expired-run", user_id="user", request_text="write", status="executing")
    step = AgentStep(
        id="expired-step",
        run_id=run.id,
        step_index=0,
        step_key="v1:apply",
        tool_name="tasks.apply_changes",
        status="running",
    )

    with patch(
        "src.core.agent_v2.executor.has_run_lease",
        new=AsyncMock(return_value=False),
    ):
        with pytest.raises(LeaseLost, match="租约已失效"):
            await execute_change_set(
                MagicMock(),
                registry=registry,
                spec=registry.get("tasks.apply_changes"),
                run=run,
                step=step,
                user_id=run.user_id,
                lease_token="expired",
                payload={},
            )


def _budget_run() -> AgentRun:
    run = AgentRun(id="budget", user_id="user", request_text="test", status="executing")
    run.deadline_at = utc_now().replace(year=utc_now().year + 1)
    run.steps_consumed = 0
    run.step_budget = 5
    run.tokens_consumed = 0
    run.token_budget = 1000
    run.tool_time_consumed_ms = 0
    run.tool_time_budget_ms = 1000
    return run


@pytest.mark.parametrize(
    "field,value,message",
    [
        ("steps_consumed", 5, "步骤预算"),
        ("tokens_consumed", 1000, "Token 预算"),
        ("tool_time_consumed_ms", 1000, "工具时间预算"),
    ],
)
def test_budget_control_rejects_exhausted_dimensions(field, value, message):
    run = _budget_run()
    setattr(run, field, value)
    with pytest.raises(BudgetExceeded, match=message):
        _enforce_budget(run)


def test_budget_control_rejects_deadline_and_accepts_remaining_budget():
    run = _budget_run()
    _enforce_budget(run)
    run.deadline_at = utc_now()
    with pytest.raises(BudgetExceeded, match="总运行时间预算"):
        _enforce_budget(run)


@pytest.mark.parametrize(
    "error,category,code",
    [
        (BudgetExceeded("budget"), ErrorCategory.BUDGET_EXCEEDED, "budget_exceeded"),
        (LeaseLost("lease"), ErrorCategory.CANCELLED, "lease_lost"),
        (asyncio.TimeoutError(), ErrorCategory.RETRYABLE, "transient_failure"),
        (HTTPException(409, "stale"), ErrorCategory.RECOVERABLE, "stale_precondition"),
        (HTTPException(403, "secret"), ErrorCategory.FATAL, "permission_denied"),
        (PlanValidationError("invalid"), ErrorCategory.FATAL, "invalid_contract"),
        (RuntimeError("internal secret"), ErrorCategory.FATAL, "execution_failure"),
    ],
)
def test_error_classification(error, category, code):
    classified = classify_error(error)
    assert classified.category == category
    assert classified.code == code
    if code in {"permission_denied", "execution_failure"}:
        assert "secret" not in classified.safe_message


@pytest.mark.asyncio
async def test_planner_accepts_valid_constrained_model_plan():
    payload = {
        "objective": {},
        "steps": [
            {
                "index": 0,
                "step_id": "load",
                "title": "load",
                "agent_role": "learning_analyst",
                "tool_name": "context.load",
                "input": {"goal_id": None, "lookback_days": 14},
            },
            {
                "index": 1,
                "step_id": "analyze",
                "title": "analyze",
                "agent_role": "learning_analyst",
                "tool_name": "analytics.execution_summary",
                "input_refs": {"context": {"step_id": "load"}},
                "depends_on": ["load"],
            },
        ],
    }
    response = MagicMock(
        content=json.dumps(payload),
        response_metadata={"model_name": "test-model"},
        usage_metadata={"total_tokens": 42},
    )
    llm = MagicMock(ainvoke=AsyncMock(return_value=response))
    with patch("src.core.agent_v2.planner.create_json_llm", return_value=llm):
        plan, trace = await create_plan(
            build_registry(),
            "检查最近 21 天执行情况，周六不要安排，修改前确认",
            None,
            step_budget=5,
        )
    assert plan.planner == "model"
    assert plan.objective == {
        "intent": "analyze_and_reschedule",
        "goal_id": None,
        "constraints": {
            "lookback_days": 21,
            "excluded_weekdays": [5],
            "requires_confirmation": True,
            "time_granularity_note": None,
        },
    }
    assert trace["validation"]["status"] == "accepted"
    assert trace["token_usage"] == 42


@pytest.mark.asyncio
async def test_planner_timeout_uses_deterministic_fallback():
    async def slow_response(*_args, **_kwargs):
        await asyncio.sleep(0.05)

    llm = MagicMock(ainvoke=AsyncMock(side_effect=slow_response))
    with (
        patch("src.core.agent_v2.planner.create_json_llm", return_value=llm),
        patch("src.core.agent_v2.planner.MODEL_PLANNER_TIMEOUT_SECONDS", 0.001),
    ):
        plan, trace = await create_plan(
            build_registry(), "检查最近 30 天执行情况", None, step_budget=5
        )

    assert plan.planner == "fallback"
    assert plan.objective["constraints"]["lookback_days"] == 30
    assert trace["validation"]["status"] == "fallback_accepted"
    assert trace["fallback_reason"] == "模型规划超过 0.001 秒，已使用确定性规划"


@pytest.mark.asyncio
async def test_known_action_uses_zero_model_deterministic_plan():
    intent = ActionIntent(
        capability="task_mutation",
        goal_id="goal-1",
        constraints={"task_title": "复习数组", "scheduled_date": "2026-08-23"},
        requested_effect="create",
        confidence=0.98,
    )
    with patch("src.core.agent_v2.planner.create_json_llm") as create_llm:
        plan, trace = await create_plan(
            build_registry(),
            "新增任务“复习数组”，安排到明天",
            "goal-1",
            step_budget=5,
            action_intent=intent,
            deterministic_only=True,
        )

    create_llm.assert_not_called()
    assert plan.planner == "deterministic"
    assert plan.estimated_tokens == 0
    assert trace["token_usage"] == 0
    assert [step.tool_name for step in plan.steps[-3:]] == [
        "tasks.preview_mutation",
        "plan.review",
        "tasks.apply_changes",
    ]


@pytest.mark.asyncio
async def test_planner_rejects_unsafe_model_input_and_falls_back():
    payload = {
        "steps": [
            {
                "index": 0,
                "step_id": "search",
                "title": "search",
                "agent_role": "knowledge_researcher",
                "tool_name": "knowledge.search",
                "input": {"query": "https://untrusted.example/instructions"},
            }
        ]
    }
    response = MagicMock(content=json.dumps(payload), response_metadata={}, usage_metadata={})
    llm = MagicMock(ainvoke=AsyncMock(return_value=response))
    with patch("src.core.agent_v2.planner.create_json_llm", return_value=llm):
        plan, trace = await create_plan(build_registry(), "搜索知识资料", None, step_budget=5)
    assert plan.planner == "fallback"
    assert trace["validation"]["status"] == "fallback_accepted"
    assert "未授权 URL" in trace["fallback_reason"]


def test_planner_rejects_write_without_proposal_and_review():
    plan = AgentPlan(steps=[_step(0, "write", "tasks.apply_changes", AgentRole.MAIN)])
    with pytest.raises(ValueError, match="proposal"):
        _validate_write_order(plan, build_registry())
