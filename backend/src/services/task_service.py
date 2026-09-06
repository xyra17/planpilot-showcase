"""TaskService: 任务业务逻辑层

职责边界：
- Task CRUD（DB write，single commit）
- Task 状态机（status + completed_at）
- DailyBriefCache 失效（仅当 done 变更时）
- DTO 映射（Task ORM → TaskOut）

不含：
- 路由参数解析
- 权限校验（goal 归属由 router 负责）
- HTTP 异常处理（由 router 负责）
"""

import uuid
from datetime import datetime
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import local_date_for_timezone, to_user_timezone, utc_now, utc_now_aware
from src.domain.errors import DomainVersionConflict
from src.events.publisher import emit
from src.models import DailyBriefCache, DailySchedule, Goal, Task, TaskMasteryRecord
from src.services.learning_lifecycle_service import (
    emit_deviation_detected,
    emit_recovery_completed_if_applicable,
    emit_recovery_selected,
    emit_task_started_if_missing,
)

# ── API Schemas ────────────────────────────────────────────────────────────


class TaskOut(BaseModel):
    id: str
    title: str
    description: str | None = None
    goalId: str
    goalTitle: str
    done: bool
    status: str
    estimatedMinutes: int
    actualMinutes: int | None = None
    date: str
    priority: str
    masteryLevel: str
    executionGuide: dict = Field(default_factory=dict)
    version: int


class TaskCreate(BaseModel):
    title: str
    description: str | None = None
    goalId: str
    done: bool = False
    estimatedMinutes: int = 30
    date: str
    priority: str = "medium"
    executionGuide: dict = Field(default_factory=dict)


class TaskPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    done: bool | None = None
    estimatedMinutes: int | None = None
    actual_mins: int | None = Field(default=None, ge=0)
    priority: str | None = None
    mastery_level: str | None = None
    date: str | None = None
    rescheduleTrigger: Literal["user_manual", "overload_recovery", "deviation_recovery"] | None = (
        None
    )
    recoveryStrategy: Literal["minimum", "standard", "sprint"] | None = None
    expectedVersion: int | None = None
    executionGuide: dict | None = None


# ── Internal Domain Helpers ────────────────────────────────────────────────


def _to_out(task: Task, goal_title: str) -> TaskOut:
    """Task ORM → TaskOut DTO"""
    return TaskOut(
        id=task.id,
        title=task.title,
        description=task.description,
        goalId=task.goal_id,
        goalTitle=goal_title,
        done=task.status == "completed",
        status=task.status,
        estimatedMinutes=task.estimated_mins,
        actualMinutes=task.actual_mins,
        date=task.scheduled_date,
        priority=task.priority,
        masteryLevel=task.mastery_level,
        executionGuide=dict(task.execution_guide or {}),
        version=task.version,
    )


def _apply_completion_status(task: Task, done: bool) -> None:
    """Task 状态机：done flag → status + completed_at

    Args:
        task: Task ORM 对象（直接修改）
        done: 是否完成
    """
    task.status = "completed" if done else "pending"
    task.completed_at = utc_now() if done else None


def _new_task(body: TaskCreate) -> Task:
    return Task(
        id=str(uuid.uuid4()),
        goal_id=body.goalId,
        title=body.title,
        description=body.description,
        estimated_mins=body.estimatedMinutes,
        status="completed" if body.done else "pending",
        completed_at=utc_now() if body.done else None,
        scheduled_date=body.date,
        priority=body.priority,
        execution_guide=dict(body.executionGuide or {}),
    )


async def _emit_task_created(user_id: str, body: TaskCreate, task: Task, db: AsyncSession) -> None:
    await emit(
        db,
        user_id=user_id,
        goal_id=body.goalId,
        aggregate_type="task",
        aggregate_id=task.id,
        event_type="TaskCreated",
        payload={
            "title": body.title,
            "scheduled_date": body.date,
            "estimated_mins": body.estimatedMinutes,
            "priority": body.priority,
            "plan_id": None,
            "stage_label": None,
            "aggregate_version": 1,
        },
    )


