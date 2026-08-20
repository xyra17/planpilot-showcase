from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import CheckinRecord, Goal, Task


async def assert_goal_access(db: AsyncSession, user_id: str, goal_id: str | None) -> Goal | None:
    if not goal_id:
        return None
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
    ).scalar_one_or_none()
    if not goal:
        raise HTTPException(404, "目标不存在或无权访问")
    return goal


async def load_learning_context(
    db: AsyncSession,
    user_id: str,
    *,
    goal_id: str | None = None,
    lookback_days: int = 14,
) -> dict[str, Any]:
    await assert_goal_access(db, user_id, goal_id)
    goals_stmt = select(Goal).where(Goal.user_id == user_id)
    if goal_id:
        goals_stmt = goals_stmt.where(Goal.id == goal_id)
    goals = (await db.execute(goals_stmt.order_by(Goal.created_at))).scalars().all()
    goal_ids = [goal.id for goal in goals]
    if not goal_ids:
        return {"goals": [], "tasks": [], "checkins": [], "lookback_days": lookback_days}

    since = (date.today() - timedelta(days=lookback_days - 1)).isoformat()
    tasks = (
        (
            await db.execute(
                select(Task)
                .where(Task.goal_id.in_(goal_ids))
                .order_by(Task.scheduled_date, Task.created_at)
            )
        )
        .scalars()
        .all()
    )
    checkins = (
        (
            await db.execute(
                select(CheckinRecord)
                .where(
                    CheckinRecord.user_id == user_id,
                    CheckinRecord.goal_id.in_(goal_ids),
                    CheckinRecord.date >= since,
                )
                .order_by(CheckinRecord.date)
            )
        )
        .scalars()
        .all()
    )
    return {
        "lookback_days": lookback_days,
        "goals": [
            {
                "id": goal.id,
                "title": goal.title,
                "deadline": goal.deadline,
                "daily_hours": goal.daily_hours,
                "status": goal.status,
                "version": goal.version,
            }
            for goal in goals
        ],
        "tasks": [
            {
                "id": task.id,
                "goal_id": task.goal_id,
                "title": task.title,
                "description": task.description,
                "date": task.scheduled_date,
                "status": task.status,
                "estimated_minutes": task.estimated_mins,
                "priority": task.priority,
                "mastery_level": task.mastery_level,
                "version": task.version,
            }
            for task in tasks
        ],
        "checkins": [
            {
                "goal_id": row.goal_id,
                "date": row.date,
                "completion_rate": row.completion_rate,
                "status": row.quick_status,
            }
            for row in checkins
        ],
    }


def summarize_execution(context: dict[str, Any]) -> dict[str, Any]:
    today = date.today().isoformat()
    tasks = context["tasks"]
    recent_start = (date.today() - timedelta(days=context["lookback_days"] - 1)).isoformat()
    recent = [task for task in tasks if recent_start <= task["date"] <= today]
    completed = [task for task in recent if task["status"] == "completed"]
    overdue = [task for task in tasks if task["date"] < today and task["status"] != "completed"]
    pending = [task for task in tasks if task["status"] != "completed"]
    completion_rate = round(len(completed) / len(recent) * 100) if recent else 100
    return {
        "period": {"from": recent_start, "to": today},
        "scheduled_count": len(recent),
        "completed_count": len(completed),
        "completion_rate": completion_rate,
        "overdue_count": len(overdue),
        "pending_count": len(pending),
        "overdue_tasks": overdue,
        "needs_attention": completion_rate < 70 or bool(overdue),
    }
