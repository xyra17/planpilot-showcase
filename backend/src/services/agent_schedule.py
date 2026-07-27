from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta, timezone
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


def _task_snapshot(task: Task) -> dict[str, Any]:
    return {
        "id": task.id,
        "goal_id": task.goal_id,
        "title": task.title,
        "description": task.description,
        "estimated_mins": task.estimated_mins,
        "status": task.status,
        "priority": task.priority,
        "scheduled_date": task.scheduled_date,
        "mastery_level": task.mastery_level,
    }


def _requested_task_count(request: str) -> int:
    match = re.search(r"(?:新增|创建|添加)\s*([一二两三四五六七八九十\d]+)\s*(?:个|项)?", request)
    if not match:
        return 1
    raw = match.group(1)
    if raw.isdigit():
        return max(1, min(10, int(raw)))
    numbers = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
    return numbers.get(raw, 1)


def _requested_date(request: str) -> str | None:
    match = re.search(r"(20\d{2}-\d{2}-\d{2})", request)
    if match:
        try:
            return date.fromisoformat(match.group(1)).isoformat()
        except ValueError:
            return None
    if "明天" in request:
        return (date.today() + timedelta(days=1)).isoformat()
    if "今天" in request:
        return date.today().isoformat()
    return None


def build_task_mutation_preview(
    context: dict[str, Any],
    *,
    request: str,
    goal_id: str | None,
    excluded_weekdays: list[int] | None = None,
) -> ChangeSet:
    goals = context["goals"]
    selected_goal = goal_id or (goals[0]["id"] if len(goals) == 1 else None)
    tasks = context["tasks"]
    quoted = re.findall(r"[“\"]([^”\"]+)[”\"]", request)
    is_delete = any(term in request for term in ("删除任务", "删掉任务", "移除任务"))
    is_complete = any(term in request for term in ("完成任务", "标记完成"))
    is_create = any(term in request for term in ("新增", "创建", "添加"))
    requested_date = _requested_date(request)

    if is_create:
        if not selected_goal:
            return ChangeSet(
                summary="需要先选择目标",
                warnings=["创建任务必须关联一个目标，请在工作台选择目标后重试。"],
            )
        count = _requested_task_count(request)
        base_title = quoted[0] if quoted else "复习任务"
        available = next_week_dates(excluded_weekdays) or [date.today() + timedelta(days=1)]
        operations = []
        for index in range(count):
            title = base_title if count == 1 else f"{base_title} {index + 1}"
            scheduled = requested_date or available[index % len(available)].isoformat()
            task_id = str(uuid.uuid4())
            snapshot = {
                "id": task_id,
                "goal_id": selected_goal,
                "title": title,
                "description": None,
                "estimated_mins": 30,
                "status": "pending",
                "priority": "medium",
                "scheduled_date": scheduled,
                "mastery_level": "unknown",
            }
            operations.append(
                ChangeOperation(
                    entity="task",
                    entity_id=task_id,
                    field="__create__",
                    before=None,
                    after=snapshot,
                    label=title,
                    reason="按用户请求创建学习任务",
                )
            )
        return ChangeSet(summary=f"建议创建 {count} 项任务", operations=operations)

    matches = [
        task
        for task in tasks
        if (not selected_goal or task["goal_id"] == selected_goal)
        and (
            any(title in task["title"] or task["title"] in title for title in quoted)
            or (not quoted and task["title"] in request)
        )
    ]
    if (is_delete or is_complete or requested_date):
        if not matches:
            return ChangeSet(
                summary="没有定位到要修改的任务",
                warnings=["请在请求中使用引号写出任务标题，例如：删除任务“章节练习”。"],
            )
        operations: list[ChangeOperation] = []
        for raw in matches:
            snapshot = {
                "id": raw["id"],
                "goal_id": raw["goal_id"],
                "title": raw["title"],
                "description": raw.get("description"),
                "estimated_mins": raw["estimated_minutes"],
                "status": raw["status"],
                "priority": raw["priority"],
                "scheduled_date": raw["date"],
                "mastery_level": raw.get("mastery_level", "unknown"),
            }
            if is_delete:
                operations.append(
                    ChangeOperation(
                        entity="task",
                        entity_id=raw["id"],
                        field="__delete__",
                        before=snapshot,
                        after=None,
                        label=raw["title"],
                        reason="按用户请求删除任务",
                    )
                )
            elif is_complete:
                operations.append(
                    ChangeOperation(
                        entity="task",
                        entity_id=raw["id"],
                        field="status",
                        before=raw["status"],
                        after="completed",
                        label=raw["title"],
                        reason="按用户请求标记任务完成",
                    )
                )
            elif requested_date:
                operations.append(
                    ChangeOperation(
                        entity="task",
                        entity_id=raw["id"],
                        field="scheduled_date",
                        before=raw["date"],
                        after=requested_date,
                        label=raw["title"],
                        reason="按用户请求修改任务日期",
                    )
                )
        action = "删除" if is_delete else "更新"
        return ChangeSet(summary=f"建议{action} {len(operations)} 项任务", operations=operations)

    return build_reschedule_preview(context, excluded_weekdays=excluded_weekdays)