def _apply_patch_fields(task: Task, body: TaskPatch) -> set[str]:
    """将 patch body 中非 None 的字段写入 task ORM 对象（不 commit）

    Returns:
        changed_fields: 发生变更的字段名集合（用于决策 side-effects）
    """
    changed: set[str] = set()

    if body.title is not None and body.title != task.title:
        task.title = body.title
        changed.add("title")
    if body.description is not None and body.description != task.description:
        task.description = body.description
        changed.add("description")
    if body.done is not None and body.done != (task.status == "completed"):
        _apply_completion_status(task, body.done)
        changed.add("done")
    if body.estimatedMinutes is not None and body.estimatedMinutes != task.estimated_mins:
        task.estimated_mins = body.estimatedMinutes
        changed.add("estimatedMinutes")
    if body.actual_mins is not None and body.actual_mins != task.actual_mins:
        task.actual_mins = body.actual_mins
        changed.add("actual_mins")
    if body.priority is not None and body.priority != task.priority:
        task.priority = body.priority
        changed.add("priority")
    if body.mastery_level is not None and body.mastery_level != task.mastery_level:
        task.mastery_level = body.mastery_level
        changed.add("mastery_level")
        # TODO Phase 2C: append TaskMasteryRecord when mastery_level changes
    if body.date is not None and body.date != task.scheduled_date:
        task.scheduled_date = body.date
        changed.add("date")
    if body.executionGuide is not None and body.executionGuide != (task.execution_guide or {}):
        task.execution_guide = dict(body.executionGuide)
        changed.add("executionGuide")

    return changed


async def _invalidate_daily_brief(user_id: str, db: AsyncSession, timezone_name: str) -> None:
    """清除当天 DailyBriefCache（不 commit）

    当任务 done 状态变更时调用，保证下次访问重新生成简报。
    """
    await db.execute(
        delete(DailyBriefCache).where(
            DailyBriefCache.user_id == user_id,
            DailyBriefCache.date == local_date_for_timezone(timezone_name).isoformat(),
        )
    )


# ── Public Service Methods ─────────────────────────────────────────────────


