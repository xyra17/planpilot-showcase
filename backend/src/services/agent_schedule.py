from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.agent_v2.schemas import ActionIntent, ChangeOperation, ChangeSet
from src.core.time import utc_now
from src.events.publisher import emit
from src.models import CheckinRecord, Goal, Task
from src.services.learning_lifecycle_service import (
    emit_recovery_completed_if_applicable,
    emit_task_started_if_missing,
)

WEEKDAY_NAMES = {
    0: "周一",
    1: "周二",
    2: "周三",
    3: "周四",
    4: "周五",
    5: "周六",
    6: "周日",
}


def next_week_dates(
    excluded_weekdays: list[int] | None = None, *, today: date | None = None
) -> list[date]:
    excluded = set(excluded_weekdays or [])
    reference_date = today or date.today()
    start = reference_date + timedelta(days=(7 - reference_date.weekday()))
    return [
        start + timedelta(days=offset)
        for offset in range(7)
        if (start + timedelta(days=offset)).weekday() not in excluded
    ]


def build_reschedule_preview(
    context: dict[str, Any],
    *,
    excluded_weekdays: list[int] | None = None,
    today: date | None = None,
) -> ChangeSet:
    reference_date = today or date.today()
    candidates = [
        task
        for task in context["tasks"]
        if task["status"] != "completed" and task["date"] < reference_date.isoformat()
    ]
    target_days = next_week_dates(excluded_weekdays, today=reference_date)
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
                precondition={"version": int(task.get("version", 1))},
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
        "plan_id": task.plan_id,
        "title": task.title,
        "description": task.description,
        "estimated_mins": task.estimated_mins,
        "actual_mins": task.actual_mins,
        "status": task.status,
        "priority": task.priority,
        "scheduled_date": task.scheduled_date,
        "mastery_level": task.mastery_level,
        "type": task.type,
        "kb_refs": list(task.kb_refs or []),
        "stage_label": task.stage_label,
        "sequence_in_plan": task.sequence_in_plan,
        "completed_at": task.completed_at.isoformat() if task.completed_at else None,
        "version": task.version,
    }


def _matches_snapshot(task: Task, expected: dict[str, Any]) -> bool:
    actual = _task_snapshot(task)
    return all(actual.get(key) == value for key, value in expected.items())


def _normalized_create_snapshot(operation: ChangeOperation) -> dict[str, Any]:
    snapshot = dict(operation.after or {})
    snapshot.setdefault("id", operation.entity_id)
    snapshot.setdefault("version", 1)
    return snapshot


def _requested_task_count(request: str) -> int:
    match = re.search(r"(?:新增|创建|添加)\s*([一二两三四五六七八九十\d]+)\s*(?:个|项)?", request)
    if not match:
        return 1
    raw = match.group(1)
    if raw.isdigit():
        return max(1, min(10, int(raw)))
    numbers = {
        "一": 1,
        "二": 2,
        "两": 2,
        "三": 3,
        "四": 4,
        "五": 5,
        "六": 6,
        "七": 7,
        "八": 8,
        "九": 9,
        "十": 10,
    }
    return numbers.get(raw, 1)


def _requested_date(request: str, *, today: date | None = None) -> str | None:
    reference_date = today or date.today()
    match = re.search(r"(20\d{2}-\d{2}-\d{2})", request)
    if match:
        try:
            return date.fromisoformat(match.group(1)).isoformat()
        except ValueError:
            return None
    if "明天" in request:
        return (reference_date + timedelta(days=1)).isoformat()
    if "今天" in request:
        return reference_date.isoformat()
    return None


