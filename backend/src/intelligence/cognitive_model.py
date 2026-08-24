"""Learner cognitive profile calculation and forgetting-curve utilities."""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import distinct, not_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.privacy_fields import SENSITIVE_INFERENCE_FIELDS
from src.core.time import utc_now
from src.models import (
    DecisionProposal,
    Goal,
    LearnerCognitiveProfile,
    LearnerProfile,
    LearningEvent,
    ProposalFeedback,
    Task,
    TaskMasteryRecord,
    UserDataConsent,
)

DEFAULT_WINDOW_DAYS = 90
MASTERY_STRENGTH = {"unknown": 0.1, "L0": 0.1, "L1": 0.25, "L2": 0.5, "L3": 0.75, "L4": 1.0}
COGNITIVE_FIELDS = (
    "learning_speed",
    "retention_rate",
    "forgetting_rate",
    "transfer_score",
    "persistence_score",
    "procrastination_score",
    "recovery_score",
    "difficulty_preference",
    "challenge_tolerance",
    "feedback_acceptance",
)


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def knowledge_retention(
    initial_score: float,
    forgetting_rate: float,
    elapsed_days: float,
) -> float:
    """Exponential forgetting curve, clamped for API safety."""
    return round(
        clamp(initial_score) * math.exp(-max(0.0, forgetting_rate) * max(0.0, elapsed_days)), 4
    )


def retention_curve(
    initial_score: float,
    forgetting_rate: float,
    *,
    days: tuple[int, ...] = (0, 1, 3, 7, 14, 30),
) -> list[dict[str, float | int]]:
    return [
        {"day": day, "retention": knowledge_retention(initial_score, forgetting_rate, day)}
        for day in days
    ]


