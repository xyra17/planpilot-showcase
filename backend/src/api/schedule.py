from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import local_date_for_timezone
from src.database import get_db
from src.deps import get_current_user
from src.models import DailySchedule, User

router = APIRouter(prefix="/api/v1/schedule", tags=["schedule"])


class ScheduleBlock(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=500)
    taskId: str | None = None
    goalTitle: str | None = None
    startHour: float = Field(ge=0, lt=24, allow_inf_nan=False)
    durationMinutes: float = Field(gt=0, le=1440, allow_inf_nan=False)
    color: str = Field(min_length=1, max_length=64)
    progress: float = Field(default=0.0, ge=0, le=1, allow_inf_nan=False)

    @model_validator(mode="after")
    def reject_cross_midnight(self) -> "ScheduleBlock":
        if self.startHour * 60 + self.durationMinutes > 24 * 60:
            raise ValueError("日程块不能跨越午夜")
        return self


class ScheduleOut(BaseModel):
    date: str
    blocks: list[ScheduleBlock]


class ScheduleSave(BaseModel):
    blocks: list[ScheduleBlock]

    @model_validator(mode="after")
    def reject_duplicates_and_overlaps(self) -> "ScheduleSave":
        ids = [block.id for block in self.blocks]
        if len(ids) != len(set(ids)):
            raise ValueError("日程块 id 不能重复")
        ordered = sorted(self.blocks, key=lambda block: block.startHour * 60)
        for previous, current in zip(ordered, ordered[1:]):
            previous_end = previous.startHour * 60 + previous.durationMinutes
            if current.startHour * 60 < previous_end:
                raise ValueError("日程块不能重叠")
        return self


def validate_schedule_date(value: str, timezone_name: str) -> str:
    """Validate a user-local schedule date without silently normalising it.

    Schedule dates are calendar dates in the account's IANA timezone.  We keep
    the timezone argument here so callers cannot accidentally validate a UTC
    date as if it were a server-local date; future dates are intentionally
    allowed for planning.
    """
    del timezone_name  # the value is a local calendar date, not a UTC instant
    try:
        parsed = date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="日程日期必须是 YYYY-MM-DD") from exc
    if parsed.isoformat() != value:
        raise HTTPException(status_code=422, detail="日程日期必须是 YYYY-MM-DD")
    return value


async def get_schedule_for_date(
    schedule_date: str,
    current_user: User,
    db: AsyncSession,
) -> ScheduleOut:
    schedule_date = validate_schedule_date(schedule_date, current_user.timezone)
    row = (
        await db.execute(
            select(DailySchedule).where(
                DailySchedule.user_id == current_user.id,
                DailySchedule.date == schedule_date,
            )
        )
    ).scalar_one_or_none()
    return ScheduleOut(date=schedule_date, blocks=row.blocks if row else [])


async def save_schedule_for_date(
    schedule_date: str,
    body: ScheduleSave,
    current_user: User,
    db: AsyncSession,
    *,
    commit: bool = True,
) -> ScheduleOut:
    schedule_date = validate_schedule_date(schedule_date, current_user.timezone)
    row = (
        await db.execute(
            select(DailySchedule).where(
                DailySchedule.user_id == current_user.id,
                DailySchedule.date == schedule_date,
            )
        )
    ).scalar_one_or_none()
    if row:
        row.blocks = [block.model_dump() for block in body.blocks]
    else:
        db.add(
            DailySchedule(
                user_id=current_user.id,
                date=schedule_date,
                blocks=[block.model_dump() for block in body.blocks],
            )
        )
    if commit:
        await db.commit()
    return ScheduleOut(date=schedule_date, blocks=body.blocks)


@router.get("/today", response_model=ScheduleOut)
async def get_today_schedule(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ScheduleOut:
    today = local_date_for_timezone(current_user.timezone).isoformat()
    return await get_schedule_for_date(today, current_user, db)


@router.put("/today", response_model=ScheduleOut)
async def upsert_today_schedule(
    body: ScheduleSave,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ScheduleOut:
    today = local_date_for_timezone(current_user.timezone).isoformat()
    return await save_schedule_for_date(today, body, current_user, db)


@router.get("/{schedule_date}", response_model=ScheduleOut)
async def get_schedule(
    schedule_date: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ScheduleOut:
    return await get_schedule_for_date(schedule_date, current_user, db)


@router.put("/{schedule_date}", response_model=ScheduleOut)
async def upsert_schedule(
    schedule_date: str,
    body: ScheduleSave,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ScheduleOut:
    return await save_schedule_for_date(schedule_date, body, current_user, db)
