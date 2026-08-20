from datetime import date

import pytest
from pydantic import ValidationError

from src.api.schedule import ScheduleBlock, ScheduleSave
from src.services.agent_schedule import build_reschedule_preview, build_task_mutation_preview


def block(block_id: str, start: float, duration: float, *, progress: float = 0) -> ScheduleBlock:
    return ScheduleBlock(
        id=block_id,
        label=block_id,
        startHour=start,
        durationMinutes=duration,
        color="#000",
        progress=progress,
    )


def test_schedule_rejects_overlap_duplicate_and_cross_midnight() -> None:
    with pytest.raises(ValidationError, match="不能重叠"):
        ScheduleSave(blocks=[block("a", 9, 60), block("b", 9.5, 60)])
    with pytest.raises(ValidationError, match="不能重复"):
        ScheduleSave(blocks=[block("a", 9, 30), block("a", 10, 30)])
    with pytest.raises(ValidationError, match="不能跨越午夜"):
        block("late", 23.5, 31)


def test_schedule_allows_touching_boundaries_but_rejects_invalid_progress() -> None:
    value = ScheduleSave(blocks=[block("a", 9, 60), block("b", 10, 30)])
    assert len(value.blocks) == 2
    with pytest.raises(ValidationError):
        block("bad", 9, 30, progress=1.1)


def test_agent_schedule_uses_injected_local_date() -> None:
    context = {
        "goals": [{"id": "goal", "title": "Goal", "daily_hours": 1}],
        "tasks": [
            {
                "id": "late",
                "goal_id": "goal",
                "title": "Late",
                "date": "2026-08-18",
                "status": "pending",
                "priority": "medium",
                "estimated_minutes": 30,
            }
        ],
    }

    utc_preview = build_reschedule_preview(
        context, today=date(2026, 8, 18)
    )
    shanghai_preview = build_reschedule_preview(
        context, today=date(2026, 8, 19)
    )

    assert utc_preview.operations == []
    assert shanghai_preview.operations[0].before == "2026-08-18"


def test_agent_today_and_tomorrow_are_deterministic() -> None:
    context = {
        "goals": [{"id": "goal", "title": "Goal", "daily_hours": 1}],
        "tasks": [],
    }
    preview = build_task_mutation_preview(
        context,
        request='创建任务“复习”明天',
        goal_id="goal",
        today=date(2026, 8, 18),
    )

    assert preview.operations[0].after["scheduled_date"] == "2026-08-19"
