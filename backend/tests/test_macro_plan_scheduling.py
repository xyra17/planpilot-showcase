from datetime import date, datetime, timedelta
from types import SimpleNamespace

from src.api.agent import (
    _allocate_phase_days,
    _format_plan_personalization,
    _schedule_plan_phases,
)
from src.services.goal_service import _align_plan_tasks_to_baseline


def _dates(count: int) -> list[date]:
    start = date(2026, 8, 3)
    return [start + timedelta(days=index) for index in range(count)]


def test_phase_day_allocation_is_exact_even_for_skewed_weights():
    allocation = _allocate_phase_days([100, 1, 1, 1], 14)

    assert sum(allocation) == 14
    assert all(days >= 1 for days in allocation)


def test_phase_scheduler_keeps_windows_ordered_and_non_overlapping():
    phases = [
        {
            "name": "基础",
            "days": 4,
            "tasks": [{"estimated_mins": 40} for _ in range(3)],
        },
        {
            "name": "进阶",
            "days": 4,
            "tasks": [{"estimated_mins": 40} for _ in range(3)],
        },
    ]

    scheduled = _schedule_plan_phases(phases, _dates(8), daily_hours=1)

    assert scheduled == sorted(scheduled)
    assert scheduled[:3] == [_dates(8)[0], _dates(8)[2], _dates(8)[3]]
    assert scheduled[3:] == [_dates(8)[4], _dates(8)[6], _dates(8)[7]]
    assert max(scheduled[:3]) < min(scheduled[3:])


def test_personalization_uses_consented_evidence_as_soft_constraints():
    note = _format_plan_personalization(
        {
            "profile": {
                "event_count": 12,
                "avg_session_duration_mins": 38,
                "avg_daily_investment_mins": 52,
                "preferred_weekdays": [0, 2],
                "reschedule_rate": 0.25,
                "estimation_accuracy": 0.8,
            },
            "active_patterns": [{"explanation": "晚间完成率更高"}],
            "memories": {"semantic": [{"summary": "短任务更容易持续"}]},
            "data_quality": {"profile_event_count": 12},
        }
    )

    assert "历史单次学习平均 38 分钟" in note
    assert "周一、周三" in note
    assert "晚间完成率更高" in note
    assert "短任务更容易持续" in note
    assert "软约束" in note


def test_personalization_respects_disabled_consent():
    note = _format_plan_personalization({"data_quality": {"personalization_enabled": False}})

    assert "未启用个性化" in note


def test_old_plan_tasks_are_recovered_by_baseline_title():
    created_at = datetime(2026, 8, 3, 8, 0)
    tasks = [
        SimpleNamespace(
            id="2",
            title="进阶任务",
            sequence_in_plan=None,
            scheduled_date="2026-08-05",
            created_at=created_at,
        ),
        SimpleNamespace(
            id="1",
            title="基础任务",
            sequence_in_plan=None,
            scheduled_date="2026-08-03",
            created_at=created_at,
        ),
    ]
    phases = [
        {"tasks": [{"title": "基础任务"}]},
        {"tasks": [{"title": "进阶任务"}]},
    ]

    aligned = _align_plan_tasks_to_baseline(list(reversed(tasks)), phases)

    assert [task.title for task in aligned] == ["基础任务", "进阶任务"]
