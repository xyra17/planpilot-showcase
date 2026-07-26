from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator, model_validator
from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import CheckinRecord, Goal, KnowledgeBase, KnowledgeItem, Plan, Task, User

router = APIRouter(prefix="/api/v1/goals", tags=["goals"])


class PendingKb(BaseModel):
    name: str
    description: str = ""


class GoalCreate(BaseModel):
    type: str
    title: str
    deadline: str
    daily_hours: float = 2.0
    current_level: str = "beginner"
    work_schedule: str = "all"  # "weekday" | "weekend" | "all"
    kb_id: str | None = None
    pending_kb: PendingKb | None = None  # 与目标原子创建的新知识库
    meta: dict = {}

    @field_validator("type")
    @classmethod
    def type_valid(cls, v: str) -> str:
        if v not in ("exam", "certification", "skill", "reading", "language", "habit"):
            raise ValueError("type 必须是 exam / certification / skill / reading / language / habit")
        return v

    @field_validator("daily_hours")
    @classmethod
    def hours_valid(cls, v: float) -> float:
        if not (0.5 <= v <= 12):
            raise ValueError("每日学习时间应在 0.5-12 小时之间")
        return v

    @field_validator("deadline")
    @classmethod
    def deadline_valid(cls, v: str) -> str:
        try:
            d = date.fromisoformat(v)
        except ValueError:
            raise ValueError("deadline 格式应为 YYYY-MM-DD")
        if d <= date.today():
            raise ValueError("截止日期必须在今天之后")
        return v


class GoalOut(BaseModel):
    id: str
    type: str
    title: str
    deadline: str
    daily_hours: float
    current_level: str
    status: str
    meta: dict
    created_at: str
    work_schedule: str = "all"
    kb_id: str | None = None

    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def extract_meta_fields(self) -> "GoalOut":
        if self.meta:
            if "work_schedule" in self.meta:
                self.work_schedule = str(self.meta["work_schedule"])
            if "kb_id" in self.meta:
                self.kb_id = str(self.meta["kb_id"]) if self.meta["kb_id"] else None
        return self

    @field_validator("created_at", mode="before")
    @classmethod
    def fmt_dt(cls, v) -> str:
        return str(v) if v else ""


class GoalPatch(BaseModel):
    status: str | None = None
    title: str | None = None
    deadline: str | None = None
    daily_hours: float | None = None
    current_level: str | None = None
    work_schedule: str | None = None
    kb_id: str | None = None


_VALID_STATUSES = {"active", "completed", "paused", "abandoned"}


@router.get("", response_model=list[GoalOut])
async def list_goals(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Goal)
        .where(Goal.user_id == current_user.id)
        .order_by(Goal.created_at.desc())
    )
    return result.scalars().all()


@router.post("", response_model=GoalOut, status_code=201)
async def create_goal(
    body: GoalCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    meta = dict(body.meta)
    meta["work_schedule"] = body.work_schedule

    # 原子创建：pending_kb 与 goal 在同一事务中，任一失败则全部回滚
    kb_id_to_use = body.kb_id
    if body.pending_kb:
        kb = KnowledgeBase(
            user_id=current_user.id,
            name=body.pending_kb.name,
            description=body.pending_kb.description,
        )
        db.add(kb)
        await db.flush()
        kb_id_to_use = kb.id

    if kb_id_to_use:
        meta["kb_id"] = kb_id_to_use

    goal = Goal(
        user_id=current_user.id,
        type=body.type,
        title=body.title,
        deadline=body.deadline,
        daily_hours=body.daily_hours,
        current_level=body.current_level,
        meta=meta,
    )
    db.add(goal)
    await db.commit()
    await db.refresh(goal)
    return goal


@router.get("/{goal_id}", response_model=GoalOut)
async def get_goal(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id)
    )
    goal = result.scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")
    return goal


@router.patch("/{goal_id}", response_model=GoalOut)
async def patch_goal(
    goal_id: str,
    body: GoalPatch,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id)
    )
    goal = result.scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")

    if body.status and body.status not in _VALID_STATUSES:
        raise HTTPException(status_code=422, detail=f"status 必须是 {_VALID_STATUSES}")

    patch_data = body.model_dump(exclude_none=True)
    # work_schedule/kb_id 存入 meta，不直接 setattr
    meta_updates: dict = {}
    if "work_schedule" in patch_data:
        meta_updates["work_schedule"] = patch_data.pop("work_schedule")
    if "kb_id" in patch_data:
        meta_updates["kb_id"] = patch_data.pop("kb_id")

    for field, value in patch_data.items():
        setattr(goal, field, value)

    if meta_updates:
        merged = dict(goal.meta or {})
        merged.update(meta_updates)
        goal.meta = merged

    await db.commit()
    await db.refresh(goal)
    return goal


