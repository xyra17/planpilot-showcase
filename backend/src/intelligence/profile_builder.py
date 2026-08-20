"""Learner Profile Builder — read patterns/events, compute metrics, upsert snapshots."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import distinct, not_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.intelligence.profile_metrics import calculate_profile_metrics
from src.models import Goal, LearnerPattern, LearnerProfile, LearningEvent, User, UserDataConsent

DEFAULT_WINDOW_DAYS = 30


class ProfileBuilder:
    """Builds user and goal snapshots without mutating LearnerPattern."""

    @classmethod
    async def build_for_user(
        cls,
        db: AsyncSession,
        user_id: str,
        *,
        window_days: int = DEFAULT_WINDOW_DAYS,
    ) -> dict[str, int]:
        now = utc_now()
        since = now - timedelta(days=window_days)

        patterns = list(
            (
                await db.execute(
                    select(LearnerPattern).where(
                        LearnerPattern.user_id == user_id,
                        LearnerPattern.status.in_(["active", "decayed"]),
                    )
                )
            )
            .scalars()
            .all()
        )
        events = list(
            (
                await db.execute(
                    select(LearningEvent)
                    .where(
                        LearningEvent.user_id == user_id,
                        LearningEvent.occurred_at >= since,
                    )
                    .order_by(LearningEvent.occurred_at.asc())
                )
            )
            .scalars()
            .all()
        )

        await cls._build_scope(
            db,
            user_id=user_id,
            goal_id=None,
            patterns=patterns,
            events=events,
            window_days=window_days,
            now=now,
        )

        goals = list(
            (await db.execute(select(Goal).where(Goal.user_id == user_id, Goal.status == "active")))
            .scalars()
            .all()
        )
        for goal in goals:
            goal_events = [event for event in events if event.goal_id == goal.id]
            await cls._build_scope(
                db,
                user_id=user_id,
                goal_id=goal.id,
                patterns=patterns,
                events=goal_events,
                window_days=window_days,
                now=now,
            )
        await db.flush()
        return {"goal_count": len(goals), "event_count": len(events)}

    @classmethod
    async def build_for_scope(
        cls,
        db: AsyncSession,
        user_id: str,
        scope: str,
        *,
        goal_id: str | None = None,
        window_days: int = DEFAULT_WINDOW_DAYS,
    ) -> LearnerProfile:
        if scope == "skill_category":
            raise NotImplementedError("skill_category scope is reserved for a future phase")
        if scope not in {"user", "goal"}:
            raise ValueError("scope must be user, goal, or skill_category")
        if scope == "goal" and not goal_id:
            raise ValueError("goal scope requires goal_id")

        await cls.build_for_user(db, user_id, window_days=window_days)
        profile = await cls.get_profile(db, user_id, goal_id if scope == "goal" else None)
        if profile is None:
            raise RuntimeError("profile build did not produce the requested scope")
        return profile

    @classmethod
    async def run_batch(cls, db: AsyncSession, *, window_days: int = DEFAULT_WINDOW_DAYS) -> int:
        since = utc_now() - timedelta(days=window_days)
        user_ids = list(
            (
                await db.execute(
                    select(distinct(LearningEvent.user_id)).where(
                        LearningEvent.occurred_at >= since,
                        not_(
                            LearningEvent.user_id.in_(
                                select(UserDataConsent.user_id).where(
                                    UserDataConsent.personalization_enabled.is_(False)
                                )
                            )
                        ),
                    )
                )
            )
            .scalars()
            .all()
        )
        for user_id in user_ids:
            await cls.build_for_user(db, user_id, window_days=window_days)
        return len(user_ids)

    @staticmethod
    async def get_profile(
        db: AsyncSession, user_id: str, goal_id: str | None
    ) -> LearnerProfile | None:
        stmt = select(LearnerProfile).where(LearnerProfile.user_id == user_id)
        stmt = stmt.where(
            LearnerProfile.goal_id == goal_id
            if goal_id is not None
            else LearnerProfile.goal_id.is_(None)
        )
        return (await db.execute(stmt)).scalar_one_or_none()

    @classmethod
    async def _build_scope(
        cls,
        db: AsyncSession,
        *,
        user_id: str,
        goal_id: str | None,
        patterns: list[LearnerPattern],
        events: list[LearningEvent],
        window_days: int,
        now: datetime,
    ) -> LearnerProfile:
        timezone_name = (
            await db.scalar(select(User.timezone).where(User.id == user_id)) or "Asia/Shanghai"
        )
        metrics = calculate_profile_metrics(
            patterns,
            events,
            goal_id=goal_id,
            window_days=window_days,
            timezone_name=timezone_name,
        )
        profile = await cls.get_profile(db, user_id, goal_id)
        if profile is None:
            profile = LearnerProfile(user_id=user_id, goal_id=goal_id)
            db.add(profile)
        for field, value in metrics.items():
            setattr(profile, field, value)
        profile.observation_window_days = window_days
        profile.event_count = len(events)
        profile.last_computed_at = now
        profile.updated_at = now
        return profile


PROFILE_FIELDS = (
    "consistency_score",
    "weekly_active_days",
    "avg_session_duration_mins",
    "avg_daily_investment_mins",
    "completion_rate_30d",
    "mastery_rate_30d",
    "mastery_velocity",
    "preferred_hour_start",
    "preferred_hour_end",
    "preferred_weekdays",
    "estimation_accuracy",
    "debt_tendency",
    "reschedule_rate",
)


def profile_to_dict(profile: LearnerProfile | None) -> dict[str, Any] | None:
    if profile is None:
        return None
    return {
        "id": profile.id,
        "user_id": profile.user_id,
        "goal_id": profile.goal_id,
        **{field: getattr(profile, field) for field in PROFILE_FIELDS},
        "observation_window_days": profile.observation_window_days,
        "event_count": profile.event_count,
        "last_computed_at": (
            profile.last_computed_at.isoformat() if profile.last_computed_at else None
        ),
    }
