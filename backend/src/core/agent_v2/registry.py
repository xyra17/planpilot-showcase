from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.agent_v2.schemas import (
    AgentRole,
    AnalyticsInput,
    AnalyticsOutput,
    ApplyChangesInput,
    ApplyChangesOutput,
    ChangeSet,
    ContextLoadInput,
    ContextLoadOutput,
    Effect,
    KnowledgeSearchInput,
    KnowledgeSearchOutput,
    RescheduleInput,
    ReviewInput,
    ReviewOutput,
    Risk,
    ToolContext,
)
from src.core.time import local_date_for_timezone
from src.models import User
from src.services.agent_context import load_learning_context, summarize_execution
from src.services.agent_schedule import (
    apply_task_changes,
    build_reschedule_preview,
    build_task_mutation_preview,
)
from src.services.retrieval_service import retrieval_service

Handler = Callable[[AsyncSession, ToolContext, dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    role: AgentRole
    effect: Effect
    risk: Risk
    requires_approval: bool
    timeout_seconds: int
    max_retries: int
    idempotent: bool
    supports_undo: bool
    handler: Handler
    input_model: type[BaseModel]
    output_model: type[BaseModel]
    compensation: str | None = None


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}

    def register(self, tool: ToolSpec) -> None:
        if tool.name in self._tools:
            raise ValueError(f"工具重复注册: {tool.name}")
        if (
            tool.effect in {Effect.WRITE, Effect.DESTRUCTIVE, Effect.EXTERNAL}
            and tool.role != AgentRole.MAIN
        ):
            raise ValueError("从属 Agent 不得注册写工具")
        self._tools[tool.name] = tool

    def get(self, name: str) -> ToolSpec:
        if name not in self._tools:
            raise KeyError(f"未注册工具: {name}")
        return self._tools[name]

    def search(self, query: str, limit: int = 5) -> list[ToolSpec]:
        return [tool for _score, tool in self.search_with_scores(query, limit=limit)]

    def search_with_scores(self, query: str, limit: int = 5) -> list[tuple[int, ToolSpec]]:
        tokens = {token.lower() for token in query.replace("，", " ").split() if token}
        scored: list[tuple[int, ToolSpec]] = []
        for tool in self._tools.values():
            haystack = f"{tool.name} {tool.description}".lower()
            score = sum(token in haystack for token in tokens)
            scored.append((score, tool))
        scored.sort(key=lambda row: (-row[0], row[1].name))
        return scored[:limit]

    def names(self) -> set[str]:
        return set(self._tools)

    def allowed_for_role(self, role: AgentRole) -> list[ToolSpec]:
        return [
            tool
            for tool in self._tools.values()
            if tool.role == role
            and tool.effect not in {Effect.WRITE, Effect.DESTRUCTIVE, Effect.EXTERNAL}
        ]

    async def invoke(
        self, db: AsyncSession, spec: ToolSpec, ctx: ToolContext, payload: dict[str, Any]
    ) -> dict[str, Any]:
        validated = spec.input_model.model_validate(payload)
        result = await spec.handler(db, ctx, validated.model_dump())
        return spec.output_model.model_validate(result).model_dump(mode="json")

    def public_catalog(self) -> list[dict[str, Any]]:
        return [
            {
                "name": tool.name,
                "description": tool.description,
                "role": tool.role.value,
                "effect": tool.effect.value,
                "risk": tool.risk.value,
                "requires_approval": tool.requires_approval,
                "supports_undo": tool.supports_undo,
                "input_schema": tool.input_model.model_json_schema(),
                "output_schema": tool.output_model.model_json_schema(),
                "compensation": tool.compensation,
            }
            for tool in sorted(self._tools.values(), key=lambda item: item.name)
        ]


async def _load_context(
    db: AsyncSession, ctx: ToolContext, payload: dict[str, Any]
) -> dict[str, Any]:
    return await load_learning_context(
        db,
        ctx.user_id,
        goal_id=payload.get("goal_id"),
        lookback_days=int(payload.get("lookback_days", 14)),
    )


async def _execution_summary(
    _db: AsyncSession, _ctx: ToolContext, payload: dict[str, Any]
) -> dict[str, Any]:
    return summarize_execution(payload["context"])


async def _reschedule_preview(
    db: AsyncSession, ctx: ToolContext, payload: dict[str, Any]
) -> dict[str, Any]:
    user = await db.get(User, ctx.user_id)
    today = local_date_for_timezone(user.timezone if user else "UTC")
    return build_reschedule_preview(
        payload["context"],
        excluded_weekdays=payload.get("excluded_weekdays", []),
        today=today,
    ).model_dump()


async def _task_mutation_preview(
    db: AsyncSession, ctx: ToolContext, payload: dict[str, Any]
) -> dict[str, Any]:
    user = await db.get(User, ctx.user_id)
    today = local_date_for_timezone(user.timezone if user else "UTC")
    return build_task_mutation_preview(
        payload["context"],
        request=str(payload["request"]),
        goal_id=payload.get("goal_id"),
        excluded_weekdays=payload.get("excluded_weekdays", []),
        today=today,
    ).model_dump()


async def _review_plan(
    _db: AsyncSession, _ctx: ToolContext, payload: dict[str, Any]
) -> dict[str, Any]:
    change_set = payload["change_set"]
    warnings = list(change_set.get("warnings", []))
    if any(item.get("field") == "__delete__" for item in change_set.get("operations", [])):
        warnings.append("方案包含删除操作，执行前请重点核对；撤销依赖所属目标仍存在")
    if len(change_set.get("operations", [])) > 10:
        warnings.append("一次调整超过 10 项任务，建议分批确认")
    return {
        "approved_for_preview": True,
        "warnings": sorted(set(warnings)),
        "operation_count": len(change_set.get("operations", [])),
    }


async def _apply_changes(
    db: AsyncSession, ctx: ToolContext, payload: dict[str, Any]
) -> dict[str, Any]:
    change_set = ChangeSet.model_validate(payload["change_set"])
    result = await apply_task_changes(db, ctx.user_id, change_set)
    result["undo_operations"] = [operation.model_dump() for operation in change_set.operations]
    return result


async def _knowledge_search(
    db: AsyncSession, ctx: ToolContext, payload: dict[str, Any]
) -> dict[str, Any]:
    query = str(payload.get("query", "")).strip()
    results = await retrieval_service.search(
        db,
        user_id=ctx.user_id,
        query=query,
        goal_id=str(payload["goal_id"]) if payload.get("goal_id") else None,
        limit=8,
    )
    return {
        "query": query,
        "results": [result.to_dict() for result in results],
    }


def build_registry() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(
        ToolSpec(
            "tasks.preview_mutation",
            "生成创建、编辑、完成或删除任务的结构化变更预览",
            AgentRole.SCHEDULE_OPTIMIZER,
            Effect.PROPOSE,
            Risk.LOW,
            False,
            10,
            1,
            True,
            False,
            _task_mutation_preview,
            RescheduleInput,
            ChangeSet,
        )
    )
    registry.register(
        ToolSpec(
            "context.load",
            "读取用户目标、任务、打卡和近期执行上下文",
            AgentRole.LEARNING_ANALYST,
            Effect.READ,
            Risk.LOW,
            False,
            10,
            2,
            True,
            False,
            _load_context,
            ContextLoadInput,
            ContextLoadOutput,
        )
    )
    registry.register(
        ToolSpec(
            "analytics.execution_summary",
            "分析最近两周执行率、逾期任务与学习债务",
            AgentRole.LEARNING_ANALYST,
            Effect.READ,
            Risk.LOW,
            False,
            10,
            2,
            True,
            False,
            _execution_summary,
            AnalyticsInput,
            AnalyticsOutput,
        )
    )
    registry.register(
        ToolSpec(
            "schedule.preview_reschedule",
            "根据容量和不可用日期生成任务重新排期预览",
            AgentRole.SCHEDULE_OPTIMIZER,
            Effect.PROPOSE,
            Risk.LOW,
            False,
            10,
            2,
            True,
            False,
            _reschedule_preview,
            RescheduleInput,
            ChangeSet,
        )
    )
    registry.register(
        ToolSpec(
            "plan.review",
            "审查变更方案的规模、冲突和风险",
            AgentRole.PLAN_REVIEWER,
            Effect.READ,
            Risk.LOW,
            False,
            10,
            1,
            True,
            False,
            _review_plan,
            ReviewInput,
            ReviewOutput,
        )
    )
    registry.register(
        ToolSpec(
            "tasks.apply_changes",
            "应用获批的任务创建、编辑、完成、删除或日期变更",
            AgentRole.MAIN,
            Effect.WRITE,
            Risk.MEDIUM,
            True,
            15,
            1,
            True,
            True,
            _apply_changes,
            ApplyChangesInput,
            ApplyChangesOutput,
            "tasks.undo_changes",
        )
    )
    registry.register(
        ToolSpec(
            "knowledge.search",
            "搜索用户自己的项目知识库和学习资料",
            AgentRole.KNOWLEDGE_RESEARCHER,
            Effect.READ,
            Risk.LOW,
            False,
            10,
            1,
            True,
            False,
            _knowledge_search,
            KnowledgeSearchInput,
            KnowledgeSearchOutput,
        )
    )
    return registry
