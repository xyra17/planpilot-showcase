"""Checkin router

职责：
- 参数解析（FastAPI 自动完成）
- 权限校验（goal 归属 current_user）
- 调用 CheckinService
- 返回 Response

禁止：
- Task ORM 修改
- LearningDebt ORM 修改
- CheckinRecord ORM 修改
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import Goal, User
from src.services import checkin_service
from src.services.checkin_service import (
    CheckinBody,
    CheckinResult,
)

router = APIRouter(prefix="/api/v1/checkin", tags=["checkin"])


@router.get("/{goal_id}/today", response_model=CheckinResult | None)
async def get_today_checkin(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await checkin_service.get_today(goal_id, current_user.id, db, current_user.timezone)


@router.post("/{goal_id}", response_model=CheckinResult)
async def checkin(
    goal_id: str,
    body: CheckinBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id))
    ).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")

    return await checkin_service.submit(goal, current_user.id, body, db, current_user.timezone)
