from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.agent_v2.schemas import ChangeSet
from src.models import CheckinRecord, Goal, Task


async def verify_task_changes(db: AsyncSession, user_id: str, change_set: ChangeSet) -> dict:
    mismatches: list[dict[str, str]] = []
    for operation in change_set.operations:
        if operation.entity == "checkin":
            expected = dict(operation.after or {})
            row = await db.scalar(
                select(CheckinRecord)
                .join(Goal, CheckinRecord.goal_id == Goal.id)
                .where(CheckinRecord.id == operation.entity_id, Goal.user_id == user_id)
            )
            ok = bool(
                row
                and row.date == expected.get("date")
                and row.completion_rate == expected.get("completion_rate")
                and row.natural_text == expected.get("natural_text")
            )
            if not ok:
                mismatches.append(
                    {
                        "entity_id": operation.entity_id,
                        "expected": str(operation.after),
                        "actual": "recorded" if row else "missing",
                    }
                )
            continue
        if operation.entity == "goal":
            goal = await db.scalar(
                select(Goal).where(Goal.id == operation.entity_id, Goal.user_id == user_id)
            )
            if operation.field == "__create__":
                expected = dict(operation.after or {})
                ok = bool(
                    goal
                    and goal.title == expected.get("title")
                    and goal.deadline == expected.get("deadline")
                )
                actual_value = "created" if goal else "missing"
            else:
                actual_value = getattr(goal, operation.field, None) if goal else None
                ok = goal is not None and actual_value == operation.after
            if not ok:
                mismatches.append(
                    {
                        "entity_id": operation.entity_id,
                        "expected": str(operation.after),
                        "actual": str(actual_value) if goal else "missing",
                    }
                )
            continue
        row = (
            await db.execute(
                select(Task)
                .join(Goal, Task.goal_id == Goal.id)
                .where(Task.id == operation.entity_id, Goal.user_id == user_id)
            )
        ).scalar_one_or_none()
        if operation.field == "__delete__":
            ok = row is None
            actual = "deleted" if row is None else "present"
        elif operation.field == "__create__":
            expected = dict(operation.after or {})
            ok = bool(
                row
                and row.goal_id == expected.get("goal_id")
                and row.title == expected.get("title")
                and row.scheduled_date == expected.get("scheduled_date")
            )
            actual = "created" if row else "missing"
        else:
            actual_value = getattr(row, operation.field, None) if row else None
            ok = row is not None and actual_value == operation.after
            actual = str(actual_value) if row else "missing"
        if not ok:
            mismatches.append(
                {
                    "entity_id": operation.entity_id,
                    "expected": str(operation.after),
                    "actual": actual,
                }
            )
    return {"verified": not mismatches, "mismatches": mismatches}
