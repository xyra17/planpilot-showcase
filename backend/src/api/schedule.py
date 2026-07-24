from datetime import date

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import DailySchedule, User

router = APIRouter(prefix="/api/v1/schedule", tags=["schedule"])


class ScheduleBlock(BaseModel):
    id: str
    label: str
    taskId: str | None = None
    goalTitle: str | None = None
    startHour: float
    durationMinutes: float
    color: str
    progress: float = 0.0


class ScheduleOut(BaseModel):
    date: str
    blocks: list[ScheduleBlock]


class ScheduleSave(BaseModel):
    blocks: list[ScheduleBlock]


@router.get("/today", response_model=ScheduleOut)
async def get_today_schedule(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ScheduleOut:
    today = date.today().isoformat()
    row = (await db.execute(
        select(DailySchedule).where(
            DailySchedule.user_id == current_user.id,
            DailySchedule.date == today,
        )
    )).scalar_one_or_none()
    return ScheduleOut(date=today, blocks=row.blocks if row else [])


@router.put("/today", response_model=ScheduleOut)
async def upsert_today_schedule(
    body: ScheduleSave,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ScheduleOut:
    today = date.today().isoformat()
    row = (await db.execute(
        select(DailySchedule).where(
            DailySchedule.user_id == current_user.id,
            DailySchedule.date == today,
        )
    )).scalar_one_or_none()
    if row:
        row.blocks = [b.model_dump() for b in body.blocks]
    else:
        db.add(DailySchedule(
            user_id=current_user.id,
            date=today,
            blocks=[b.model_dump() for b in body.blocks],
        ))
    await db.commit()
    return ScheduleOut(date=today, blocks=body.blocks)
