from __future__ import annotations

import re
from typing import Any

from src.core.agent_v2.registry import ToolRegistry
from src.core.agent_v2.schemas import AgentRole, Effect, PlanStep

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
    excluded: set[int] = set()
    for label, weekday in WEEKDAY_PATTERNS.items():
        if re.search(rf"{label}.{{0,8}}(不要|不排|避开|没空|不可用)", request):
            excluded.add(weekday)
    day_match = re.search(r"最近\s*(\d{1,2})\s*天", request)
    lookback_days = int(day_match.group(1)) if day_match else 14
    return {
        "lookback_days": max(7, min(90, lookback_days)),
        "excluded_weekdays": sorted(excluded),
        "requires_confirmation": any(
            term in request for term in ("确认", "批准", "同意后", "修改前")
        ),
        "time_granularity_note": (
            "当前任务按日期保存，因此“晚上不可用”先按整天避开；"
            "后续接入时段任务后可精确到小时。"
            if "晚上" in request
            else None
        ),
    }


def create_plan(
    registry: ToolRegistry, request: str, goal_id: str | None
) -> tuple[dict[str, Any], list[PlanStep]]:
    constraints = parse_constraints(request)
    candidates = [tool.name for tool in registry.search(request, limit=5)]
    objective = {
        "intent": "analyze_and_reschedule",
        "goal_id": goal_id,
        "constraints": constraints,
        "candidate_tools": candidates,
    }
    if any(term in request for term in ("知识", "资料", "检索", "搜索")) and not any(
        term in request for term in ("安排", "调整", "落后", "逾期", "重规划")
    ):
        knowledge_tool = next(
            tool
            for tool in registry.search("搜索 知识库 学习资料", limit=10)
            if tool.role == AgentRole.KNOWLEDGE_RESEARCHER
        )
        objective["intent"] = "knowledge_research"
        return objective, [
            PlanStep(
                index=0,
                title="检索项目知识",
                agent_role=knowledge_tool.role,
                tool_name=knowledge_tool.name,
                input={"query": request, "goal_id": goal_id},
            )
        ]

    context_tool = next(
        tool
        for tool in registry.search("读取 用户 目标 任务 打卡 上下文", limit=10)
        if tool.name == "context.load"
    )
    analytics_tool = next(
        tool
        for tool in registry.search("分析 执行率 逾期 学习债务", limit=10)
        if tool.role == AgentRole.LEARNING_ANALYST and tool.name != context_tool.name
    )
    base_steps = [
        PlanStep(
            index=0,
            title="读取学习上下文",
            agent_role=context_tool.role,
            tool_name=context_tool.name,
            input={"goal_id": goal_id, "lookback_days": constraints["lookback_days"]},
        ),
        PlanStep(
            index=1,
            title="分析近期执行情况",
            agent_role=analytics_tool.role,
            tool_name=analytics_tool.name,
            depends_on=[0],
        ),
    ]
    if not any(
        term in request for term in ("安排", "调整", "落后", "逾期", "重规划", "改到")
    ):
        objective["intent"] = "execution_analysis"
        return objective, base_steps

    preview_tool = next(
        tool
        for tool in registry.search("生成 任务 重新排期 预览", limit=10)
        if tool.role == AgentRole.SCHEDULE_OPTIMIZER
    )
    review_tool = next(
        tool
        for tool in registry.search("审查 变更 方案 风险", limit=10)
        if tool.role == AgentRole.PLAN_REVIEWER
    )
    write_tool = next(
        tool
        for tool in registry.search("应用 任务 日期 变更", limit=10)
        if tool.role == AgentRole.MAIN and tool.effect == Effect.WRITE
    )
    steps = [
        *base_steps,
        PlanStep(
            index=2,
            title="生成重新排期方案",
            agent_role=preview_tool.role,
            tool_name=preview_tool.name,
            input={"excluded_weekdays": constraints["excluded_weekdays"]},
            depends_on=[0, 1],
        ),
        PlanStep(
            index=3,
            title="审查变更方案",
            agent_role=review_tool.role,
            tool_name=review_tool.name,
            depends_on=[2],
        ),
        PlanStep(
            index=4,
            title="应用获批修改",
            agent_role=write_tool.role,
            tool_name=write_tool.name,
            depends_on=[2, 3],
        ),
    ]
    return objective, steps