@router.delete("/{goal_id}", status_code=204)
async def delete_goal(
    goal_id: str,
    delete_kb: bool = False,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    goal = (await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id)
    )).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")

    kb_id: str | None = (goal.meta or {}).get("kb_id")

    # 1. 获取该目标所有 task id，用于清理 knowledge_items.task_id 引用
    task_ids = (await db.execute(
        select(Task.id).where(Task.goal_id == goal_id)
    )).scalars().all()

    # 2. 删除通过 task_id 关联的 KnowledgeItem（避免后续删 Task 时 FK 冲突）
    if task_ids:
        await db.execute(sql_delete(KnowledgeItem).where(KnowledgeItem.task_id.in_(task_ids)))

    # 3. 删除通过 goal_id 关联的 KnowledgeItem
    await db.execute(sql_delete(KnowledgeItem).where(KnowledgeItem.goal_id == goal_id))

    # 4. 如果用户要求同时删除关联知识库
    if delete_kb and kb_id:
        await db.execute(sql_delete(KnowledgeItem).where(KnowledgeItem.kb_id == kb_id))
        kb = (await db.execute(
            select(KnowledgeBase).where(
                KnowledgeBase.id == kb_id,
                KnowledgeBase.user_id == current_user.id,
            )
        )).scalar_one_or_none()
        if kb:
            await db.delete(kb)

    # 5. 按依赖顺序批量删除子表（绕过 ORM 级联顺序问题）
    await db.execute(sql_delete(Task).where(Task.goal_id == goal_id))
    await db.execute(sql_delete(CheckinRecord).where(CheckinRecord.goal_id == goal_id))
    await db.execute(sql_delete(Plan).where(Plan.goal_id == goal_id))

    # 6. 最后删除目标本身
    await db.execute(sql_delete(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id))
    await db.commit()


class ProgressOut(BaseModel):
    goal_id: str
    title: str
    deadline: str
    total_tasks: int
    completed_tasks: int
    avg_completion_rate: float
    streak_days: int
    debt_count: int
    days_ahead_or_behind: int | None = None
    estimated_completion_date: str = ""


@router.get("/{goal_id}/progress", response_model=ProgressOut)
async def goal_progress(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id)
    )
    goal = result.scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")

    all_tasks = (await db.execute(select(Task).where(Task.goal_id == goal_id))).scalars().all()
    total_tasks = len(all_tasks)
    completed_tasks = sum(1 for t in all_tasks if t.status == "completed")

    # 近7日任务完成率（基于任务实际状态，而非打卡自报完成率）
    today = date.today().isoformat()
    seven_days_ago = date.fromordinal(date.today().toordinal() - 7).isoformat()
    seven_days_tasks = [
        t for t in all_tasks
        if t.scheduled_date and t.scheduled_date >= seven_days_ago and t.scheduled_date <= today
    ]
    avg_completion_rate = (
        sum(1 for t in seven_days_tasks if t.status == "completed") / len(seven_days_tasks)
        if seven_days_tasks else 0.0
    )

    # 连续打卡天数：正式打卡 OR 当天有任务完成 均算作一天
    streak_days = 0
    formal_checkin_dates = {c.date for c in (await db.execute(
        select(CheckinRecord).where(
            CheckinRecord.goal_id == goal_id,
            CheckinRecord.mode != "natural",
        )
    )).scalars().all()}
    task_done_dates = {
        t.scheduled_date
        for t in all_tasks
        if t.status == "completed" and t.scheduled_date is not None and t.scheduled_date <= today
    }
    checkin_dates = formal_checkin_dates | task_done_dates
    # 今天已打卡从今天起算，否则从昨天起算（避免每天早上streak清零）
    check_date = date.today()
    if check_date.isoformat() not in checkin_dates:
        check_date = date.fromordinal(check_date.toordinal() - 1)
    while check_date.isoformat() in checkin_dates:
        streak_days += 1
        check_date = date.fromordinal(check_date.toordinal() - 1)

    today_dt = date.today()
    created_date = goal.created_at.date()
    deadline_date = date.fromisoformat(goal.deadline)
    total_project_days = max(1, (deadline_date - created_date).days)
    elapsed_days = max(1, (today_dt - created_date).days)

    days_ahead_or_behind = None
    estimated_completion_date = goal.deadline

    # 需要至少完成10%任务或3个任务才显示趋势，避免早期数据噪音
    min_tasks_for_trend = max(3, int(total_tasks * 0.1))
    if total_tasks > 0 and completed_tasks >= min_tasks_for_trend:
        expected_ratio = min(elapsed_days / total_project_days, 1.0)
        actual_ratio = completed_tasks / total_tasks
        days_ahead_or_behind = round((actual_ratio - expected_ratio) * total_project_days)
        remaining_tasks = total_tasks - completed_tasks
        daily_rate = completed_tasks / elapsed_days
        extra_days = int(remaining_tasks / daily_rate) if daily_rate > 0 else total_project_days
        estimated_end = today_dt + timedelta(days=extra_days)
        estimated_completion_date = estimated_end.isoformat()

    return ProgressOut(
        goal_id=goal.id,
        title=goal.title,
        deadline=goal.deadline,
        total_tasks=total_tasks,
        completed_tasks=completed_tasks,
        avg_completion_rate=avg_completion_rate,
        streak_days=streak_days,
        debt_count=sum(
            1 for t in all_tasks
            if t.status != "completed"
            and t.scheduled_date is not None
            and t.scheduled_date < date.today().isoformat()
        ),
        days_ahead_or_behind=days_ahead_or_behind,
        estimated_completion_date=estimated_completion_date,
    )


