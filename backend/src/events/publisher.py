"""Event Publisher：Learning Event 写入基础设施

职责：
- 将 LearningEvent INSERT 到 DB（不 commit）
- 调用方统一 commit，保证 event 与 domain change 原子落库

原则：
- emit() 绝不调用 db.commit()
- occurred_at 默认 utc_now()（naive UTC，与其他 DateTime 列一致）
- 不记录 AI 推理结果，只记录发生了什么
"""

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.models import LearningEvent


async def emit(
    db: AsyncSession,
    *,
    user_id: str,
    goal_id: str | None,
    aggregate_type: str,
    aggregate_id: str,
    event_type: str,
    payload: dict[str, Any],
    source: str = "user_action",
    occurred_at: datetime | None = None,
    version: int = 1,
    correlation_id: str | None = None,
    causation_id: str | None = None,
    idempotency_key: str | None = None,
) -> LearningEvent:
    """将 LearningEvent 写入 DB（不 commit）

    Args:
        db:             AsyncSession（调用方持有，不在此处 commit）
        user_id:        用户 ID
        goal_id:        目标 ID（可为 None）
        aggregate_type: "goal" | "task" | "plan" | "checkin"
        aggregate_id:   聚合体 ID
        event_type:     事件类型，e.g. "TaskCompleted"
        payload:        事件 payload（self-contained，无需 JOIN）
        source:         "user_action" | "ai_agent" | "system"
        occurred_at:    业务时间（None 则取 utc_now()）
        version:        payload schema 版本（初始为 1）
    """
    if idempotency_key:
        existing = await db.scalar(
            select(LearningEvent).where(LearningEvent.idempotency_key == idempotency_key)
        )
        if existing is not None:
            return existing
    event = LearningEvent(
        user_id=user_id,
        goal_id=goal_id,
        aggregate_type=aggregate_type,
        aggregate_id=aggregate_id,
        event_type=event_type,
        source=source,
        payload=payload,
        occurred_at=occurred_at or utc_now(),
        version=version,
        correlation_id=correlation_id,
        causation_id=causation_id,
        idempotency_key=idempotency_key,
    )
    db.add(event)
    return event


async def emit_plan_generated(
    db: AsyncSession,
    *,
    user_id: str,
    goal_id: str,
    plan_id: str,
    task_count: int,
    total_estimated_mins: int,
    generated_by: str = "ai_agent",
) -> None:
    """Plan 首次生成事件（AI 初次为目标生成任务清单）。

    payload schema v1:
        plan_id               : str   — 计划 ID
        task_count            : int   — 生成任务数
        total_estimated_mins  : int   — 总估时（分钟）
        generated_by          : str   — "ai_agent" | "user"
    """
    await emit(
        db,
        user_id=user_id,
        goal_id=goal_id,
        aggregate_type="plan",
        aggregate_id=plan_id,
        event_type="PlanGenerated",
        source="ai_agent",
        payload={
            "plan_id": plan_id,
            "task_count": task_count,
            "total_estimated_mins": total_estimated_mins,
            "generated_by": generated_by,
        },
    )


async def emit_plan_activated(
    db: AsyncSession,
    *,
    user_id: str,
    goal_id: str,
    plan_id: str,
    activated_by: str = "user_action",
) -> None:
    """Plan 被用户激活/接受事件（用户确认并开始执行计划）。

    payload schema v1:
        plan_id       : str  — 计划 ID
        activated_by  : str  — "user_action" | "ai_agent"
    """
    await emit(
        db,
        user_id=user_id,
        goal_id=goal_id,
        aggregate_type="plan",
        aggregate_id=plan_id,
        event_type="PlanActivated",
        source=activated_by,
        payload={
            "plan_id": plan_id,
            "activated_by": activated_by,
        },
    )