async def list_tasks(
    user_id: str,
    filter_date: str | None,
    db: AsyncSession,
    *,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[TaskOut]:
    """查询当前用户的任务列表

    Args:
        user_id: 用户 ID
        filter_date: 按日期过滤（YYYY-MM-DD），None 表示不过滤
        db: 数据库会话

    Returns:
        按 scheduled_date desc, created_at asc 排序的任务列表
    """
    stmt = (
        select(Task, Goal.title)
        .join(Goal, Task.goal_id == Goal.id)
        .where(Goal.user_id == user_id, Task.status != "abandoned")
    )
    if filter_date:
        stmt = stmt.where(Task.scheduled_date == filter_date)
    if date_from:
        stmt = stmt.where(Task.scheduled_date >= date_from)
    if date_to:
        stmt = stmt.where(Task.scheduled_date <= date_to)
    stmt = stmt.order_by(Task.scheduled_date.desc(), Task.created_at.asc())
    rows = (await db.execute(stmt)).all()
    return [_to_out(task, gtitle) for task, gtitle in rows]


async def create_task(
    user_id: str,
    body: TaskCreate,
    goal: Goal,
    db: AsyncSession,
) -> TaskOut:
    """创建任务

    Args:
        user_id: 用户 ID（仅用于日志/audit，权限已由 router 校验）
        body: 任务创建请求体
        goal: 已校验归属的 Goal 对象（由 router 传入）
        db: 数据库会话

    Returns:
        新创建的 TaskOut
    """
    task = _new_task(body)
    db.add(task)
    await _emit_task_created(user_id, body, task, db)
    await db.commit()
    await db.refresh(task)
    return _to_out(task, goal.title)


async def create_task_with_schedule(
    user_id: str,
    body: TaskCreate,
    goal: Goal,
    schedule_blocks: list[dict],
    db: AsyncSession,
) -> TaskOut:
    """Atomically create a task and persist its local-day schedule blocks.

    The caller validates the date and block schema.  Keeping both writes in
    this session means a failed schedule write rolls back the task as well;
    clients can safely retry the same form without creating a duplicate task.
    """
    if len(schedule_blocks) != 1:
        raise HTTPException(status_code=422, detail="原子创建只允许一个新任务时间块")

    # The atomic endpoint owns this block. Ignore any client-supplied taskId
    # or id so a caller cannot attach the new task to another task's block and
    # the client can derive the same stable id without a follow-up PUT.
    from src.api.schedule import ScheduleBlock, ScheduleSave

    task = _new_task(body)
    owned_block = ScheduleBlock.model_validate(
        {
            **schedule_blocks[0],
            "id": f"task-schedule-{task.id}",
            "taskId": task.id,
        }
    )
    db.add(task)
    await _emit_task_created(user_id, body, task, db)

    row = (
        await db.execute(
            select(DailySchedule).where(
                DailySchedule.user_id == user_id,
                DailySchedule.date == body.date,
            )
        )
    ).scalar_one_or_none()
    if row:
        # Re-validate against persisted blocks to keep the atomic endpoint's
        # invariant even when another tab already populated this date.
        try:
            merged = ScheduleSave(
                blocks=[
                    *[ScheduleBlock.model_validate(block) for block in row.blocks],
                    owned_block,
                ]
            )
        except ValueError as exc:
            await db.rollback()
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        row.blocks = [block.model_dump() for block in merged.blocks]
    else:
        db.add(
            DailySchedule(
                user_id=user_id,
                date=body.date,
                blocks=[owned_block.model_dump()],
            )
        )

    await db.commit()
    await db.refresh(task)
    return _to_out(task, goal.title)


async def update_task(
    user_id: str,
    task_id: str,
    body: TaskPatch,
    db: AsyncSession,
    timezone_name: str = "Asia/Shanghai",
) -> TaskOut | None:
    """更新任务字段

    Args:
        user_id: 用户 ID（用于权限校验 + DailyBrief 失效）
        task_id: 任务 ID
        body: 任务 patch 请求体
        db: 数据库会话

    Returns:
        更新后的 TaskOut，或 None（任务不存在/无权限）
    """
    row = (
        await db.execute(
            select(Task, Goal)
            .join(Goal, Task.goal_id == Goal.id)
            .where(Task.id == task_id, Goal.user_id == user_id)
        )
    ).first()
    if not row:
        return None

    task, goal = row
    if body.expectedVersion is not None and body.expectedVersion != task.version:
        raise DomainVersionConflict("task", task.id, body.expectedVersion, task.version)

    # 在 patch 前捕获旧值，用于 event payload
    old_date = task.scheduled_date
    old_mastery_level = task.mastery_level
    old_values = {
        "title": task.title,
        "description": task.description,
        "estimatedMinutes": task.estimated_mins,
        "actual_mins": task.actual_mins,
        "priority": task.priority,
        "done": task.status == "completed",
        "status": task.status,
    }

    changed_fields = _apply_patch_fields(task, body)
    changed_fields.discard("expectedVersion")
    if "actual_mins" in changed_fields and (task.actual_mins or 0) > 0 and task.status == "pending":
        task.status = "in_progress"
    next_version = task.version + 1 if changed_fields else task.version

    # 当 done 状态变更时清除简报缓存
    if "done" in changed_fields:
        await _invalidate_daily_brief(user_id, db, timezone_name)

    # emit events（在 commit 前，与 domain change 原子落库）
    completion_event = None
    if "done" in changed_fields and body.done:
        from datetime import date as date_type

        scheduled = task.scheduled_date or ""
        today_str = local_date_for_timezone(timezone_name).isoformat()
        try:
            days_overdue = (
                (date_type.fromisoformat(today_str) - date_type.fromisoformat(scheduled)).days
                if scheduled
                else 0
            )
        except ValueError:
            days_overdue = 0
        await emit_task_started_if_missing(
            db,
            user_id=user_id,
            goal_id=task.goal_id,
            task_id=task.id,
            trigger="task_completion_backfill",
            from_status=str(old_values["status"]),
            scheduled_date=task.scheduled_date,
            estimated_mins=task.estimated_mins,
        )
        completion_event = await emit(
            db,
            user_id=user_id,
            goal_id=task.goal_id,
            aggregate_type="task",
            aggregate_id=task.id,
            event_type="TaskCompleted",
            payload={
                "title": task.title,
                "task_type": task.type,
                "stage_label": task.stage_label,
                "scheduled_date": scheduled,
                "completed_at": task.completed_at.isoformat() if task.completed_at else None,
                "actual_mins": task.actual_mins,
                "estimated_mins": task.estimated_mins,
                "mastery_level": task.mastery_level,
                "days_overdue": days_overdue,
                "aggregate_version": next_version,
            },
        )
        await emit_recovery_completed_if_applicable(
            db,
            user_id=user_id,
            goal_id=task.goal_id,
            task_id=task.id,
            action_event=completion_event,
        )

    if (
        "actual_mins" in changed_fields
        and (task.actual_mins or 0) > 0
        and not body.done
        and old_values["status"] != "completed"
    ):
        await emit_task_started_if_missing(
            db,
            user_id=user_id,
            goal_id=task.goal_id,
            task_id=task.id,
            trigger="actual_minutes_recorded",
            from_status=str(old_values["status"]),
            scheduled_date=task.scheduled_date,
            estimated_mins=task.estimated_mins,
            extra_payload={"actual_mins": task.actual_mins},
        )

    if "date" in changed_fields:
        reschedule_trigger = body.rescheduleTrigger or "user_manual"
        await emit(
            db,
            user_id=user_id,
            goal_id=task.goal_id,
            aggregate_type="task",
            aggregate_id=task.id,
            event_type="TaskRescheduled",
            payload={
                "title": task.title,
                "from_date": old_date,
                "to_date": task.scheduled_date,
                "trigger": reschedule_trigger,
                "recovery_strategy": body.recoveryStrategy,
                "aggregate_version": next_version,
            },
        )
        if reschedule_trigger in {"overload_recovery", "deviation_recovery"}:
            deviation_event = await emit_deviation_detected(
                db,
                user_id=user_id,
                goal_id=task.goal_id,
                aggregate_id=f"{task.id}:{old_date}",
                deviation_type=(
                    "schedule_overload"
                    if reschedule_trigger == "overload_recovery"
                    else "execution_deviation"
                ),
                source="user_action",
                idempotency_key=(
                    f"task-deviation:{task.id}:{old_date}:{task.scheduled_date}:"
                    f"{reschedule_trigger}"
                ),
                payload={
                    "task_id": task.id,
                    "detected_on_confirmation": True,
                    "from_date": old_date,
                    "to_date": task.scheduled_date,
                    "trigger": reschedule_trigger,
                },
            )
            await emit_recovery_selected(
                db,
                user_id=user_id,
                goal_id=task.goal_id,
                task_id=task.id,
                deviation_event=deviation_event,
                strategy=body.recoveryStrategy or "standard",
                trigger=reschedule_trigger,
                from_date=old_date,
                to_date=task.scheduled_date,
            )

    if "mastery_level" in changed_fields:
        await emit(
            db,
            user_id=user_id,
            goal_id=task.goal_id,
            aggregate_type="task",
            aggregate_id=task.id,
            event_type="MasteryRecorded",
            payload={
                "task_title": task.title,
                "from_level": old_mastery_level,
                "to_level": task.mastery_level,
                "submission_mode": "manual_update",
                "aggregate_version": next_version,
            },
        )
        db.add(
            TaskMasteryRecord(
                task_id=task.id,
                goal_id=task.goal_id,
                user_id=user_id,
                mastery_level=task.mastery_level,
                source="manual",
            )
        )

    other_fields = changed_fields - {"done", "date", "mastery_level"}
    if other_fields:
        after_values = {
            "title": task.title,
            "description": task.description,
            "estimatedMinutes": task.estimated_mins,
            "actual_mins": task.actual_mins,
            "priority": task.priority,
        }
        await emit(
            db,
            user_id=user_id,
            goal_id=task.goal_id,
            aggregate_type="task",
            aggregate_id=task.id,
            event_type="TaskUpdated",
            payload={
                "changed_fields": sorted(other_fields),
                "before": {key: old_values.get(key) for key in other_fields},
                "after": {key: after_values[key] for key in other_fields},
                "aggregate_version": next_version,
            },
        )

    if "done" in changed_fields and body.done is False:
        await emit(
            db,
            user_id=user_id,
            goal_id=task.goal_id,
            aggregate_type="task",
            aggregate_id=task.id,
            event_type="TaskReopened",
            payload={"aggregate_version": next_version},
        )

    # 单次 commit：domain change + events + cache invalidation
    await db.commit()
    await db.refresh(task)

    return _to_out(task, goal.title)


async def observe_scheduled_task_start(
    user_id: str,
    task_id: str,
    db: AsyncSession,
    timezone_name: str,
    *,
    now: datetime | None = None,
) -> TaskOut | None:
    """在已确认执行时段内观察到前台活动时记录任务首次开始。

    保存或确认时间块本身不构成开始。调用方只能在用户打开今日工作区时
    触发本观察；服务端再次校验用户本地日期、任务日期和当前时间窗。
    """
    row = (
        await db.execute(
            select(Task, Goal)
            .join(Goal, Task.goal_id == Goal.id)
            .where(Task.id == task_id, Goal.user_id == user_id)
        )
    ).first()
    if not row:
        return None

    task, goal = row
    if task.status != "pending":
        return _to_out(task, goal.title)

    local_now = to_user_timezone(now or utc_now_aware(), timezone_name)
    local_date = local_now.date().isoformat()
    if task.scheduled_date != local_date:
        return _to_out(task, goal.title)
    schedule = await db.scalar(
        select(DailySchedule).where(
            DailySchedule.user_id == user_id,
            DailySchedule.date == local_date,
        )
    )
    current_minute = local_now.hour * 60 + local_now.minute + local_now.second / 60
    active_block = next(
        (
            block
            for block in (schedule.blocks if schedule else [])
            if str(block.get("taskId") or "") == task.id
            and float(block.get("startHour", -1)) * 60
            <= current_minute
            < float(block.get("startHour", -1)) * 60 + float(block.get("durationMinutes", 0))
        ),
        None,
    )
    if active_block is None:
        return _to_out(task, goal.title)

    previous_status = task.status
    task.status = "in_progress"
    await emit_task_started_if_missing(
        db,
        user_id=user_id,
        goal_id=task.goal_id,
        task_id=task.id,
        trigger="schedule_window_observed",
        from_status=previous_status,
        scheduled_date=task.scheduled_date,
        estimated_mins=task.estimated_mins,
        source="system",
        extra_payload={
            "schedule_block_id": active_block.get("id"),
            "scheduled_start_hour": active_block.get("startHour"),
            "scheduled_duration_minutes": active_block.get("durationMinutes"),
            "observed_via": "today_workspace_active",
        },
    )
    await db.commit()
    await db.refresh(task)
    return _to_out(task, goal.title)


async def delete_task(
    user_id: str,
    task_id: str,
    db: AsyncSession,
    *,
    expected_version: int | None = None,
) -> bool:
    """删除任务

    Args:
        user_id: 用户 ID
        task_id: 任务 ID
        db: 数据库会话

    Returns:
        True 如果删除成功，False 如果任务不存在/无权限
    """
    row = (
        await db.execute(
            select(Task)
            .join(Goal, Task.goal_id == Goal.id)
            .where(Task.id == task_id, Goal.user_id == user_id)
        )
    ).scalar_one_or_none()
    if not row:
        return False
    if expected_version is not None and expected_version != row.version:
        raise DomainVersionConflict("task", row.id, expected_version, row.version)

    await emit(
        db,
        user_id=user_id,
        goal_id=row.goal_id,
        aggregate_type="task",
        aggregate_id=row.id,
        event_type="TaskDeleted",
        payload={
            "title": row.title,
            "scheduled_date": row.scheduled_date,
            "aggregate_version": row.version,
        },
    )
    await db.delete(row)
    await db.commit()
    return True