def build_task_mutation_preview(
    context: dict[str, Any],
    *,
    request: str,
    goal_id: str | None,
    excluded_weekdays: list[int] | None = None,
    today: date | None = None,
    action_intent: dict[str, Any] | ActionIntent | None = None,
) -> ChangeSet:
    reference_date = today or date.today()
    goals = context["goals"]
    tasks = context["tasks"]
    resolved_intent = (
        action_intent
        if isinstance(action_intent, ActionIntent)
        else ActionIntent.model_validate(action_intent)
        if action_intent
        else None
    )
    if resolved_intent and not resolved_intent.complete:
        raise ValueError("不能使用缺少关键参数的 ActionIntent 生成变更预览")

    selected_goal = (
        resolved_intent.goal_id
        if resolved_intent
        else goal_id or (goals[0]["id"] if len(goals) == 1 else None)
    )
    quoted = re.findall(r"[“\"]([^”\"]+)[”\"]", request)
    effect = resolved_intent.requested_effect if resolved_intent else None
    if resolved_intent:
        # ActionIntent is the authoritative semantic contract. Re-reading the
        # original sentence here can invert the resolved effect: for example,
        # “把任务延两天；只创建待审批预览” is an update, not a task creation.
        is_delete = effect == "delete"
        is_complete = effect == "complete"
        is_create = effect == "create"
        requested_date = (
            str(resolved_intent.constraints["scheduled_date"])
            if resolved_intent.constraints.get("scheduled_date")
            else None
        )
    else:
        is_delete = any(term in request for term in ("删除任务", "删掉任务", "移除任务"))
        is_complete = any(term in request for term in ("完成任务", "标记完成"))
        is_create = any(term in request for term in ("新增", "创建", "添加"))
        requested_date = _requested_date(request, today=reference_date)

    resolved_refs = (
        {ref.entity: ref for ref in resolved_intent.entity_refs} if resolved_intent else {}
    )
    resolved_task_id = resolved_refs.get("task").entity_id if resolved_refs.get("task") else None
    resolved_title = (
        str(resolved_intent.constraints.get("task_title", "")).strip() if resolved_intent else ""
    )

    if is_create:
        if not selected_goal:
            return ChangeSet(
                summary="需要先选择目标",
                warnings=["创建任务必须关联一个目标，请在工作台选择目标后重试。"],
            )
        count = _requested_task_count(request)
        base_title = resolved_title or (quoted[0] if quoted else "")
        if not base_title or not requested_date:
            return ChangeSet(
                summary="创建任务所需信息不完整",
                warnings=["请明确任务标题和执行日期后再生成方案。"],
            )
        available = next_week_dates(excluded_weekdays, today=reference_date) or [
            reference_date + timedelta(days=1)
        ]
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
                "type": "study",
                "kb_refs": [],
                "version": 1,
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

    if resolved_intent:
        matches = [task for task in tasks if task["id"] == resolved_task_id]
    else:
        matches = [
            task
            for task in tasks
            if (not selected_goal or task["goal_id"] == selected_goal)
            and (
                any(title in task["title"] or task["title"] in title for title in quoted)
                or (not quoted and task["title"] in request)
            )
        ]
    if is_delete or is_complete or requested_date:
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
                "plan_id": raw.get("plan_id"),
                "title": raw["title"],
                "description": raw.get("description"),
                "estimated_mins": raw["estimated_minutes"],
                "actual_mins": raw.get("actual_mins"),
                "status": raw["status"],
                "priority": raw["priority"],
                "scheduled_date": raw["date"],
                "mastery_level": raw.get("mastery_level", "unknown"),
                "type": raw.get("type", "study"),
                "kb_refs": list(raw.get("kb_refs") or []),
                "stage_label": raw.get("stage_label"),
                "sequence_in_plan": raw.get("sequence_in_plan"),
                "completed_at": raw.get("completed_at"),
                "version": int(raw.get("version", 1)),
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
                        precondition={"version": int(raw.get("version", 1))},
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
                        precondition={"version": int(raw.get("version", 1))},
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
                        precondition={"version": int(raw.get("version", 1))},
                    )
                )
        action = "删除" if is_delete else "更新"
        return ChangeSet(summary=f"建议{action} {len(operations)} 项任务", operations=operations)

    return build_reschedule_preview(
        context, excluded_weekdays=excluded_weekdays, today=reference_date
    )


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
        "type",
        "kb_refs",
    }
    applied: list[dict[str, Any]] = []
    for operation in change_set.operations:
        if operation.entity == "checkin":
            if operation.field != "__upsert__":
                raise HTTPException(400, "变更集中包含不受支持的打卡写操作")
            snapshot = dict(operation.after or {})
            goal = await db.scalar(
                select(Goal).where(Goal.id == snapshot.get("goal_id"), Goal.user_id == user_id)
            )
            if goal is None:
                raise HTTPException(404, "打卡关联目标不存在")
            row = await db.scalar(
                select(CheckinRecord).where(
                    CheckinRecord.user_id == user_id,
                    CheckinRecord.goal_id == goal.id,
                    CheckinRecord.date == snapshot.get("date"),
                )
            )
            if row is not None:
                actual = {
                    "id": row.id,
                    "goal_id": row.goal_id,
                    "date": row.date,
                    "mode": row.mode,
                    "natural_text": row.natural_text,
                    "completion_rate": row.completion_rate,
                }
                if all(actual.get(key) == value for key, value in snapshot.items()):
                    applied.append({**operation.model_dump(), "already_applied": True})
                    continue
                before = dict(operation.before or {}) if operation.before else None
                if before is None or any(actual.get(key) != value for key, value in before.items()):
                    raise HTTPException(409, "打卡记录已发生变化，请重新生成预览")
            if row is None:
                row = CheckinRecord(
                    id=operation.entity_id,
                    user_id=user_id,
                    goal_id=goal.id,
                    date=str(snapshot["date"]),
                    mode="natural",
                    natural_text=str(snapshot.get("natural_text") or ""),
                    completion_rate=float(snapshot["completion_rate"]),
                    stats={},
                    feedback="",
                )
                db.add(row)
            else:
                row.mode = "natural"
                row.natural_text = str(snapshot.get("natural_text") or "")
                row.completion_rate = float(snapshot["completion_rate"])
            await emit(
                db,
                user_id=user_id,
                goal_id=goal.id,
                aggregate_type="checkin",
                aggregate_id=row.id,
                event_type="CheckinRecorded",
                source="ai_agent",
                correlation_id=change_set.run_id,
                causation_id=operation.source_step_id,
                idempotency_key=f"agent-operation:{operation.operation_id}:apply",
                payload={
                    "date": row.date,
                    "completion_rate": row.completion_rate,
                    "mode": "natural",
                },
            )
            applied.append(operation.model_dump())
            continue
        if operation.entity == "goal":
            if operation.field == "__create__":
                snapshot = dict(operation.after or {})
                existing = await db.get(Goal, operation.entity_id)
                if existing:
                    if existing.user_id == user_id and all(
                        getattr(existing, key, None) == value
                        for key, value in snapshot.items()
                        if key not in {"id", "version"}
                    ):
                        applied.append({**operation.model_dump(), "already_applied": True})
                        continue
                    raise HTTPException(409, "目标幂等键冲突")
                goal = Goal(
                    id=operation.entity_id,
                    user_id=user_id,
                    type=str(snapshot.get("type", "skill")),
                    title=str(snapshot["title"]),
                    deadline=str(snapshot["deadline"]),
                    daily_hours=float(snapshot.get("daily_hours", 1)),
                    current_level=str(snapshot.get("current_level", "beginner")),
                    status=str(snapshot.get("status", "active")),
                    meta=dict(snapshot.get("meta") or {}),
                    version=int(snapshot.get("version", 1)),
                )
                db.add(goal)
                await emit(
                    db,
                    user_id=user_id,
                    goal_id=goal.id,
                    aggregate_type="goal",
                    aggregate_id=goal.id,
                    event_type="GoalCreated",
                    source="ai_agent",
                    correlation_id=change_set.run_id,
                    causation_id=operation.source_step_id,
                    idempotency_key=f"agent-operation:{operation.operation_id}:apply",
                    payload={**snapshot, "aggregate_version": 1},
                )
                applied.append(operation.model_dump())
                continue
            if operation.field != "daily_hours":
                raise HTTPException(400, "变更集中包含不受支持的目标写操作")
            goal = await db.scalar(
                select(Goal).where(Goal.id == operation.entity_id, Goal.user_id == user_id)
            )
            if goal is None:
                raise HTTPException(404, "目标不存在")
            if goal.daily_hours == operation.after:
                applied.append({**operation.model_dump(), "already_applied": True})
                continue
            expected_version = operation.precondition.get("version")
            if expected_version is not None and goal.version != int(expected_version):
                raise HTTPException(409, f"目标“{goal.title}”版本已变化，请重新生成方案")
            if goal.daily_hours != operation.before:
                raise HTTPException(409, f"目标“{goal.title}”已发生变化，请重新生成方案")
            goal.daily_hours = float(operation.after)
            await emit(
                db,
                user_id=user_id,
                goal_id=goal.id,
                aggregate_type="goal",
                aggregate_id=goal.id,
                event_type="GoalUpdated",
                source="ai_agent",
                correlation_id=change_set.run_id,
                causation_id=operation.source_step_id,
                idempotency_key=f"agent-operation:{operation.operation_id}:apply",
                payload={
                    "changed_fields": ["daily_hours"],
                    "old_daily_hours": operation.before,
                    "daily_hours": operation.after,
                    "aggregate_version": goal.version + 1,
                },
            )
            applied.append(operation.model_dump())
            continue
        if operation.entity != "task" or operation.field not in {
            *allowed_fields,
            "__create__",
            "__delete__",
        }:
            raise HTTPException(400, "变更集中包含不受支持的写操作")
        if operation.field == "__create__":
            snapshot = _normalized_create_snapshot(operation)
            goal = (
                await db.execute(
                    select(Goal).where(Goal.id == snapshot.get("goal_id"), Goal.user_id == user_id)
                )
            ).scalar_one_or_none()
            if not goal:
                raise HTTPException(404, "创建任务所关联的目标不存在")
            existing = await db.get(Task, operation.entity_id)
            if existing:
                if _matches_snapshot(existing, snapshot):
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
                    type=snapshot.get("type", "study"),
                    kb_refs=snapshot.get("kb_refs", []),
                    version=int(snapshot.get("version", 1)),
                )
            )
            await emit(
                db,
                user_id=user_id,
                goal_id=snapshot["goal_id"],
                aggregate_type="task",
                aggregate_id=operation.entity_id,
                event_type="TaskCreated",
                source="ai_agent",
                correlation_id=change_set.run_id,
                causation_id=operation.source_step_id,
                idempotency_key=f"agent-operation:{operation.operation_id}:apply",
                payload={**snapshot, "aggregate_version": 1},
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
        if operation.field not in {"__delete__"}:
            current = getattr(task, operation.field)
            if current == operation.after:
                applied.append({**operation.model_dump(), "already_applied": True})
                continue
        expected_version = operation.precondition.get("version")
        if expected_version is not None and task.version != int(expected_version):
            raise HTTPException(409, f"任务“{task.title}”版本已变化，请重新生成方案")
        if operation.field == "__delete__":
            expected = dict(operation.before or {})
            if expected and not _matches_snapshot(task, expected):
                raise HTTPException(409, f"任务“{task.title}”已发生变化，请重新生成方案")
            await emit(
                db,
                user_id=user_id,
                goal_id=task.goal_id,
                aggregate_type="task",
                aggregate_id=task.id,
                event_type="TaskDeleted",
                source="ai_agent",
                correlation_id=change_set.run_id,
                causation_id=operation.source_step_id,
                idempotency_key=f"agent-operation:{operation.operation_id}:apply",
                payload={**expected, "aggregate_version": task.version},
            )
            await db.delete(task)
            applied.append(operation.model_dump())
            continue
        if current != operation.before:
            raise HTTPException(409, f"任务“{task.title}”已发生变化，请重新生成方案")
        setattr(task, operation.field, operation.after)
        if operation.field == "status":
            task.completed_at = utc_now() if operation.after == "completed" else None
        event_type = (
            "TaskCompleted"
            if operation.field == "status" and operation.after == "completed"
            else "TaskReopened"
            if operation.field == "status"
            else "TaskRescheduled"
            if operation.field == "scheduled_date"
            else "TaskUpdated"
        )
        if event_type == "TaskCompleted":
            await emit_task_started_if_missing(
                db,
                user_id=user_id,
                goal_id=task.goal_id,
                task_id=task.id,
                trigger="agent_completion_backfill",
                from_status=str(current),
                scheduled_date=task.scheduled_date,
                estimated_mins=task.estimated_mins,
                source="ai_agent",
                correlation_id=change_set.run_id,
                causation_id=operation.source_step_id,
            )
        domain_event = await emit(
            db,
            user_id=user_id,
            goal_id=task.goal_id,
            aggregate_type="task",
            aggregate_id=task.id,
            event_type=event_type,
            source="ai_agent",
            correlation_id=change_set.run_id,
            causation_id=operation.source_step_id,
            idempotency_key=f"agent-operation:{operation.operation_id}:apply",
            payload={
                "field": operation.field,
                "before": operation.before,
                "after": operation.after,
                "aggregate_version": task.version + 1,
            },
        )
        if event_type == "TaskCompleted":
            await emit_recovery_completed_if_applicable(
                db,
                user_id=user_id,
                goal_id=task.goal_id,
                task_id=task.id,
                action_event=domain_event,
            )
        applied.append(operation.model_dump())
    # Executor 在 Observer 回读验证通过后统一提交；验证失败时可整体回滚。
    await db.flush()
    return {"applied": applied, "count": len(applied)}


async def undo_task_changes(
    db: AsyncSession, user_id: str, operations: list[dict[str, Any]], *, commit: bool = True
) -> dict[str, Any]:
    reverted: list[str] = []
    for raw in reversed(operations):
        operation = ChangeOperation.model_validate(raw)
        if operation.entity == "checkin":
            row = await db.scalar(
                select(CheckinRecord)
                .join(Goal, CheckinRecord.goal_id == Goal.id)
                .where(CheckinRecord.id == operation.entity_id, Goal.user_id == user_id)
            )
            before = dict(operation.before or {}) if operation.before else None
            if before is None:
                if row is not None:
                    await db.delete(row)
                    reverted.append(operation.entity_id)
                continue
            if row is None:
                raise HTTPException(409, "原打卡记录已不存在，不能自动撤销")
            row.mode = str(before.get("mode") or "natural")
            row.natural_text = before.get("natural_text")
            row.completion_rate = float(before.get("completion_rate") or 0)
            reverted.append(row.id)
            continue
        if operation.entity == "goal":
            if operation.field == "__create__":
                goal = await db.scalar(
                    select(Goal).where(Goal.id == operation.entity_id, Goal.user_id == user_id)
                )
                if goal is None:
                    continue
                task_count = await db.scalar(
                    select(func.count(Task.id)).where(Task.goal_id == goal.id)
                )
                if task_count:
                    raise HTTPException(409, f"目标“{goal.title}”仍有关联任务，不能自动撤销")
                await db.delete(goal)
                await emit(
                    db,
                    user_id=user_id,
                    goal_id=goal.id,
                    aggregate_type="goal",
                    aggregate_id=goal.id,
                    event_type="AgentGoalChangeUndone",
                    source="ai_agent",
                    correlation_id=operation.source_step_id,
                    idempotency_key=f"agent-operation:{operation.operation_id}:undo",
                    payload={"undo": "create", "aggregate_version": goal.version},
                )
                reverted.append(goal.id)
                continue
            goal = await db.scalar(
                select(Goal).where(Goal.id == operation.entity_id, Goal.user_id == user_id)
            )
            if goal is None or goal.daily_hours == operation.before:
                continue
            expected_version = operation.precondition.get("version")
            if expected_version is not None and goal.version != int(expected_version) + 1:
                raise HTTPException(409, f"目标“{goal.title}”版本已变化，不能自动撤销")
            if goal.daily_hours != operation.after:
                raise HTTPException(409, f"目标“{goal.title}”已再次变化，不能自动撤销")
            goal.daily_hours = float(operation.before)
            await emit(
                db,
                user_id=user_id,
                goal_id=goal.id,
                aggregate_type="goal",
                aggregate_id=goal.id,
                event_type="AgentGoalChangeUndone",
                source="ai_agent",
                correlation_id=operation.source_step_id,
                idempotency_key=f"agent-operation:{operation.operation_id}:undo",
                payload={
                    "field": operation.field,
                    "before": operation.after,
                    "after": operation.before,
                    "aggregate_version": goal.version + 1,
                },
            )
            reverted.append(goal.id)
            continue
        if operation.field == "__create__":
            row = (
                await db.execute(
                    select(Task)
                    .join(Goal, Task.goal_id == Goal.id)
                    .where(Task.id == operation.entity_id, Goal.user_id == user_id)
                )
            ).scalar_one_or_none()
            if row:
                if not _matches_snapshot(row, _normalized_create_snapshot(operation)):
                    raise HTTPException(409, f"任务“{row.title}”已变化，不能自动撤销")
                await db.delete(row)
                await emit(
                    db,
                    user_id=user_id,
                    goal_id=row.goal_id,
                    aggregate_type="task",
                    aggregate_id=row.id,
                    event_type="AgentTaskChangeUndone",
                    source="ai_agent",
                    correlation_id=operation.source_step_id,
                    idempotency_key=f"agent-operation:{operation.operation_id}:undo",
                    payload={"undo": "create", "aggregate_version": row.version},
                )
                reverted.append(row.id)
            continue
        if operation.field == "__delete__":
            snapshot = dict(operation.before or {})
            goal = (
                await db.execute(
                    select(Goal).where(Goal.id == snapshot.get("goal_id"), Goal.user_id == user_id)
                )
            ).scalar_one_or_none()
            if not goal:
                raise HTTPException(409, "原目标已不存在，不能恢复任务")
            if not await db.get(Task, operation.entity_id):
                restored_task = Task(
                    id=operation.entity_id,
                    goal_id=snapshot["goal_id"],
                    plan_id=snapshot.get("plan_id"),
                    title=snapshot["title"],
                    description=snapshot.get("description"),
                    estimated_mins=snapshot["estimated_mins"],
                    actual_mins=snapshot.get("actual_mins"),
                    status=snapshot["status"],
                    priority=snapshot["priority"],
                    scheduled_date=snapshot["scheduled_date"],
                    mastery_level=snapshot.get("mastery_level", "unknown"),
                    type=snapshot.get("type", "study"),
                    kb_refs=snapshot.get("kb_refs", []),
                    stage_label=snapshot.get("stage_label"),
                    sequence_in_plan=snapshot.get("sequence_in_plan"),
                    completed_at=(
                        datetime.fromisoformat(snapshot["completed_at"])
                        if snapshot.get("completed_at")
                        else None
                    ),
                    version=int(snapshot.get("version", 1)),
                )
                db.add(restored_task)
                await db.flush()
                # Some deployments apply a server default of 1 on INSERT;
                # never let Undo lower the observable aggregate version.
                original_version = int(snapshot.get("version", 1))
                if restored_task.version < original_version:
                    restored_task.version = original_version
                    await db.flush()
                await emit(
                    db,
                    user_id=user_id,
                    goal_id=snapshot["goal_id"],
                    aggregate_type="task",
                    aggregate_id=operation.entity_id,
                    event_type="AgentTaskChangeUndone",
                    source="ai_agent",
                    correlation_id=operation.source_step_id,
                    idempotency_key=f"agent-operation:{operation.operation_id}:undo",
                    payload={"undo": "delete", "aggregate_version": snapshot.get("version", 1)},
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
        expected_version = operation.precondition.get("version")
        if expected_version is not None and task.version != int(expected_version) + 1:
            raise HTTPException(409, f"任务“{task.title}”版本已变化，不能自动撤销")
        if current != operation.after:
            raise HTTPException(409, f"任务“{task.title}”已再次变化，不能自动撤销")
        setattr(task, operation.field, operation.before)
        if operation.field == "status":
            task.completed_at = None
        await emit(
            db,
            user_id=user_id,
            goal_id=task.goal_id,
            aggregate_type="task",
            aggregate_id=task.id,
            event_type="AgentTaskChangeUndone",
            source="ai_agent",
            correlation_id=operation.source_step_id,
            idempotency_key=f"agent-operation:{operation.operation_id}:undo",
            payload={
                "field": operation.field,
                "before": operation.after,
                "after": operation.before,
                "aggregate_version": task.version + 1,
            },
        )
        reverted.append(task.id)
    if commit:
        await db.commit()
    else:
        await db.flush()
    return {"reverted": reverted, "count": len(reverted)}
