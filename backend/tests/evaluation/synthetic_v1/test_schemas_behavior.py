from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from src.evaluation.synthetic_v1 import (
    BehaviorPolicyV1,
    DailyBehaviorContext,
    DailyBehaviorState,
    RunManifest,
    SimulationClock,
    advance_day,
    build_personas,
    stable_seed,
)


def test_persona_builder_is_reproducible_balanced_and_diverse():
    personas = build_personas(20260823)
    assert personas == build_personas(20260823)
    assert personas != build_personas(20260824)
    assert len(personas) == len({item.persona_id for item in personas}) == 30
    assert {
        scenario: sum(p.primary_scenario == scenario for p in personas)
        for scenario in {p.primary_scenario for p in personas}
    } == {scenario: 5 for scenario in {p.primary_scenario for p in personas}}
    assert {p.active_goal_count for p in personas} == {1, 2, 3}
    assert {p.historical_goal_count for p in personas} == {7, 8}
    assert {p.personalization_consent for p in personas} == {False, True}
    assert {p.sensitive_inference_consent for p in personas} == {False, True}
    assert {p.communication_style for p in personas} == {
        "terse",
        "colloquial",
        "typo_prone",
        "long_form",
        "mixed",
    }
    assert any(p.procrastination > 0.8 for p in personas)
    assert any(p.ai_trust < 0.35 for p in personas)
    assert any(p.weekly_capacity_hours <= 3.5 for p in personas)


def test_seed_is_stable_and_namespaced():
    assert stable_seed(42, "user", 1) == stable_seed(42, "user", 1)
    assert stable_seed(42, "user", 1) != stable_seed(42, "user", 2)


def test_run_manifest_requires_exact_unique_user_list():
    now = datetime(2026, 8, 23, tzinfo=timezone.utc)
    ids = tuple(f"u-{index}" for index in range(30))
    manifest = RunManifest.create(seed=42, created_at=now).model_copy(update={"user_ids": ids})
    # model_copy is intentionally not validation; persisted reconstruction is.
    assert RunManifest.model_validate(manifest.model_dump()).user_ids == ids
    with pytest.raises(ValidationError):
        RunManifest(run_id="r", seed=1, created_at=now, user_ids=("same", "same"))


def test_simulation_clock_has_coherent_explicit_60_day_window():
    clock = SimulationClock(
        as_of=datetime(2026, 8, 23, 18, 0, tzinfo=timezone.utc),
        timezone_name="Asia/Shanghai",
    )
    assert clock.start_date.isoformat() == "2026-06-26"
    assert clock.date_for_day(59).isoformat() == "2026-08-24"
    assert clock.at(0, hour=8).isoformat() == "2026-06-26T00:00:00"
    assert clock.scheduled_date(0, offset_days=2) == "2026-06-28"
    assert clock.future_deadline(days_after_as_of=30) == "2026-09-23"
    with pytest.raises(ValidationError):
        SimulationClock(as_of=datetime(2026, 8, 23))


def test_daily_state_machine_is_pure_deterministic_and_causal():
    persona = build_personas(19)[0]
    policy = BehaviorPolicyV1.from_persona(persona).model_copy(
        update={
            "base_activation": 1.0,
            "completion_given_start": 1.0,
            "skip_probability": 0.0,
            "daily_capacity_minutes": 90,
            "checkin_probability": 1.0,
            "change_goal_probability": 0.0,
        }
    )
    previous = DailyBehaviorState()
    context = DailyBehaviorContext(
        simulation_date="2026-07-01",
        day_index=5,
        due_task_ids=("task-a", "task-b"),
        estimated_minutes=(30, 45),
        days_to_deadline=20,
        active_goal_id="goal-a",
    )
    first = advance_day(policy=policy, previous=previous, context=context, seed=99)
    second = advance_day(policy=policy, previous=previous, context=context, seed=99)
    assert first == second
    assert previous == DailyBehaviorState()
    event_types = [event.event_type for event in first.events]
    assert event_types.count("TaskStarted") == 2
    assert event_types.count("TaskCompleted") == 2
    assert event_types[-1] == "CheckinSubmitted"
    for task_id in context.due_task_ids:
        started = next(
            i
            for i, event in enumerate(first.events)
            if event.event_type == "TaskStarted" and event.task_id == task_id
        )
        completed = next(
            i
            for i, event in enumerate(first.events)
            if event.event_type == "TaskCompleted" and event.task_id == task_id
        )
        assert started < completed


def test_no_behavior_day_and_capacity_conflict_are_possible():
    persona = build_personas(7)[0]
    base = BehaviorPolicyV1.from_persona(persona)
    context = DailyBehaviorContext(
        simulation_date="2026-07-02",
        day_index=6,
        due_task_ids=("too-large",),
        estimated_minutes=(120,),
        active_goal_id="g",
    )
    inactive = advance_day(
        policy=base.model_copy(update={"base_activation": 0.0, "interruption_probability": 1.0}),
        previous=DailyBehaviorState(),
        context=context,
        seed=1,
    )
    assert inactive.events == ()
    assert inactive.state.inactive_streak == 1
    assert inactive.state.backlog_minutes == 120

    conflict = advance_day(
        policy=base.model_copy(
            update={
                "base_activation": 1.0,
                "daily_capacity_minutes": 30,
                "reschedule_probability": 1.0,
            }
        ),
        previous=DailyBehaviorState(),
        context=context,
        seed=1,
    )
    assert conflict.events[0].event_type == "TaskRescheduled"
    assert conflict.events[0].payload["reason"] == "capacity_conflict"
