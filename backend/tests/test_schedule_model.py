from datetime import date

import pytest
from pydantic import ValidationError

from src.api.schedule import ScheduleBlock, ScheduleSave
from src.core.agent_v2.schemas import ActionEntityRef, ActionIntent
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

    utc_preview = build_reschedule_preview(context, today=date(2026, 8, 18))
    shanghai_preview = build_reschedule_preview(context, today=date(2026, 8, 19))

    assert utc_preview.operations == []
    assert shanghai_preview.operations[0].before == "2026-08-18"


def test_agent_today_and_tomorrow_are_deterministic() -> None:
    context = {
        "goals": [{"id": "goal", "title": "Goal", "daily_hours": 1}],
        "tasks": [],
    }
    preview = build_task_mutation_preview(
        context,
        request="创建任务“复习”明天",
        goal_id="goal",
        today=date(2026, 8, 18),
    )

    assert preview.operations[0].after["scheduled_date"] == "2026-08-19"


def test_agent_task_preview_uses_resolved_entity_id_not_fuzzy_title() -> None:
    context = {
        "goals": [{"id": "goal", "title": "Goal", "daily_hours": 1}],
        "tasks": [
            {
                "id": "exact",
                "goal_id": "goal",
                "title": "数组练习",
                "date": "2026-08-18",
                "status": "pending",
                "priority": "medium",
                "estimated_minutes": 30,
                "version": 1,
            },
            {
                "id": "similar",
                "goal_id": "goal",
                "title": "数组练习进阶",
                "date": "2026-08-18",
                "status": "pending",
                "priority": "medium",
                "estimated_minutes": 30,
                "version": 1,
            },
        ],
    }
    intent = ActionIntent(
        capability="task_mutation",
        goal_id="goal",
        entity_refs=[
            ActionEntityRef(entity="goal", entity_id="goal", label="Goal"),
            ActionEntityRef(entity="task", entity_id="exact", label="数组练习"),
        ],
        requested_effect="delete",
        confidence=0.98,
    )

    preview = build_task_mutation_preview(
        context,
        request="删除任务“数组练习”",
        goal_id="goal",
        today=date(2026, 8, 18),
        action_intent=intent,
    )

    assert [operation.entity_id for operation in preview.operations] == ["exact"]


def test_resolved_update_intent_is_not_reclassified_by_preview_wording() -> None:
    context = {
        "goals": [{"id": "goal", "title": "Goal", "daily_hours": 1}],
        "tasks": [
            {
                "id": "exact",
                "goal_id": "goal",
                "title": "技能训练 3 · 第28步",
                "date": "2026-08-20",
                "status": "pending",
                "priority": "medium",
                "estimated_minutes": 30,
                "version": 1,
            }
        ],
    }
    intent = ActionIntent(
        capability="task_mutation",
        goal_id="goal",
        entity_refs=[
            ActionEntityRef(entity="goal", entity_id="goal", label="Goal"),
            ActionEntityRef(
                entity="task", entity_id="exact", label="技能训练 3 · 第28步"
            ),
        ],
        constraints={"scheduled_date": "2026-08-22"},
        requested_effect="update",
        resolution_quality="exact",
    )

    preview = build_task_mutation_preview(
        context,
        request="把技能训练 3 · 第28步延两天；现在只创建待审批预览，等我批准。",
        goal_id="goal",
        today=date(2026, 8, 20),
        action_intent=intent,
    )

    assert preview.summary == "建议更新 1 项任务"
    assert len(preview.operations) == 1
    assert preview.operations[0].field == "scheduled_date"
    assert preview.operations[0].before == "2026-08-20"
    assert preview.operations[0].after == "2026-08-22"


def test_agent_task_preview_never_guesses_default_create_title() -> None:
    context = {"goals": [{"id": "goal", "title": "Goal", "daily_hours": 1}], "tasks": []}
    preview = build_task_mutation_preview(
        context,
        request="创建任务明天",
        goal_id="goal",
        today=date(2026, 8, 18),
    )

    assert preview.operations == []
    assert "信息不完整" in preview.summary
