from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.api.schedule import ScheduleBlock, ScheduleSave, validate_schedule_date
from src.models import Goal, User
from src.services import task_service
from src.services.task_service import TaskCreate, TaskOut, TaskPatch

router = APIRouter(prefix="/api/v1/tasks", tags=["tasks"])


class TaskWithScheduleCreate(TaskCreate):
    blocks: list[ScheduleBlock] = Field(default_factory=list)


@router.get("", response_model=list[TaskOut])
async def list_tasks(
    date: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[TaskOut]:
    return await task_service.list_tasks(current_user.id, date, db, date_from=date_from, date_to=date_to)


@router.post("", response_model=TaskOut, status_code=201)
async def create_task(
    body: TaskCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TaskOut:
    goal = (
        await db.execute(
            select(Goal).where(Goal.id == body.goalId, Goal.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    if not goal:
        raise HTTPException(404, "目标不存在")
    return await task_service.create_task(current_user.id, body, goal, db)


@router.post("/with-schedule", response_model=TaskOut, status_code=201)
async def create_task_with_schedule(
    body: TaskWithScheduleCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TaskOut:
    """Create a task and its selected local-day block in one transaction."""
    validate_schedule_date(body.date, current_user.timezone)
    if len(body.blocks) != 1:
        raise HTTPException(status_code=422, detail="原子创建只允许一个新任务时间块")
    # Validate duplicate/overlapping blocks before any ORM mutation. Existing
    # blocks are checked again in the service transaction when present.
    try:
        schedule_body = ScheduleSave(blocks=body.blocks)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    goal = (
        await db.execute(
            select(Goal).where(Goal.id == body.goalId, Goal.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    if not goal:
        raise HTTPException(404, "目标不存在")
    return await task_service.create_task_with_schedule(
        current_user.id,
        TaskCreate.model_validate(body.model_dump(exclude={"blocks"})),
        goal,
        [block.model_dump() for block in schedule_body.blocks],
        db,
    )


@router.patch("/{task_id}", response_model=TaskOut)
async def update_task(
    task_id: str,
    body: TaskPatch,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TaskOut:
    result = await task_service.update_task(current_user.id, task_id, body, db, current_user.timezone)
    if result is None:
        raise HTTPException(404, "任务不存在")
    return result


@router.delete("/{task_id}", status_code=204)
async def delete_task(
    task_id: str,
    expected_version: int | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    ok = await task_service.delete_task(
        current_user.id, task_id, db, expected_version=expected_version
    )
    if not ok:
        raise HTTPException(404, "任务不存在")
