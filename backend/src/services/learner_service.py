"""Application transaction boundary for learner profile and decision context."""

from __future__ import annotations

from time import monotonic
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.intelligence.cognitive_model import (
    CognitiveProfileBuilder,
    cognitive_profile_to_dict,
)
from src.intelligence.decision_context import DecisionContextBuilder
from src.intelligence.memory_system import MemoryService
from src.intelligence.profile_builder import ProfileBuilder, profile_to_dict
from src.models import Goal


async def rebuild_profile(user_id: str, db: AsyncSession) -> dict[str, int]:
    started = monotonic()
    result = await ProfileBuilder.build_for_user(db, user_id)
    cognitive = await CognitiveProfileBuilder.build_for_user(db, user_id)
    await db.commit()
    return {
        "processed_goals": result["goal_count"],
        "event_count": result["event_count"],
        "cognitive_goals": cognitive["goal_count"],
        "elapsed_ms": int((monotonic() - started) * 1000),
    }


async def get_profile(user_id: str, db: AsyncSession, *, goal_id: str | None) -> dict[str, Any]:
    if goal_id:
        owned = await db.scalar(select(Goal.id).where(Goal.id == goal_id, Goal.user_id == user_id))
        if owned is None:
            raise LookupError("goal does not exist")
    profile = await ProfileBuilder.get_profile(db, user_id, goal_id)
    return {"profile": profile_to_dict(profile), "scope": "goal" if goal_id else "user"}


async def get_decision_context(
    user_id: str, db: AsyncSession, *, goal_id: str | None
) -> dict[str, Any]:
    return await DecisionContextBuilder.build(db, user_id, goal_id=goal_id)


async def get_cognitive_profile(
    user_id: str, db: AsyncSession, *, goal_id: str | None
) -> dict[str, Any]:
    if goal_id:
        owned = await db.scalar(select(Goal.id).where(Goal.id == goal_id, Goal.user_id == user_id))
        if owned is None:
            raise LookupError("goal does not exist")
    profile = await CognitiveProfileBuilder.get_profile(db, user_id, goal_id)
    if profile is None and goal_id:
        profile = await CognitiveProfileBuilder.get_profile(db, user_id, None)
        scope = "user_fallback"
    else:
        scope = "goal" if goal_id else "user"
    return {"profile": cognitive_profile_to_dict(profile), "scope": scope}


async def get_memories(
    user_id: str,
    db: AsyncSession,
    *,
    goal_id: str | None,
    query: str | None,
    limit: int,
) -> dict[str, Any]:
    if goal_id:
        owned = await db.scalar(select(Goal.id).where(Goal.id == goal_id, Goal.user_id == user_id))
        if owned is None:
            raise LookupError("goal does not exist")
    return await MemoryService.get_relevant_memories(
        db, user_id, goal_id=goal_id, query=query, limit=limit
    )
