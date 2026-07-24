from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import Goal, Task, User

router = APIRouter(prefix="/api/v1/plans", tags=["plans"])


class TodayTaskOut(BaseModel):
    id: str
    title: str
    estimated_mins: int
    status: str
    type: str
    kb_refs: list[str]
    mastery_level: str

    model_config = {"from_attributes": True}


@router.get("/{goal_id}/today", response_model=list[TodayTaskOut])
async def today_tasks(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    goal = (await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id)
    )).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")

    today = date.today().isoformat()
    tasks = (await db.execute(
        select(Task)
        .where(Task.goal_id == goal_id, Task.scheduled_date == today)
        .order_by(Task.created_at)
    )).scalars().all()

    # 今日无排期则取最近的 pending 任务（最多5个）
    if not tasks:
        tasks = (await db.execute(
            select(Task)
            .where(Task.goal_id == goal_id, Task.status == "pending")
            .order_by(Task.scheduled_date, Task.created_at)
            .limit(5)
        )).scalars().all()

    return tasks
