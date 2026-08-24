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
    InsightPreviewInput,
    KnowledgeSearchInput,
    KnowledgeSearchOutput,
    RescheduleInput,
    ReviewInput,
    ReviewOutput,
    Risk,
    ToolContext,
)
from src.core.time import local_date_for_timezone
from src.models import Task, User
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
            raise ValueError("受控能力模块不得注册写工具")
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
    # Rehydrate the exact task entity from the database immediately before a
    # destructive snapshot.  Planner/context projections may omit nullable
    # fields (for example actual_mins); deletion compensation must never rely
    # on that lossy projection.
    action_intent = payload.get("action_intent") or {}
    context = dict(payload["context"])
    context["tasks"] = [dict(task) for task in context.get("tasks", [])]
    for task in context["tasks"]:
        if task.get("id") is None:
            continue
        row = await db.get(Task, task["id"])
        if row is not None:
            task.update(
                {
                    "plan_id": row.plan_id,
                    "actual_mins": row.actual_mins,
                    "type": row.type,
                    "kb_refs": list(row.kb_refs or []),
                    "stage_label": row.stage_label,
                    "sequence_in_plan": row.sequence_in_plan,
                    "completed_at": row.completed_at.isoformat() if row.completed_at else None,
                    "version": row.version,
                }
            )
    return build_task_mutation_preview(
        context,
        request=str(payload["request"]),
        goal_id=payload.get("goal_id"),
        excluded_weekdays=payload.get("excluded_weekdays", []),
        today=today,
        action_intent=action_intent,
    ).model_dump()


async def _insight_preview(
    db: AsyncSession, ctx: ToolContext, payload: dict[str, Any]
) -> dict[str, Any]:
    from src.services.proposal_service import build_insight_change_set

    return (
        await build_insight_change_set(ctx.user_id, str(payload["proposal_id"]), db)
    ).model_dump(mode="json")


