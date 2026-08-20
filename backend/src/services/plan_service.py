"""PlanService: 计划/今日任务业务逻辑层

职责边界：
- 今日任务查询（带 pending fallback）

不含：
- 路由参数解析
- 权限校验（由 router 负责）
- HTTP 异常处理（由 router 负责）
"""

from datetime import date

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import Goal, Task

# ── API Schemas ────────────────────────────────────────────────────────────


class TodayTaskOut(BaseModel):
    id: str
    title: str
    estimated_mins: int
    status: str
    type: str
    kb_refs: list[str]
    mastery_level: str

    model_config = {"from_attributes": True}


# ── Public Service Methods ─────────────────────────────────────────────────


async def get_today_tasks(
    user_id: str,
    goal_id: str,
    db: AsyncSession,
) -> list | None:
    """查询目标今日任务（含 pending fallback）

    Args:
        user_id: 用户 ID
        goal_id: 目标 ID
        db: 数据库会话

    Returns:
        今日任务列表（可能为空列表），或 None（目标不存在/无权限）

    逻辑：
        1. 今日有排期任务 → 返回今日任务
        2. 今日无排期 → fallback 到最近的 pending 任务（最多5个）
    """
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
    ).scalar_one_or_none()
    if not goal:
        return None

    today = date.today().isoformat()
    tasks = (
        (
            await db.execute(
                select(Task)
                .where(Task.goal_id == goal_id, Task.scheduled_date == today)
                .order_by(Task.created_at)
            )
        )
        .scalars()
        .all()
    )

    # 今日无排期则取最近的 pending 任务（最多5个）
    if not tasks:
        tasks = (
            (
                await db.execute(
                    select(Task)
                    .where(Task.goal_id == goal_id, Task.status == "pending")
                    .order_by(Task.scheduled_date, Task.created_at)
                    .limit(5)
                )
            )
            .scalars()
            .all()
        )

    return list(tasks)