class TaskBriefOut(BaseModel):
    id: str
    title: str
    date: str
    status: str


@router.get("/{goal_id}/tasks", response_model=list[TaskBriefOut])
async def list_goal_tasks(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[TaskBriefOut]:
    goal = (await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id)
    )).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")
    tasks = (await db.execute(
        select(Task).where(Task.goal_id == goal_id)
        .order_by(Task.scheduled_date, Task.created_at)
    )).scalars().all()
    return [
        TaskBriefOut(id=t.id, title=t.title, date=t.scheduled_date, status=t.status)
        for t in tasks
    ]


@router.get("/{goal_id}/plan")
async def get_goal_plan(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    goal = (await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id)
    )).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")

    plan = (await db.execute(
        select(Plan)
        .where(Plan.goal_id == goal_id, Plan.is_current.is_(True))
        .order_by(Plan.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()

    if not plan:
        return {"plan": None}

    baseline = plan.baseline or {}
    phases = baseline.get("phases") or []

    # 当前 plan 下的任务（用于阶段明细展示）
    plan_tasks = (await db.execute(
        select(Task).where(Task.goal_id == goal_id, Task.plan_id == plan.id)
    )).scalars().all()

    # 目标下全部任务（用于计算整体进度）
    all_goal_tasks = (await db.execute(
        select(Task).where(Task.goal_id == goal_id)
    )).scalars().all()

    tasks_by_phase: list[dict] = []
    task_idx = 0
    for phase in phases:
        phase_task_count = len(phase.get("tasks") or [])
        phase_tasks = plan_tasks[task_idx:task_idx + phase_task_count]
        phase_dates = [t.scheduled_date for t in phase_tasks if t.scheduled_date]
        done = sum(1 for t in phase_tasks if t.status == "completed")
        tasks_by_phase.append({
            "name": phase.get("name", ""),
            "focus": phase.get("focus", ""),
            "days": phase.get("days", phase.get("weeks", 0)),
            "start_date": min(phase_dates) if phase_dates else "",
            "end_date": max(phase_dates) if phase_dates else "",
            "total": phase_task_count,
            "done": done,
            "tasks": [
                {
                    "id": t.id,
                    "title": t.title,
                    "estimated_mins": t.estimated_mins,
                    "status": t.status,
                    "mastery_level": t.mastery_level,
                    "scheduled_date": t.scheduled_date,
                }
                for t in phase_tasks
            ],
        })
        task_idx += phase_task_count

    return {
        "plan": {
            "id": plan.id,
            "version": plan.version,
            "created_at": plan.created_at.isoformat() if plan.created_at else "",
            "phases": tasks_by_phase,
            "total_tasks": len(all_goal_tasks),
            "completed_tasks": sum(1 for t in all_goal_tasks if t.status == "completed"),
        }
    }