class CognitiveProfileBuilder:
    @classmethod
    async def build_for_user(
        cls,
        db: AsyncSession,
        user_id: str,
        *,
        window_days: int = DEFAULT_WINDOW_DAYS,
        as_of: datetime | None = None,
    ) -> dict[str, int]:
        consent = await db.get(UserDataConsent, user_id)
        if consent is not None and not consent.personalization_enabled:
            return {"goal_count": 0}
        sensitive_enabled = bool(consent and consent.sensitive_inference_enabled)
        now = as_of or utc_now()
        goals = list(
            (
                await db.execute(
                    select(Goal).where(Goal.user_id == user_id, Goal.status == "active")
                )
            ).scalars()
        )
        await cls._build_scope(
            db,
            user_id,
            None,
            now=now,
            window_days=window_days,
            sensitive_enabled=sensitive_enabled,
        )
        for goal in goals:
            await cls._build_scope(
                db,
                user_id,
                goal.id,
                now=now,
                window_days=window_days,
                sensitive_enabled=sensitive_enabled,
            )
        await db.flush()
        return {"goal_count": len(goals)}

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
            ).scalars()
        )
        for user_id in user_ids:
            await cls.build_for_user(db, user_id, window_days=window_days)
        return len(user_ids)

    @staticmethod
    async def get_profile(
        db: AsyncSession, user_id: str, goal_id: str | None
    ) -> LearnerCognitiveProfile | None:
        stmt = select(LearnerCognitiveProfile).where(LearnerCognitiveProfile.user_id == user_id)
        stmt = stmt.where(
            LearnerCognitiveProfile.goal_id == goal_id
            if goal_id is not None
            else LearnerCognitiveProfile.goal_id.is_(None)
        )
        return (await db.execute(stmt)).scalar_one_or_none()

    @classmethod
    async def _build_scope(
        cls,
        db: AsyncSession,
        user_id: str,
        goal_id: str | None,
        *,
        now: datetime,
        window_days: int,
        sensitive_enabled: bool,
    ) -> LearnerCognitiveProfile:
        since = now - timedelta(days=window_days)
        event_stmt = select(LearningEvent).where(
            LearningEvent.user_id == user_id,
            LearningEvent.occurred_at >= since,
            LearningEvent.occurred_at <= now,
        )
        task_stmt = select(Task).join(Goal, Task.goal_id == Goal.id).where(Goal.user_id == user_id)
        mastery_stmt = (
            select(TaskMasteryRecord)
            .where(TaskMasteryRecord.user_id == user_id, TaskMasteryRecord.created_at >= since)
            .order_by(TaskMasteryRecord.task_id, TaskMasteryRecord.created_at)
        )
        proposal_stmt = select(DecisionProposal).where(
            DecisionProposal.user_id == user_id,
            DecisionProposal.created_at >= since,
        )
        profile_stmt = select(LearnerProfile).where(LearnerProfile.user_id == user_id)
        if goal_id is None:
            profile_stmt = profile_stmt.where(LearnerProfile.goal_id.is_(None))
        else:
            event_stmt = event_stmt.where(LearningEvent.goal_id == goal_id)
            task_stmt = task_stmt.where(Task.goal_id == goal_id)
            mastery_stmt = mastery_stmt.where(TaskMasteryRecord.goal_id == goal_id)
            proposal_stmt = proposal_stmt.where(DecisionProposal.goal_id == goal_id)
            profile_stmt = profile_stmt.where(LearnerProfile.goal_id == goal_id)

        events = list((await db.execute(event_stmt)).scalars())
        tasks = list((await db.execute(task_stmt)).scalars())
        mastery = list((await db.execute(mastery_stmt)).scalars())
        proposals = list((await db.execute(proposal_stmt)).scalars())
        profile = (await db.execute(profile_stmt)).scalar_one_or_none()
        feedback: list[ProposalFeedback] = []
        if sensitive_enabled and proposals:
            feedback = list(
                (
                    await db.execute(
                        select(ProposalFeedback).where(
                            ProposalFeedback.proposal_id.in_([row.id for row in proposals])
                        )
                    )
                ).scalars()
            )

        metrics = cls._calculate(
            events,
            tasks,
            mastery,
            proposals,
            feedback,
            profile,
            now,
            sensitive_enabled=sensitive_enabled,
        )
        evidence_times = [row.occurred_at for row in events if row.occurred_at]
        observed_span_days = (
            float((max(evidence_times).date() - min(evidence_times).date()).days + 1)
            if evidence_times
            else 0.0
        )
        # A 60-day history cannot justify 90-day confidence.  Keep supported
        # metrics, but calibrate confidence to the actually observed span.
        metrics["confidence"] = round(
            min(float(metrics["confidence"]), observed_span_days / max(1, window_days)), 4
        )
        row = await cls.get_profile(db, user_id, goal_id)
        if row is None:
            row = LearnerCognitiveProfile(user_id=user_id, goal_id=goal_id)
            db.add(row)
        for field in COGNITIVE_FIELDS:
            setattr(
                row,
                field,
                metrics[field]
                if sensitive_enabled or field not in SENSITIVE_INFERENCE_FIELDS
                else None,
            )
        row.observation_window_days = window_days
        row.sample_count = metrics["sample_count"]
        row.confidence = metrics["confidence"]
        row.last_computed_at = now
        row.updated_at = now
        return row

    @staticmethod
    def _calculate(
        events: list[LearningEvent],
        tasks: list[Task],
        mastery: list[TaskMasteryRecord],
        proposals: list[DecisionProposal],
        feedback: list[ProposalFeedback],
        profile: LearnerProfile | None,
        now: datetime,
        *,
        sensitive_enabled: bool = False,
    ) -> dict[str, float | int | None]:
        completed = [task for task in tasks if task.status == "completed"]
        attempted = [task for task in tasks if task.status not in {"abandoned"}]
        completed_rate = len(completed) / len(attempted) if attempted else None

        mastery_by_task: dict[str, list[TaskMasteryRecord]] = defaultdict(list)
        for row in mastery:
            mastery_by_task[row.task_id].append(row)
        drops = 0
        transitions = 0
        for rows in mastery_by_task.values():
            for before, after in zip(rows, rows[1:]):
                transitions += 1
                if MASTERY_STRENGTH.get(after.mastery_level, 0.1) < MASTERY_STRENGTH.get(
                    before.mastery_level, 0.1
                ):
                    drops += 1
        forgetting_rate = clamp(
            0.04 + (drops / transitions if transitions else 0.0) * 0.1, 0.02, 0.18
        )
        latest_mastery = [rows[-1] for rows in mastery_by_task.values() if rows]
        retained = [
            knowledge_retention(
                MASTERY_STRENGTH.get(row.mastery_level, 0.1),
                forgetting_rate,
                (now - row.created_at).total_seconds() / 86400 if row.created_at else 0,
            )
            for row in latest_mastery
        ]

        negative_by_task: dict[str, datetime] = {}
        recovered: set[str] = set()
        for event in sorted(events, key=lambda row: row.occurred_at):
            if event.event_type in {"TaskSkipped", "TaskRescheduled"}:
                negative_by_task[event.aggregate_id] = event.occurred_at
            elif event.event_type == "TaskCompleted" and event.aggregate_id in negative_by_task:
                recovered.add(event.aggregate_id)

        mastery_goal_count = len(
            {row.goal_id for row in mastery if MASTERY_STRENGTH.get(row.mastery_level, 0.1) >= 0.75}
        )
        goal_count = len({task.goal_id for task in tasks})
        session_reference = (
            profile.avg_session_duration_mins
            if profile and profile.avg_session_duration_mins
            else 45.0
        )
        avg_completed_mins = (
            sum(task.estimated_mins for task in completed) / len(completed) if completed else None
        )
        sample_count = len(events) + len(mastery) + len(feedback)
        velocity = profile.mastery_velocity if profile else None
        sensitive_metrics = (
            CognitiveProfileBuilder._calculate_sensitive_metrics(
                events,
                attempted,
                proposals,
                feedback,
                profile,
                completed_rate,
            )
            if sensitive_enabled
            else {}
        )
        return {
            "learning_speed": clamp(float(velocity) / 5.0)
            if velocity is not None
            else completed_rate,
            "retention_rate": round(sum(retained) / len(retained), 4) if retained else None,
            "forgetting_rate": round(forgetting_rate, 4),
            "transfer_score": round(mastery_goal_count / goal_count, 4) if goal_count else None,
            "persistence_score": sensitive_metrics.get("persistence_score"),
            "procrastination_score": sensitive_metrics.get("procrastination_score"),
            "recovery_score": round(len(recovered) / len(negative_by_task), 4)
            if negative_by_task
            else None,
            "difficulty_preference": (
                round(clamp(avg_completed_mins / max(1.0, session_reference * 1.5)), 4)
                if avg_completed_mins is not None
                else None
            ),
            "challenge_tolerance": sensitive_metrics.get("challenge_tolerance"),
            "feedback_acceptance": sensitive_metrics.get("feedback_acceptance"),
            "sample_count": sample_count,
            "confidence": round(clamp(sample_count / (sample_count + 20)), 4),
        }

    @staticmethod
    def _calculate_sensitive_metrics(
        events: list[LearningEvent],
        attempted: list[Task],
        proposals: list[DecisionProposal],
        feedback: list[ProposalFeedback],
        profile: LearnerProfile | None,
        completed_rate: float | None,
    ) -> dict[str, float | None]:
        """Calculate opt-in behavioral tendencies only after consent is checked."""
        high_load = [task for task in attempted if task.estimated_mins >= 60]
        high_load_completed = sum(task.status == "completed" for task in high_load)
        reviewed = [row for row in proposals if row.status in {"accepted", "applied", "rejected"}]
        accepted = sum(row.status in {"accepted", "applied"} for row in reviewed)
        helpful = sum(row.outcome == "helpful" for row in feedback)
        feedback_acceptance = (
            clamp(
                0.7 * (accepted / len(reviewed))
                + 0.3 * (helpful / len(feedback) if feedback else 0.5)
            )
            if reviewed
            else None
        )
        event_negative = sum(row.event_type in {"TaskSkipped", "TaskRescheduled"} for row in events)
        procrastination = (
            profile.debt_tendency
            if profile and profile.debt_tendency is not None
            else event_negative / max(1, len(events))
        )
        return {
            "persistence_score": (
                profile.consistency_score
                if profile and profile.consistency_score is not None
                else completed_rate
            ),
            "procrastination_score": round(clamp(float(procrastination)), 4),
            "challenge_tolerance": round(high_load_completed / len(high_load), 4)
            if high_load
            else completed_rate,
            "feedback_acceptance": round(feedback_acceptance, 4)
            if feedback_acceptance is not None
            else None,
        }


def cognitive_profile_to_dict(
    profile: LearnerCognitiveProfile | None,
) -> dict[str, Any] | None:
    if profile is None:
        return None
    initial = profile.retention_rate if profile.retention_rate is not None else 1.0
    rate = profile.forgetting_rate if profile.forgetting_rate is not None else 0.05
    return {
        "id": profile.id,
        "goal_id": profile.goal_id,
        **{field: getattr(profile, field) for field in COGNITIVE_FIELDS},
        "observation_window_days": profile.observation_window_days,
        "sample_count": profile.sample_count,
        "confidence": profile.confidence,
        "retention_curve": retention_curve(initial, rate),
        "last_computed_at": profile.last_computed_at.isoformat()
        if profile.last_computed_at
        else None,
    }
