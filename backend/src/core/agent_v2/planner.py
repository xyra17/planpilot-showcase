from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

from pydantic import TypeAdapter

from src.core.agent_v2.registry import ToolRegistry
from src.core.agent_v2.resolver import validate_plan
from src.core.agent_v2.schemas import (
    ActionIntent,
    AgentPlan,
    AgentRole,
    Effect,
    OutputRef,
    PlanStep,
)
from src.core.llm_router import create_json_llm, require_json_object

MODEL_PLANNER_TIMEOUT_SECONDS = 15.0

WEEKDAY_PATTERNS = {
    "周一": 0,
    "星期一": 0,
    "周二": 1,
    "星期二": 1,
    "周三": 2,
    "星期三": 2,
    "周四": 3,
    "星期四": 3,
    "周五": 4,
    "星期五": 4,
    "周六": 5,
    "星期六": 5,
    "周日": 6,
    "星期日": 6,
    "星期天": 6,
}


def parse_constraints(request: str) -> dict[str, Any]:
    excluded = {
        weekday
        for label, weekday in WEEKDAY_PATTERNS.items()
        if re.search(rf"{label}.{{0,8}}(不要|不排|避开|没空|不可用)", request)
    }
    day_match = re.search(r"最近\s*(\d{1,2})\s*天", request)
    return {
        "lookback_days": max(7, min(90, int(day_match.group(1)) if day_match else 14)),
        "excluded_weekdays": sorted(excluded),
        "requires_confirmation": any(
            term in request for term in ("确认", "批准", "同意后", "修改前")
        ),
        "time_granularity_note": "当前任务按日期保存，因此晚上不可用先按整天避开。"
        if "晚上" in request
        else None,
    }


def deterministic_plan(
    registry: ToolRegistry,
    request: str,
    goal_id: str | None,
    *,
    planner: str = "deterministic",
    action_intent: ActionIntent | None = None,
) -> AgentPlan:
    constraints = parse_constraints(request)
    candidates = [tool.name for tool in registry.search(request, limit=7)]
    objective = {"intent": "analyze_and_reschedule", "goal_id": goal_id, "constraints": constraints}
    if any(term in request for term in ("知识", "资料", "检索", "搜索")) and not any(
        term in request for term in ("安排", "调整", "落后", "逾期", "重规划")
    ):
        objective["intent"] = "knowledge_research"
        return AgentPlan(
            planner=planner,
            objective=objective,
            candidate_tools=candidates,
            steps=[
                PlanStep(
                    index=0,
                    step_id="knowledge-search",
                    title="检索项目知识",
                    agent_role=AgentRole.KNOWLEDGE_RESEARCHER,
                    tool_name="knowledge.search",
                    input={"query": request, "goal_id": goal_id},
                    rationale="从用户知识库检索相关材料",
                )
            ],
        )

    steps = [
        PlanStep(
            index=0,
            step_id="load-context",
            title="读取学习上下文",
            agent_role=AgentRole.LEARNING_ANALYST,
            tool_name="context.load",
            input={"goal_id": goal_id, "lookback_days": constraints["lookback_days"]},
            rationale="取得目标、任务和打卡的最小必要上下文",
        ),
        PlanStep(
            index=1,
            step_id="analyze-execution",
            title="分析近期执行情况",
            agent_role=AgentRole.LEARNING_ANALYST,
            tool_name="analytics.execution_summary",
            input_refs={"context": OutputRef(step_id="load-context")},
            depends_on=["load-context"],
            rationale="识别执行率和逾期任务",
        ),
    ]
    mutation_terms = (
        "安排",
        "调整",
        "落后",
        "逾期",
        "重规划",
        "改到",
        "新增",
        "创建",
        "添加",
        "删除任务",
        "删掉任务",
        "移除任务",
        "完成任务",
        "标记完成",
    )
    if not action_intent and not any(term in request for term in mutation_terms):
        objective["intent"] = "execution_analysis"
        return AgentPlan(
            planner=planner, objective=objective, candidate_tools=candidates, steps=steps
        )
    is_insight = bool(action_intent and action_intent.capability == "insight_action")
    is_crud = bool(action_intent and action_intent.capability == "task_mutation") or any(
        term in request
        for term in (
            "新增",
            "创建",
            "添加",
            "删除任务",
            "删掉任务",
            "移除任务",
            "完成任务",
            "标记完成",
            "改到",
        )
    )
    preview_name = (
        "insights.preview_action"
        if is_insight
        else "tasks.preview_mutation"
        if is_crud
        else "schedule.preview_reschedule"
    )
    preview_input = (
        {"proposal_id": str(action_intent.constraints["proposal_id"])}
        if is_insight and action_intent
        else {
            "excluded_weekdays": constraints["excluded_weekdays"],
            "request": request,
            "goal_id": goal_id,
            "action_intent": action_intent.model_dump(mode="json") if action_intent else {},
        }
    )
    preview_refs = {"context": OutputRef(step_id="load-context")}
    if not is_insight:
        preview_refs["analysis"] = OutputRef(step_id="analyze-execution")
    steps.extend(
        [
            PlanStep(
                index=2,
                step_id="preview-changes",
                title=(
                    "把学习洞察转换为行动方案"
                    if is_insight
                    else "生成任务变更方案"
                    if is_crud
                    else "生成重新排期方案"
                ),
                agent_role=AgentRole.SCHEDULE_OPTIMIZER,
                tool_name=preview_name,
                input=preview_input,
                input_refs=preview_refs,
                depends_on=["load-context", "analyze-execution"],
                on_failure="replan",
                rationale="形成可审查且尚未执行的 ChangeSet",
            ),
            PlanStep(
                index=3,
                step_id="review-changes",
                title="审查变更方案",
                agent_role=AgentRole.PLAN_REVIEWER,
                tool_name="plan.review",
                input_refs={
                    "change_set": OutputRef(step_id="preview-changes"),
                    "context": OutputRef(step_id="load-context"),
                },
                depends_on=["load-context", "preview-changes"],
                rationale="检查删除、规模和冲突风险",
            ),
            PlanStep(
                index=4,
                step_id="apply-changes",
                title="应用获批修改",
                agent_role=AgentRole.MAIN,
                tool_name="tasks.apply_changes",
                input_refs={
                    "change_set": OutputRef(step_id="preview-changes"),
                    "review": OutputRef(step_id="review-changes"),
                },
                depends_on=["preview-changes", "review-changes"],
                on_failure="replan",
                rationale="仅执行用户批准的变更集",
            ),
        ]
    )
    return AgentPlan(planner=planner, objective=objective, candidate_tools=candidates, steps=steps)