async def _review_plan(
    _db: AsyncSession, _ctx: ToolContext, payload: dict[str, Any]
) -> dict[str, Any]:
    change_set = payload["change_set"]
    context = payload.get("context") or {}
    goals = {str(item["id"]): item for item in context.get("goals", [])}
    tasks = {str(item["id"]): dict(item) for item in context.get("tasks", [])}
    baseline_goal_load: dict[tuple[str, str], int] = {}
    baseline_deadline_violations: set[tuple[str, str]] = set()
    for task in tasks.values():
        if task.get("status") in {"completed", "skipped", "abandoned"}:
            continue
        baseline_goal_id = str(task.get("goal_id", ""))
        baseline_date = str(task.get("date") or task.get("scheduled_date") or "")
        if not baseline_goal_id or not baseline_date:
            continue
        baseline_key = (baseline_goal_id, baseline_date)
        baseline_goal_load[baseline_key] = baseline_goal_load.get(baseline_key, 0) + int(
            task.get("estimated_minutes") or task.get("estimated_mins") or 0
        )
        baseline_goal = goals.get(baseline_goal_id) or {}
        if baseline_goal.get("deadline") and baseline_date > str(baseline_goal["deadline"]):
            baseline_deadline_violations.add(baseline_key)
    findings: list[dict[str, Any]] = []
    for warning in change_set.get("warnings", []):
        findings.append(
            {
                "code": "legacy_preview_warning",
                "severity": "medium",
                "blocking": False,
                "entity_refs": [],
                "message": str(warning),
                "recommended_policy": "require_approval",
            }
        )
    operations = change_set.get("operations", [])
    delete_count = sum(item.get("field") == "__delete__" for item in operations)
    if delete_count:
        findings.append(
            {
                "code": "destructive_delete",
                "severity": "high",
                "blocking": False,
                "entity_refs": [
                    {
                        "entity": str(item.get("entity", "task")),
                        "entity_id": str(item.get("entity_id", "")),
                        "label": str(item.get("label", "")) or None,
                    }
                    for item in operations
                    if item.get("field") == "__delete__"
                ],
                "message": "方案包含删除操作；撤销依赖所属目标仍存在",
                "recommended_policy": "require_high_risk_confirmation",
            }
        )
    if delete_count > 3:
        findings.append(
            {
                "code": "bulk_destructive_change",
                "severity": "high",
                "blocking": False,
                "entity_refs": [],
                "message": f"方案将删除 {delete_count} 项任务，属于批量高影响变更",
                "recommended_policy": "require_high_risk_confirmation",
            }
        )
    if len(operations) > 10:
        findings.append(
            {
                "code": "bulk_change",
                "severity": "medium",
                "blocking": False,
                "entity_refs": [],
                "message": "一次调整超过 10 项，建议分批确认",
                "recommended_policy": "require_approval",
            }
        )

    for operation in operations:
        if operation.get("entity") == "goal":
            goal_id = str(operation.get("entity_id", ""))
            if operation.get("field") == "__create__" and isinstance(operation.get("after"), dict):
                goals[goal_id] = dict(operation["after"])
            elif goal_id in goals and operation.get("field") == "daily_hours":
                goals[goal_id]["daily_hours"] = operation.get("after")
            continue
        task_id = str(operation.get("entity_id", ""))
        field = operation.get("field")
        if field == "__create__" and isinstance(operation.get("after"), dict):
            tasks[task_id] = dict(operation["after"])
            tasks[task_id]["date"] = tasks[task_id].get("scheduled_date")
            tasks[task_id]["estimated_minutes"] = tasks[task_id].get("estimated_mins", 30)
        elif field == "__delete__":
            tasks.pop(task_id, None)
        elif task_id in tasks:
            if field == "scheduled_date":
                tasks[task_id]["date"] = operation.get("after")
            elif field == "status":
                tasks[task_id]["status"] = operation.get("after")
            elif field == "estimated_mins":
                tasks[task_id]["estimated_minutes"] = operation.get("after")

    daily_goal_load: dict[tuple[str, str], int] = {}
    goals_by_day: dict[str, set[str]] = {}
    for task in tasks.values():
        if task.get("status") in {"completed", "skipped", "abandoned"}:
            continue
        goal_id = str(task.get("goal_id", ""))
        task_date = str(task.get("date") or task.get("scheduled_date") or "")
        if not goal_id or not task_date:
            continue
        key = (goal_id, task_date)
        daily_goal_load[key] = daily_goal_load.get(key, 0) + int(
            task.get("estimated_minutes") or task.get("estimated_mins") or 0
        )
        goals_by_day.setdefault(task_date, set()).add(goal_id)

    for (goal_id, task_date), minutes in sorted(daily_goal_load.items()):
        goal = goals.get(goal_id)
        if not goal:
            continue
        capacity = round(float(goal.get("daily_hours") or 0) * 60)
        baseline_minutes = baseline_goal_load.get((goal_id, task_date), 0)
        if capacity > 0 and minutes > capacity and minutes > baseline_minutes:
            overload_ratio = minutes / capacity
            findings.append(
                {
                    "code": "daily_capacity_exceeded",
                    "severity": "high" if overload_ratio >= 1.5 else "medium",
                    "blocking": False,
                    "entity_refs": [
                        {
                            "entity": "goal",
                            "entity_id": goal_id,
                            "label": str(goal.get("title", "目标")),
                        }
                    ],
                    "message": f"{task_date} 的“{goal.get('title', '目标')}”计划量 {minutes} 分钟，超过每日容量 {capacity} 分钟",
                    "recommended_policy": (
                        "require_high_risk_confirmation"
                        if overload_ratio >= 1.5
                        else "require_approval"
                    ),
                }
            )
        deadline = str(goal.get("deadline") or "")
        if (
            deadline
            and task_date > deadline
            and (goal_id, task_date) not in baseline_deadline_violations
        ):
            findings.append(
                {
                    "code": "deadline_exceeded",
                    "severity": "critical",
                    "blocking": True,
                    "entity_refs": [
                        {
                            "entity": "goal",
                            "entity_id": goal_id,
                            "label": str(goal.get("title", "目标")),
                        }
                    ],
                    "message": f"“{goal.get('title', '目标')}”有任务安排在截止日期 {deadline} 之后",
                    "recommended_policy": "deny",
                }
            )

    changed_dates = {
        str(item.get("after"))
        for item in operations
        if item.get("field") == "scheduled_date" and item.get("after")
    } | {
        str(item.get("after", {}).get("scheduled_date"))
        for item in operations
        if item.get("field") == "__create__" and isinstance(item.get("after"), dict)
    }
    for task_date in sorted(changed_dates):
        goal_count = len(goals_by_day.get(task_date, set()))
        if goal_count >= 3:
            findings.append(
                {
                    "code": "cross_goal_collision",
                    "severity": "medium",
                    "blocking": False,
                    "entity_refs": [
                        {"entity": "goal", "entity_id": goal_id, "label": None}
                        for goal_id in sorted(goals_by_day.get(task_date, set()))
                    ],
                    "message": f"{task_date} 同时承载 {goal_count} 个学习目标，需检查跨目标冲突",
                    "recommended_policy": "require_approval",
                }
            )
    severity_order = {"low": 1, "medium": 2, "high": 3, "critical": 4}
    highest = max(
        (str(item["severity"]) for item in findings),
        key=lambda item: severity_order[item],
        default="none",
    )
    blocking_alternatives: list[dict[str, str]] = []
    if any(item["code"] == "deadline_exceeded" and item["blocking"] for item in findings):
        blocking_alternatives = [
            {
                "id": "preview_goal_deadline_extension",
                "label": "先延长目标期限",
                "description": "另行提出新的目标截止日期，经独立预览和确认后再重排任务。",
            },
            {
                "id": "analyze_deadline_risk_only",
                "label": "只分析期限风险",
                "description": "不生成任务变更，仅说明当前期限、积压量和延期影响。",
            },
            {
                "id": "rebuild_within_deadline",
                "label": "在原期限内重建计划",
                "description": "保留当前截止日期，减少或拆分任务后重新生成可执行方案。",
            },
        ]
    return {
        "approved_for_preview": not any(item["blocking"] for item in findings),
        "findings": findings,
        "warnings": sorted({str(item["message"]) for item in findings}),
        "operation_count": len(operations),
        "highest_severity": highest,
        "blocking_alternatives": blocking_alternatives,
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
            "insights.preview_action",
            "把学习洞察转换成结构化业务变更预览，不直接写入数据",
            AgentRole.SCHEDULE_OPTIMIZER,
            Effect.PROPOSE,
            Risk.LOW,
            False,
            10,
            1,
            True,
            False,
            _insight_preview,
            InsightPreviewInput,
            ChangeSet,
        )
    )
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
