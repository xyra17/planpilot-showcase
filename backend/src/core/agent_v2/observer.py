from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.agent_v2.schemas import ChangeSet
from src.models import Goal, Task


async def verify_task_changes(
    db: AsyncSession, user_id: str, change_set: ChangeSet
) -> dict:
    mismatches: list[dict[str, str]] = []
    for operation in change_set.operations:
        row = (
            await db.execute(
                select(Task)
                .join(Goal, Task.goal_id == Goal.id)
                .where(Task.id == operation.entity_id, Goal.user_id == user_id)
            )
        ).scalar_one_or_none()
        if not row or row.scheduled_date != operation.after:
            mismatches.append(
                {
                    "entity_id": operation.entity_id,
                    "expected": str(operation.after),
                    "actual": row.scheduled_date if row else "missing",
                }
            )
    return {"verified": not mismatches, "mismatches": mismatches}