async def create_plan(
    registry: ToolRegistry,
    request: str,
    goal_id: str | None,
    *,
    step_budget: int,
    version: int = 1,
    action_intent: ActionIntent | None = None,
    deterministic_only: bool = False,
) -> tuple[AgentPlan, dict[str, Any]]:
    started = time.monotonic()
    attempted_model: str | None = None
    attempted_tokens = 0
    fallback = deterministic_plan(registry, request, goal_id, action_intent=action_intent)
    scored = registry.search_with_scores(request, limit=5)
    candidate_names = {tool.name for _score, tool in scored} | {
        step.tool_name for step in fallback.steps
    }
    candidate_scores = {tool.name: score for score, tool in scored}
    for name in candidate_names:
        candidate_scores.setdefault(name, 0)
    catalog = [row for row in registry.public_catalog() if row["name"] in candidate_names]
    if deterministic_only:
        fallback.planner = "deterministic"
        fallback.estimated_tokens = 0
        validate_plan(fallback, available_tools=registry.names(), step_budget=step_budget)
        return fallback, {
            "version": version,
            "planner": "deterministic",
            "model": None,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "token_usage": 0,
            "candidates": [
                {"name": name, "score": candidate_scores[name]}
                for name in sorted(
                    candidate_names, key=lambda item: (-candidate_scores[item], item)
                )
            ],
            "selected_tools": [step.tool_name for step in fallback.steps],
            "step_rationales": {step.step_id: step.rationale for step in fallback.steps},
            "validation": {
                "status": "deterministic_accepted",
                "checks": ["action_intent", "registry", "roles", "dependencies", "write_order"],
            },
            "fallback": False,
            "fallback_reason": None,
        }
    prompt = {
        "task": "Generate an AgentPlan JSON. Use only catalog tools. Dependencies and input_refs use stable step_id. Subagents cannot use write/destructive/external tools. All writes must follow proposal and review steps.",
        "request": request,
        "goal_id": goal_id,
        "version": version,
        "step_budget": step_budget,
        "catalog": catalog,
        "schema": AgentPlan.model_json_schema(),
    }
    try:
        llm = create_json_llm(temperature=0)
        response = await asyncio.wait_for(
            llm.ainvoke(
                [
                    {"role": "system", "content": "Return one JSON object only."},
                    {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
                ]
            ),
            timeout=MODEL_PLANNER_TIMEOUT_SECONDS,
        )
        attempted_model = str(
            (getattr(response, "response_metadata", None) or {}).get("model_name", "routine")
        )
        response_usage = getattr(response, "usage_metadata", None) or {}
        attempted_tokens = int(
            response_usage.get("total_tokens") or max(1, len(str(response.content)) // 4)
        )
        require_json_object(str(response.content))
        raw = json.loads(
            str(response.content)[
                str(response.content).find("{") : str(response.content).rfind("}") + 1
            ]
        )
        plan = AgentPlan.model_validate(
            {
                **raw,
                "version": version,
                "planner": "model",
                "candidate_tools": [item["name"] for item in catalog],
            }
        )
        # Objective and constraints are normalized from the original request on the server.
        plan.objective = fallback.objective
        for index, step in enumerate(plan.steps):
            step.index = index
            spec = registry.get(step.tool_name)
            if step.tool_name not in candidate_names:
                raise ValueError(f"工具不在候选目录中: {step.tool_name}")
            if step.agent_role != spec.role:
                raise ValueError(f"工具角色不匹配: {step.tool_name}")
            if step.agent_role != AgentRole.MAIN and spec.effect in {
                Effect.WRITE,
                Effect.DESTRUCTIVE,
                Effect.EXTERNAL,
            }:
                raise ValueError("受控能力模块计划包含副作用工具")
            supplied = set(step.input) | set(step.input_refs)
            unknown = supplied - set(spec.input_model.model_fields)
            if unknown:
                raise ValueError(f"工具参数未注册: {step.tool_name} {sorted(unknown)}")
            for name, field in spec.input_model.model_fields.items():
                if field.is_required() and name not in supplied:
                    raise ValueError(f"工具缺少参数: {step.tool_name}.{name}")
            for name, value in step.input.items():
                field = spec.input_model.model_fields.get(name)
                if field:
                    TypeAdapter(field.annotation).validate_python(value)
            _reject_unsafe_model_input(step.input)
        _validate_write_order(plan, registry)
        plan.estimated_tokens = attempted_tokens
        validate_plan(plan, available_tools=registry.names(), step_budget=step_budget)
        trace = {
            "version": version,
            "planner": "model",
            "model": attempted_model,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "token_usage": plan.estimated_tokens,
            "candidates": [
                {"name": name, "score": candidate_scores[name]}
                for name in sorted(
                    candidate_names, key=lambda item: (-candidate_scores[item], item)
                )
            ],
            "selected_tools": [step.tool_name for step in plan.steps],
            "step_rationales": {step.step_id: step.rationale for step in plan.steps},
            "validation": {
                "status": "accepted",
                "checks": ["registry", "roles", "schemas", "dependencies", "write_order", "budget"],
            },
            "fallback": False,
            "fallback_reason": None,
        }
        return plan, trace
    except Exception as exc:
        fallback_reason = (
            f"模型规划超过 {MODEL_PLANNER_TIMEOUT_SECONDS:g} 秒，已使用确定性规划"
            if isinstance(exc, TimeoutError)
            else str(exc)[:500]
        )
        plan = fallback
        plan.planner = "fallback"
        plan.version = version
        plan.estimated_tokens = attempted_tokens or max(1, len(request) // 2)
        validate_plan(plan, available_tools=registry.names(), step_budget=step_budget)
        trace = {
            "version": version,
            "planner": "fallback",
            "model": attempted_model,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "token_usage": plan.estimated_tokens,
            "candidates": [
                {"name": name, "score": candidate_scores[name]}
                for name in sorted(
                    candidate_names, key=lambda item: (-candidate_scores[item], item)
                )
            ],
            "selected_tools": [step.tool_name for step in plan.steps],
            "step_rationales": {step.step_id: step.rationale for step in plan.steps},
            "validation": {
                "status": "fallback_accepted",
                "rejected_reason": fallback_reason,
            },
            "fallback": True,
            "fallback_reason": fallback_reason,
        }
        return plan, trace


def _reject_unsafe_model_input(value: Any, *, key: str = "") -> None:
    forbidden = {"user_id", "sql", "shell", "code", "command", "url", "endpoint"}
    if isinstance(value, dict):
        for child_key, child_value in value.items():
            if child_key.lower() in forbidden:
                raise ValueError(f"模型计划包含禁止字段: {child_key}")
            _reject_unsafe_model_input(child_value, key=child_key)
    elif isinstance(value, list):
        for item in value:
            _reject_unsafe_model_input(item, key=key)
    elif isinstance(value, str) and value.strip().lower().startswith(("http://", "https://")):
        raise ValueError(f"模型计划包含未授权 URL: {key}")


def _validate_write_order(plan: AgentPlan, registry: ToolRegistry) -> None:
    by_id = {step.step_id: step for step in plan.steps}

    def ancestors(step_id: str) -> set[str]:
        found: set[str] = set()
        pending = list(by_id[step_id].depends_on)
        while pending:
            dependency = pending.pop()
            if dependency in found:
                continue
            found.add(dependency)
            pending.extend(by_id[dependency].depends_on)
        return found

    writes = [
        step
        for step in plan.steps
        if registry.get(step.tool_name).effect
        in {Effect.WRITE, Effect.DESTRUCTIVE, Effect.EXTERNAL}
    ]
    for step in writes:
        upstream = [by_id[key] for key in ancestors(step.step_id)]
        if not any(registry.get(item.tool_name).effect == Effect.PROPOSE for item in upstream):
            raise ValueError("写步骤之前缺少 proposal")
        if not any(item.agent_role == AgentRole.PLAN_REVIEWER for item in upstream):
            raise ValueError("写步骤之前缺少 review")
    for index, left in enumerate(writes):
        for right in writes[index + 1 :]:
            if left.step_id not in ancestors(right.step_id) and right.step_id not in ancestors(
                left.step_id
            ):
                raise ValueError("计划包含可并发执行的写步骤")
