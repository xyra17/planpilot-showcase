from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import User
from src.services import plan_service
from src.services.plan_service import TodayTaskOut

router = APIRouter(prefix="/api/v1/plans", tags=["plans"])


@router.get("/{goal_id}/today", response_model=list[TodayTaskOut])
async def today_tasks(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await plan_service.get_today_tasks(current_user.id, goal_id, db)
    if result is None:
        raise HTTPException(status_code=404, detail="目标不存在")
    return result
