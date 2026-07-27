import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import DailyBriefCache, Goal, Task, User

router = APIRouter(prefix="/api/v1/tasks", tags=["tasks"])


class TaskOut(BaseModel):
    id: str
    title: str
    description: str | None = None
    goalId: str
    goalTitle: str
    done: bool
    estimatedMinutes: int
    date: str
    priority: str
    masteryLevel: str


class TaskCreate(BaseModel):
    title: str
    description: str | None = None
    goalId: str
    done: bool = False
    estimatedMinutes: int = 30
    date: str
    priority: str = "medium"


class TaskPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    done: bool | None = None
    estimatedMinutes: int | None = None
    priority: str | None = None
    mastery_level: str | None = None
    date: str | None = None


def _out(task: Task, goal_title: str) -> TaskOut:
    return TaskOut(
        id=task.id,
        title=task.title,
        description=task.description,
        goalId=task.goal_id,
        goalTitle=goal_title,
        done=task.status == "completed",
        estimatedMinutes=task.estimated_mins,
        date=task.scheduled_date,
        priority=task.priority,
        masteryLevel=task.mastery_level,
    )


@router.get("", response_model=list[TaskOut])
async def list_tasks(
    date: str | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[TaskOut]:
    stmt = (
        select(Task, Goal.title)
        .join(Goal, Task.goal_id == Goal.id)
        .where(Goal.user_id == current_user.id)
    )
    if date:
        stmt = stmt.where(Task.scheduled_date == date)
    stmt = stmt.order_by(Task.scheduled_date.desc(), Task.created_at.asc())
    rows = (await db.execute(stmt)).all()
    return [_out(task, gtitle) for task, gtitle in rows]


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
    task = Task(
        id=str(uuid.uuid4()),
        goal_id=body.goalId,
        title=body.title,
        description=body.description,
        estimated_mins=body.estimatedMinutes,
        status="completed" if body.done else "pending",
        scheduled_date=body.date,
        priority=body.priority,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return _out(task, goal.title)


@router.patch("/{task_id}", response_model=TaskOut)
async def update_task(
    task_id: str,
    body: TaskPatch,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TaskOut:
    row = (
        await db.execute(
            select(Task, Goal)
            .join(Goal, Task.goal_id == Goal.id)
            .where(Task.id == task_id, Goal.user_id == current_user.id)
        )
    ).first()
    if not row:
        raise HTTPException(404, "任务不存在")
    task, goal = row
    if body.title is not None:
        task.title = body.title
    if body.description is not None:
        task.description = body.description
    if body.done is not None:
        task.status = "completed" if body.done else "pending"
        task.completed_at = datetime.now(timezone.utc).replace(tzinfo=None) if body.done else None
    if body.estimatedMinutes is not None:
        task.estimated_mins = body.estimatedMinutes
    if body.priority is not None:
        task.priority = body.priority
    if body.mastery_level is not None:
        task.mastery_level = body.mastery_level
    if body.date is not None:
        task.scheduled_date = body.date
    await db.commit()
    await db.refresh(task)
    # 任务状态变更时清除当天简报缓存，下次访问重新生成
    if body.done is not None:
        from datetime import date as date_type
        await db.execute(
            delete(DailyBriefCache).where(
                DailyBriefCache.user_id == current_user.id,
                DailyBriefCache.date == date_type.today().isoformat(),
            )
        )
        await db.commit()
    return _out(task, goal.title)


@router.delete("/{task_id}", status_code=204)
async def delete_task(
    task_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    row = (
        await db.execute(
            select(Task)
            .join(Goal, Task.goal_id == Goal.id)
            .where(Task.id == task_id, Goal.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "任务不存在")
    await db.delete(row)
    await db.commit()