async def apply_task_changes(
    db: AsyncSession, user_id: str, change_set: ChangeSet
) -> dict[str, Any]:
    allowed_fields = {
        "title",
        "description",
        "estimated_mins",
        "status",
        "priority",
        "scheduled_date",
    }
    applied: list[dict[str, Any]] = []
    for operation in change_set.operations:
        if operation.entity != "task" or operation.field not in {
            *allowed_fields,
            "__create__",
            "__delete__",
        }:
            raise HTTPException(400, "变更集中包含不受支持的写操作")
        if operation.field == "__create__":
            snapshot = dict(operation.after or {})
            goal = (
                await db.execute(
                    select(Goal).where(
                        Goal.id == snapshot.get("goal_id"), Goal.user_id == user_id
                    )
                )
            ).scalar_one_or_none()
            if not goal:
                raise HTTPException(404, "创建任务所关联的目标不存在")
            existing = await db.get(Task, operation.entity_id)
            if existing:
                if _task_snapshot(existing) == snapshot:
                    applied.append({**operation.model_dump(), "already_applied": True})
                    continue
                raise HTTPException(409, "任务幂等键冲突")
            db.add(
                Task(
                    id=operation.entity_id,
                    goal_id=snapshot["goal_id"],
                    title=snapshot["title"],
                    description=snapshot.get("description"),
                    estimated_mins=int(snapshot.get("estimated_mins", 30)),
                    status=snapshot.get("status", "pending"),
                    priority=snapshot.get("priority", "medium"),
                    scheduled_date=snapshot["scheduled_date"],
                    mastery_level=snapshot.get("mastery_level", "unknown"),
                )
            )
            applied.append(operation.model_dump())
            continue
        row = (
            await db.execute(
                select(Task, Goal)
                .join(Goal, Task.goal_id == Goal.id)
                .where(Task.id == operation.entity_id, Goal.user_id == user_id)
            )
        ).first()
        if not row:
            if operation.field == "__delete__":
                applied.append({**operation.model_dump(), "already_applied": True})
                continue
            raise HTTPException(404, f"任务 {operation.entity_id} 不存在")
        task, _goal = row
        if operation.field == "__delete__":
            expected = dict(operation.before or {})
            if expected and _task_snapshot(task) != expected:
                raise HTTPException(409, f"任务“{task.title}”已发生变化，请重新生成方案")
            await db.delete(task)
            applied.append(operation.model_dump())
            continue
        current = getattr(task, operation.field)
        if current == operation.after:
            applied.append({**operation.model_dump(), "already_applied": True})
            continue
        if current != operation.before:
            raise HTTPException(409, f"任务“{task.title}”已发生变化，请重新生成方案")
        setattr(task, operation.field, operation.after)
        if operation.field == "status":
            task.completed_at = (
                datetime.now(timezone.utc).replace(tzinfo=None)
                if operation.after == "completed"
                else None
            )
        applied.append(operation.model_dump())
    # Executor 在 Observer 回读验证通过后统一提交；验证失败时可整体回滚。
    await db.flush()
    return {"applied": applied, "count": len(applied)}


async def undo_task_changes(
    db: AsyncSession, user_id: str, operations: list[dict[str, Any]]
) -> dict[str, Any]:
    reverted: list[str] = []
    for raw in reversed(operations):
        operation = ChangeOperation.model_validate(raw)
        if operation.field == "__create__":
            row = (
                await db.execute(
                    select(Task)
                    .join(Goal, Task.goal_id == Goal.id)
                    .where(Task.id == operation.entity_id, Goal.user_id == user_id)
                )
            ).scalar_one_or_none()
            if row:
                if _task_snapshot(row) != dict(operation.after or {}):
                    raise HTTPException(409, f"任务“{row.title}”已变化，不能自动撤销")
                await db.delete(row)
                reverted.append(row.id)
            continue
        if operation.field == "__delete__":
            snapshot = dict(operation.before or {})
            goal = (
                await db.execute(
                    select(Goal).where(
                        Goal.id == snapshot.get("goal_id"), Goal.user_id == user_id
                    )
                )
            ).scalar_one_or_none()
            if not goal:
                raise HTTPException(409, "原目标已不存在，不能恢复任务")
            if not await db.get(Task, operation.entity_id):
                db.add(
                    Task(
                        id=operation.entity_id,
                        goal_id=snapshot["goal_id"],
                        title=snapshot["title"],
                        description=snapshot.get("description"),
                        estimated_mins=snapshot["estimated_mins"],
                        status=snapshot["status"],
                        priority=snapshot["priority"],
                        scheduled_date=snapshot["scheduled_date"],
                        mastery_level=snapshot.get("mastery_level", "unknown"),
                    )
                )
                reverted.append(operation.entity_id)
            continue
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
        current = getattr(task, operation.field)
        if current == operation.before:
            continue
        if current != operation.after:
            raise HTTPException(409, f"任务“{task.title}”已再次变化，不能自动撤销")
        setattr(task, operation.field, operation.before)
        if operation.field == "status":
            task.completed_at = None
        reverted.append(task.id)
    await db.commit()
    return {"reverted": reverted, "count": len(reverted)}
