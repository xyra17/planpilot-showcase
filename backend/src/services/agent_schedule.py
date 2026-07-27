from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.agent_v2.schemas import ChangeOperation, ChangeSet
from src.models import Goal, Task

WEEKDAY_NAMES = {
    0: "周一",
    1: "周二",
    2: "周三",
    3: "周四",
    4: "周五",
    5: "周六",
    6: "周日",
}


def next_week_dates(excluded_weekdays: list[int] | None = None) -> list[date]:
    excluded = set(excluded_weekdays or [])
    start = date.today() + timedelta(days=(7 - date.today().weekday()))
    return [
        start + timedelta(days=offset)
        for offset in range(7)
        if (start + timedelta(days=offset)).weekday() not in excluded
    ]


def build_reschedule_preview(
    context: dict[str, Any],
    *,
    excluded_weekdays: list[int] | None = None,
) -> ChangeSet:
    candidates = [
        task
        for task in context["tasks"]
        if task["status"] != "completed" and task["date"] < date.today().isoformat()
    ]
    target_days = next_week_dates(excluded_weekdays)
    if not candidates:
        return ChangeSet(summary="没有需要重新安排的逾期任务")
    if not target_days:
        return ChangeSet(
            summary="没有可用日期",
            warnings=["排除条件覆盖了下周全部日期，未生成变更。"],
        )

    goals = {row["id"]: row for row in context["goals"]}
    capacity: dict[str, int] = {
        day.isoformat(): max(
            30,
            int(
                sum(float(goal["daily_hours"]) * 60 for goal in context["goals"])
                / max(len(context["goals"]), 1)
            ),
        )
        for day in target_days
    }
    used = {day.isoformat(): 0 for day in target_days}
    operations: list[ChangeOperation] = []
    warnings: list[str] = []
    for task in sorted(candidates, key=lambda row: (row["date"], row["priority"])):
        target = min(target_days, key=lambda day: used[day.isoformat()])
        key = target.isoformat()
        used[key] += int(task["estimated_minutes"])
        if used[key] > capacity[key]:
            warnings.append(f"{key} 的预计任务量超过建议容量")
        goal_title = goals.get(task["goal_id"], {}).get("title", "目标")
        operations.append(
            ChangeOperation(
                entity="task",
                entity_id=task["id"],
                field="scheduled_date",
                before=task["date"],
                after=key,
                label=f"{goal_title} · {task['title']}",
                reason=f"逾期任务移至下周 {WEEKDAY_NAMES[target.weekday()]}",
            )
        )
    return ChangeSet(
        summary=f"建议重新安排 {len(operations)} 项逾期任务",
        operations=operations,
        warnings=sorted(set(warnings)),
    )


async def apply_task_changes(
    db: AsyncSession, user_id: str, change_set: ChangeSet
) -> dict[str, Any]:
    applied: list[dict[str, Any]] = []
    for operation in change_set.operations:
        if operation.entity != "task" or operation.field != "scheduled_date":
            raise HTTPException(400, "变更集中包含不受支持的写操作")
        row = (
            await db.execute(
                select(Task, Goal)
                .join(Goal, Task.goal_id == Goal.id)
                .where(Task.id == operation.entity_id, Goal.user_id == user_id)
            )
        ).first()
        if not row:
            raise HTTPException(404, f"任务 {operation.entity_id} 不存在")
        task, _goal = row
        if task.scheduled_date == operation.after:
            applied.append({**operation.model_dump(), "already_applied": True})
            continue
        if task.scheduled_date != operation.before:
            raise HTTPException(409, f"任务“{task.title}”已发生变化，请重新生成方案")
        task.scheduled_date = str(operation.after)
        applied.append(operation.model_dump())
    await db.commit()
    return {"applied": applied, "count": len(applied)}


async def undo_task_changes(
    db: AsyncSession, user_id: str, operations: list[dict[str, Any]]
) -> dict[str, Any]:
    reverted: list[str] = []
    for raw in reversed(operations):
        operation = ChangeOperation.model_validate(raw)
        row = (
            await db.execute(
                select(Task, Goal)
                .join(Goal, Task.goal_id == Goal.id)
                .where(Task.id == operation.entity_id, Goal.user_id == user_id)
            )
        ).first()
        if not row:
            continue
        task, _goal = row
        if task.scheduled_date == operation.before:
            continue
        if task.scheduled_date != operation.after:
            raise HTTPException(409, f"任务“{task.title}”已再次变化，不能自动撤销")
        task.scheduled_date = str(operation.before)
        reverted.append(task.id)
    await db.commit()
    return {"reverted": reverted, "count": len(reverted)}
