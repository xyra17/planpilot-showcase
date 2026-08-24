"""Pure, daily causal behavior state machine for synthetic users."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .schemas import BehaviorPolicyV1, seeded_random


class DailyBehaviorState(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    interrupted: bool = False
    inactive_streak: int = Field(default=0, ge=0)
    backlog_minutes: int = Field(default=0, ge=0)
    cumulative_active_days: int = Field(default=0, ge=0)
    cumulative_completed_tasks: int = Field(default=0, ge=0)


class DailyBehaviorContext(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    simulation_date: date
    day_index: int = Field(ge=0)
    due_task_ids: tuple[str, ...] = ()
    estimated_minutes: tuple[int, ...] = ()
    days_to_deadline: int | None = None
    active_goal_id: str | None = None


class PlannedBehaviorEvent(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    event_type: Literal[
        "TaskStarted",
        "TaskCompleted",
        "TaskSkipped",
        "TaskRescheduled",
        "CheckinSubmitted",
        "MasteryRecorded",
        "GoalStatusChanged",
    ]
    task_id: str | None = None
    goal_id: str | None = None
    occurred_hour: int = Field(ge=0, le=23)
    payload: dict[str, Any] = Field(default_factory=dict)


class DailyBehaviorResult(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    state: DailyBehaviorState
    events: tuple[PlannedBehaviorEvent, ...] = ()


def advance_day(
    *,
    policy: BehaviorPolicyV1,
    previous: DailyBehaviorState,
    context: DailyBehaviorContext,
    seed: int,
) -> DailyBehaviorResult:
    """Advance one day using only inputs and a stable per-day random stream.

    Completion can only follow ``TaskStarted``.  Skips/reschedules can only
    refer to a due task.  Backlog changes as a consequence of those decisions,
    so longitudinal patterns emerge from transitions rather than target rates.
    """

    if len(context.due_task_ids) != len(context.estimated_minutes):
        raise ValueError("due_task_ids and estimated_minutes must have equal length")
    if any(minutes <= 0 for minutes in context.estimated_minutes):
        raise ValueError("estimated_minutes must be positive")

    rng = seeded_random(seed, policy.persona_id, context.simulation_date.isoformat())
    deadline_sprint = (
        context.days_to_deadline is not None
        and 0 <= context.days_to_deadline <= policy.deadline_sprint_days
    )
    activation = policy.base_activation
    if deadline_sprint:
        activation += 0.42
    if previous.interrupted:
        activation *= policy.recovery_probability
    if previous.backlog_minutes > policy.daily_capacity_minutes:
        activation -= 0.08
    active = bool(context.due_task_ids) and rng.random() < max(0.0, min(1.0, activation))

    if not active:
        interrupted = previous.interrupted or rng.random() < policy.interruption_probability
        backlog = previous.backlog_minutes + sum(context.estimated_minutes)
        return DailyBehaviorResult(
            state=DailyBehaviorState(
                interrupted=interrupted,
                inactive_streak=previous.inactive_streak + 1,
                backlog_minutes=backlog,
                cumulative_active_days=previous.cumulative_active_days,
                cumulative_completed_tasks=previous.cumulative_completed_tasks,
            )
        )

    events: list[PlannedBehaviorEvent] = []
    remaining = policy.daily_capacity_minutes
    completed = 0
    unresolved = 0
    hour_jitter = rng.choice((-1, 0, 0, 1))
    hour = (policy.preferred_hour + hour_jitter) % 24
    for task_id, estimated in zip(context.due_task_ids, context.estimated_minutes, strict=True):
        if estimated > remaining:
            unresolved += estimated
            event_type = (
                "TaskRescheduled" if rng.random() < policy.reschedule_probability else "TaskSkipped"
            )
            events.append(
                PlannedBehaviorEvent(
                    event_type=event_type,
                    task_id=task_id,
                    goal_id=context.active_goal_id,
                    occurred_hour=hour,
                    payload={"estimated_mins": estimated, "reason": "capacity_conflict"},
                )
            )
            continue
        if rng.random() < policy.skip_probability and not deadline_sprint:
            unresolved += estimated
            events.append(
                PlannedBehaviorEvent(
                    event_type="TaskSkipped",
                    task_id=task_id,
                    goal_id=context.active_goal_id,
                    occurred_hour=hour,
                    payload={"estimated_mins": estimated, "reason": "procrastination"},
                )
            )
            continue
        actual = max(1, round(estimated * policy.actual_to_estimated_ratio * rng.uniform(0.9, 1.1)))
        events.append(
            PlannedBehaviorEvent(
                event_type="TaskStarted",
                task_id=task_id,
                goal_id=context.active_goal_id,
                occurred_hour=hour,
                payload={"estimated_mins": estimated},
            )
        )
        remaining -= min(remaining, actual)
        if rng.random() < policy.completion_given_start or deadline_sprint:
            completed += 1
            events.append(
                PlannedBehaviorEvent(
                    event_type="TaskCompleted",
                    task_id=task_id,
                    goal_id=context.active_goal_id,
                    occurred_hour=hour,
                    payload={"estimated_mins": estimated, "actual_mins": actual},
                )
            )
            if rng.random() < 0.28:
                events.append(
                    PlannedBehaviorEvent(
                        event_type="MasteryRecorded",
                        task_id=task_id,
                        goal_id=context.active_goal_id,
                        occurred_hour=hour,
                        payload={"mastery_delta": 1},
                    )
                )
        else:
            unresolved += estimated
            events.append(
                PlannedBehaviorEvent(
                    event_type="TaskRescheduled",
                    task_id=task_id,
                    goal_id=context.active_goal_id,
                    occurred_hour=hour,
                    payload={"estimated_mins": estimated, "reason": "unfinished"},
                )
            )

    if rng.random() < policy.checkin_probability:
        events.append(
            PlannedBehaviorEvent(
                event_type="CheckinSubmitted",
                goal_id=context.active_goal_id,
                occurred_hour=hour,
                payload={"completed_tasks": completed, "remaining_capacity_mins": remaining},
            )
        )
    if context.active_goal_id and rng.random() < policy.change_goal_probability:
        events.append(
            PlannedBehaviorEvent(
                event_type="GoalStatusChanged",
                goal_id=context.active_goal_id,
                occurred_hour=hour,
                payload={"reason": "changed_mind", "to_status": "paused"},
            )
        )

    return DailyBehaviorResult(
        state=DailyBehaviorState(
            interrupted=False,
            inactive_streak=0,
            backlog_minutes=max(
                0, previous.backlog_minutes + unresolved - policy.daily_capacity_minutes
            ),
            cumulative_active_days=previous.cumulative_active_days + 1,
            cumulative_completed_tasks=previous.cumulative_completed_tasks + completed,
        ),
        events=tuple(events),
    )


# Readable alias for evaluation runners.
simulate_day = advance_day
