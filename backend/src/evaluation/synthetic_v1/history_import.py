"""Deterministic 60-day historical fact importer for the synthetic-v1 cohort.

This is an evaluation-only adapter.  It writes domain facts and the same semantic
LearningEvent records emitted by production services; it never writes learner
profiles, patterns, insights, Pilo suggestions, action runs, or hidden oracle data.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Iterable

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.evaluation.synthetic_v1.clock import SimulationClock
from src.evaluation.synthetic_v1.schemas import BehaviorPolicyV1, SyntheticPersonaV1
from src.intelligence.cognitive_model import CognitiveProfileBuilder
from src.intelligence.event_processor import process_event
from src.intelligence.profile_builder import ProfileBuilder
from src.models import (
    CheckinRecord,
    Goal,
    GoalVersion,
    IntelligenceCursor,
    LearningEvent,
    Task,
    TaskMasteryRecord,
    User,
    UserDataConsent,
)
from src.services.goal_service import GoalCreate

GENERATOR_VERSION = "synthetic-generator-v1"
BEHAVIOR_VERSION = "behavior-policy-v1"
EMAIL_DOMAIN = "synthetic.planpilot.invalid"
GOAL_TYPES = ("exam", "certification", "skill", "reading", "language", "habit")
GOAL_STATUSES = ("active", "paused", "completed", "abandoned")


def stable_id(run_id: str, *parts: object) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, ":".join(("planpilot", run_id, *map(str, parts)))))


def synthetic_email(run_id: str, index: int) -> str:
    slug = hashlib.sha256(run_id.encode()).hexdigest()[:10]
    return f"synthetic-{slug}-{index:02d}@{EMAIL_DOMAIN}"


@dataclass(slots=True)
class GeneratedUser:
    persona_id: str
    user_id: str
    email: str
    goal_ids: list[str]


def _naive_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=None)


def _status_sequence(persona: SyntheticPersonaV1) -> list[str]:
    remaining = persona.historical_goal_count - persona.active_goal_count
    return (
        ["active"] * persona.active_goal_count
        + ["paused"]
        + ["completed"] * (remaining - 2)
        + ["abandoned"]
    )


def _goal_title(persona: SyntheticPersonaV1, goal_type: str, index: int) -> str:
    labels = {
        "exam": "备考冲刺",
        "certification": "职业认证",
        "skill": "技能训练",
        "reading": "阅读计划",
        "language": "语言提升",
        "habit": "习惯养成",
    }
    # Intentional same-name goals for ownership/scope ambiguity coverage.
    if "same_name_entities" in persona.interaction_features and index in {0, 1}:
        return "我的学习计划"
    return f"{labels[goal_type]} {index + 1}"


async def import_longitudinal_history(
    db: AsyncSession,
    *,
    run_id: str,
    personas: Iterable[SyntheticPersonaV1],
    clock: SimulationClock,
) -> list[GeneratedUser]:
    personas = list(personas)
    if len(personas) != 30:
        raise ValueError("synthetic-v1 requires exactly 30 personas")
    existing = await db.scalar(
        select(func.count(User.id)).where(User.email.like(f"%@{EMAIL_DOMAIN}"))
    )
    if existing:
        raise RuntimeError("synthetic accounts already exist; use a fresh run_id or exact cleanup")

    generated: list[GeneratedUser] = []
    for user_index, persona in enumerate(personas, start=1):
        user_id = stable_id(run_id, "user", persona.persona_id)
        email = synthetic_email(run_id, user_index)
        user = User(
            id=user_id,
            email=email,
            username=f"synthetic_{hashlib.sha256(run_id.encode()).hexdigest()[:6]}_{user_index:02d}",
            hashed_password="evaluation-only-no-login",
            email_verified=True,
            is_active=True,
            is_admin=False,
            timezone=clock.timezone,
            language="zh-CN",
            onboarding_completed=True,
            created_at=_naive_utc(clock.utc_at(0, hour=8)),
        )
        db.add(user)
        db.add(
            UserDataConsent(
                user_id=user_id,
                personalization_enabled=persona.personalization_consent,
                experiments_enabled=True,
                product_analytics_enabled=True,
                sensitive_inference_enabled=(
                    persona.personalization_consent and persona.sensitive_inference_consent
                ),
                policy_version="2026-08",
                updated_at=_naive_utc(clock.utc_at(0, hour=8, minute=1)),
            )
        )
        await db.flush()

        goal_ids: list[str] = []
        active_goals: list[Goal] = []
        policy = BehaviorPolicyV1.from_persona(persona)
        goal_types = [
            persona.primary_scenario.value,
            *(scenario.value for scenario in persona.secondary_scenarios),
        ]
        while len(goal_types) < persona.historical_goal_count:
            goal_types.append(GOAL_TYPES[(user_index + len(goal_types)) % len(GOAL_TYPES)])
        for goal_index, (goal_type, status) in enumerate(
            zip(goal_types[: persona.historical_goal_count], _status_sequence(persona))
        ):
            created_day = goal_index % 6
            deadline_days = 35 + goal_index * 7
            payload = {
                "type": goal_type,
                "title": _goal_title(persona, goal_type, goal_index),
                "deadline": clock.deadline_after(created_day, deadline_days).isoformat(),
                "daily_hours": round(persona.weekly_capacity_hours / 7, 2),
                "current_level": persona.proficiency,
                "work_schedule": "weekday" if persona.weekly_capacity_hours <= 13 else "all",
                "meta": {},
            }
            validated = GoalCreate.for_evaluation(
                payload, validation_today=clock.date_at(created_day)
            )
            goal_id = stable_id(run_id, "goal", persona.persona_id, goal_index)
            created_at = _naive_utc(clock.utc_at(created_day, hour=9))
            goal = Goal(
                id=goal_id,
                user_id=user_id,
                type=validated.type,
                title=validated.title,
                deadline=validated.deadline,
                daily_hours=validated.daily_hours,
                current_level=validated.current_level,
                work_schedule=validated.work_schedule,
                meta={},
                status=status,
                created_at=created_at,
                updated_at=created_at,
            )
            db.add(goal)
            db.add(
                GoalVersion(
                    goal_id=goal_id,
                    version=1,
                    title_snapshot=goal.title,
                    constraints_snapshot={
                        "deadline": goal.deadline,
                        "daily_hours": goal.daily_hours,
                    },
                    change_reason="created",
                    created_by="user",
                    created_at=created_at,
                )
            )
            db.add(
                _event(
                    run_id,
                    user_id,
                    goal_id,
                    "goal",
                    goal_id,
                    "GoalCreated",
                    created_at,
                    {
                        "title": goal.title,
                        "type": goal.type,
                        "deadline": goal.deadline,
                        "daily_hours": goal.daily_hours,
                        "current_level": goal.current_level,
                        "work_schedule": goal.work_schedule,
                        "aggregate_version": 1,
                    },
                    f"goal-created-{goal_index}",
                )
            )
            if status != "active":
                changed_day = min(50, 20 + goal_index * 4)
                changed_at = _naive_utc(clock.utc_at(changed_day, hour=18))
                db.add(
                    _event(
                        run_id,
                        user_id,
                        goal_id,
                        "goal",
                        goal_id,
                        "GoalStatusChanged",
                        changed_at,
                        {"from_status": "active", "to_status": status, "aggregate_version": 2},
                        f"goal-status-{goal_index}",
                    )
                )
            else:
                active_goals.append(goal)
            goal_ids.append(goal_id)
        await db.flush()
        await _generate_daily_facts(
            db, run_id, user_index, persona, policy, user_id, active_goals, clock
        )
        await _generate_inactive_goal_facts(
            db, run_id, persona, policy, user_id, goal_ids, active_goals, clock
        )
        await db.commit()
        generated.append(GeneratedUser(persona.persona_id, user_id, email, goal_ids))
    return generated


def _event(
    run_id: str,
    user_id: str,
    goal_id: str | None,
    aggregate_type: str,
    aggregate_id: str,
    event_type: str,
    occurred_at: datetime,
    payload: dict[str, Any],
    key: str,
) -> LearningEvent:
    return LearningEvent(
        id=stable_id(run_id, "event", user_id, key),
        user_id=user_id,
        goal_id=goal_id,
        aggregate_type=aggregate_type,
        aggregate_id=aggregate_id,
        event_type=event_type,
        source="user_action",
        payload=payload,
        occurred_at=occurred_at,
        created_at=occurred_at,
        version=1,
        idempotency_key=f"synthetic-v1:{run_id}:{user_id}:{key}",
    )


async def _generate_daily_facts(
    db: AsyncSession,
    run_id: str,
    user_index: int,
    persona: SyntheticPersonaV1,
    policy: BehaviorPolicyV1,
    user_id: str,
    active_goals: list[Goal],
    clock: SimulationClock,
) -> None:
    backlog: list[Task] = []
    weekly_used: dict[int, int] = {}
    task_seq = 0
    for day in range(clock.history_days):
        rng = clock.rng(f"{persona.persona_id}:day:{day}")
        week = day // 7
        used = weekly_used.get(week, 0)
        overloaded = used >= policy.daily_capacity_minutes * 7
        sprint = day >= 60 - policy.deadline_sprint_days and persona.procrastination > 0.55
        active_p = policy.base_activation * (0.45 if overloaded else 1.0)
        if sprint:
            active_p = min(0.98, active_p + 0.25 + persona.procrastination * 0.15)
        if rng.random() >= active_p:
            continue
        goal = active_goals[(day + user_index) % len(active_goals)]
        hour = policy.preferred_hour
        timestamp = _naive_utc(clock.utc_at(day, hour=hour, minute=(user_index * 7) % 55))

        if backlog and rng.random() < policy.recovery_probability:
            task = backlog.pop(0)
            estimated = task.estimated_mins
        else:
            estimated = [20, 30, 45, 60, 90][(day + user_index) % 5]
            task_id = stable_id(run_id, "task", persona.persona_id, task_seq)
            title = (
                "复习"
                if "same_name_entities" in persona.interaction_features and task_seq % 5 == 0
                else f"{goal.title} · 第{task_seq + 1}步"
            )
            task = Task(
                id=task_id,
                goal_id=goal.id,
                title=title,
                estimated_mins=estimated,
                status="pending",
                scheduled_date=clock.date_at(day).isoformat(),
                priority="high" if sprint else "medium",
                mastery_level="unknown",
                created_at=timestamp,
                updated_at=timestamp,
            )
            db.add(task)
            db.add(
                _event(
                    run_id,
                    user_id,
                    goal.id,
                    "task",
                    task_id,
                    "TaskCreated",
                    timestamp,
                    {
                        "title": title,
                        "scheduled_date": task.scheduled_date,
                        "estimated_mins": estimated,
                        "priority": task.priority,
                        "aggregate_version": 1,
                    },
                    f"task-created-{task_seq}",
                )
            )
            task_seq += 1

        action_roll = rng.random()
        if action_roll < policy.skip_probability:
            task.status = "skipped"
            db.add(
                _event(
                    run_id,
                    user_id,
                    goal.id,
                    "task",
                    task.id,
                    "TaskSkipped",
                    timestamp,
                    {
                        "scheduled_date": task.scheduled_date,
                        "reason": "capacity_conflict" if overloaded else "user_skipped",
                    },
                    f"task-skipped-{task.id}-{day}",
                )
            )
        elif action_roll < policy.skip_probability + policy.reschedule_probability:
            old_date = task.scheduled_date
            task.scheduled_date = (
                clock.date_at(day) + timedelta(days=1 + rng.randrange(4))
            ).isoformat()
            task.status = "pending"
            backlog.append(task)
            db.add(
                _event(
                    run_id,
                    user_id,
                    goal.id,
                    "task",
                    task.id,
                    "TaskRescheduled",
                    timestamp,
                    {
                        "from_date": old_date,
                        "to_date": task.scheduled_date,
                        "trigger": "debt_rollover" if overloaded else "user_manual",
                    },
                    f"task-rescheduled-{task.id}-{day}",
                )
            )
        elif rng.random() < policy.completion_given_start:
            ratio = max(0.25, policy.actual_to_estimated_ratio * rng.uniform(0.88, 1.12))
            actual = max(5, round(estimated * ratio))
            level = "L4" if rng.random() < 0.22 else ("L3" if rng.random() < 0.65 else "L2")
            task.status = "completed"
            task.actual_mins = actual
            task.mastery_level = level
            task.completed_at = timestamp
            scheduled = date.fromisoformat(task.scheduled_date)
            days_overdue = max(0, (clock.date_at(day) - scheduled).days)
            db.add(
                _event(
                    run_id,
                    user_id,
                    goal.id,
                    "task",
                    task.id,
                    "TaskCompleted",
                    timestamp,
                    {
                        "scheduled_date": task.scheduled_date,
                        "completed_at": timestamp.isoformat(),
                        "actual_mins": actual,
                        "estimated_mins": estimated,
                        "mastery_level": level,
                        "days_overdue": days_overdue,
                    },
                    f"task-completed-{task.id}-{day}",
                )
            )
            db.add(
                TaskMasteryRecord(
                    id=stable_id(run_id, "mastery", task.id, day),
                    task_id=task.id,
                    goal_id=goal.id,
                    user_id=user_id,
                    mastery_level=level,
                    source="checkin_submission",
                    created_at=timestamp,
                )
            )
            db.add(
                _event(
                    run_id,
                    user_id,
                    goal.id,
                    "task",
                    task.id,
                    "MasteryRecorded",
                    timestamp,
                    {"from_level": "unknown", "to_level": level, "source": "checkin_submission"},
                    f"mastery-{task.id}-{day}",
                )
            )
            weekly_used[week] = used + actual
        else:
            task.status = "in_progress"

        if rng.random() < policy.checkin_probability:
            completion = (
                1.0
                if task.status == "completed"
                else (0.5 if task.status == "in_progress" else 0.0)
            )
            checkin_id = stable_id(run_id, "checkin", user_id, goal.id, day)
            db.add(
                CheckinRecord(
                    id=checkin_id,
                    goal_id=goal.id,
                    user_id=user_id,
                    date=clock.date_at(day).isoformat(),
                    mode="daily",
                    completion_rate=completion,
                    stats={
                        "total_tasks": 1,
                        "completed": int(task.status == "completed"),
                        "skipped": int(task.status == "skipped"),
                        "completion_rate": completion,
                        "actual_mins": task.actual_mins or 0,
                    },
                    duration_mins=task.actual_mins,
                    created_at=timestamp,
                )
            )
            db.add(
                _event(
                    run_id,
                    user_id,
                    goal.id,
                    "checkin",
                    checkin_id,
                    "CheckinSubmitted",
                    timestamp,
                    {
                        "date": clock.date_at(day).isoformat(),
                        "completion_rate": completion,
                        "total_tasks": 1,
                        "completed_count": int(task.status == "completed"),
                        "time_investment_mins": task.actual_mins or 0,
                        "mastery_rate": 1.0 if task.mastery_level in {"L3", "L4"} else 0.0,
                    },
                    f"checkin-{goal.id}-{day}",
                )
            )


async def _generate_inactive_goal_facts(
    db: AsyncSession,
    run_id: str,
    persona: SyntheticPersonaV1,
    policy: BehaviorPolicyV1,
    user_id: str,
    goal_ids: list[str],
    active_goals: list[Goal],
    clock: SimulationClock,
) -> None:
    active_ids = {g.id for g in active_goals}
    for index, goal_id in enumerate(gid for gid in goal_ids if gid not in active_ids):
        created = _naive_utc(clock.utc_at(5 + index % 5, hour=policy.preferred_hour))
        task_id = stable_id(run_id, "historical-task", persona.persona_id, index)
        completed = index % 3 != 0
        actual = 25 + (index % 4) * 10 if completed else None
        task = Task(
            id=task_id,
            goal_id=goal_id,
            title=f"历史任务 {index + 1}",
            estimated_mins=30 + (index % 3) * 15,
            actual_mins=actual,
            status="completed" if completed else "abandoned",
            scheduled_date=clock.date_at(8 + index % 8).isoformat(),
            completed_at=created if completed else None,
            created_at=created,
            updated_at=created,
        )
        db.add(task)
        db.add(
            _event(
                run_id,
                user_id,
                goal_id,
                "task",
                task_id,
                "TaskCreated",
                created,
                {
                    "title": task.title,
                    "scheduled_date": task.scheduled_date,
                    "estimated_mins": task.estimated_mins,
                    "priority": "medium",
                },
                f"historical-task-created-{index}",
            )
        )
        if completed:
            db.add(
                _event(
                    run_id,
                    user_id,
                    goal_id,
                    "task",
                    task_id,
                    "TaskCompleted",
                    created,
                    {
                        "scheduled_date": task.scheduled_date,
                        "actual_mins": actual,
                        "estimated_mins": task.estimated_mins,
                        "mastery_level": "L2",
                        "days_overdue": 0,
                    },
                    f"historical-task-completed-{index}",
                )
            )


async def replay_run_events(
    db: AsyncSession,
    *,
    user_ids: list[str],
    batch_size: int = 250,
) -> dict[str, int | str | None]:
    """Replay only frozen cohort history without moving the global cursor."""
    if not user_ids:
        raise ValueError("user_ids must be the frozen manifest list")
    cursor = await db.scalar(
        select(IntelligenceCursor).where(IntelligenceCursor.consumer_name == "pattern_analyzer")
    )
    before = cursor.last_processed_at.isoformat() if cursor and cursor.last_processed_at else None
    disabled = select(UserDataConsent.user_id).where(
        UserDataConsent.personalization_enabled.is_(False)
    )
    events = list(
        (
            await db.execute(
                select(LearningEvent)
                .where(
                    LearningEvent.user_id.in_(user_ids),
                    LearningEvent.user_id.not_in(disabled),
                )
                .order_by(LearningEvent.created_at, LearningEvent.id)
            )
        ).scalars()
    )
    processed = 0
    for event in events:
        await process_event(db, event)
        processed += 1
        if processed % batch_size == 0:
            await db.commit()
    await db.commit()
    cursor = await db.scalar(
        select(IntelligenceCursor).where(IntelligenceCursor.consumer_name == "pattern_analyzer")
    )
    after = cursor.last_processed_at.isoformat() if cursor and cursor.last_processed_at else None
    if before != after:
        raise RuntimeError("scoped historical replay moved the global IntelligenceCursor")
    return {
        "event_count": len(events),
        "processed": processed,
        "cursor_before": before,
        "cursor_after": after,
    }


async def build_profiles(
    db: AsyncSession, *, user_ids: list[str], as_of: datetime
) -> dict[str, int]:
    for user_id in user_ids:
        await ProfileBuilder.build_for_user(db, user_id, window_days=30, as_of=as_of)
        await CognitiveProfileBuilder.build_for_user(db, user_id, window_days=90, as_of=as_of)
    await db.commit()
    return {"users": len(user_ids)}
