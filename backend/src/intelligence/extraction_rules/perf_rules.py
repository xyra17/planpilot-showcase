"""Performance Rules（P-1 ~ P-2）— Phase 2C-3

P-1: checkin_submitted_to_completion_trend
P-2: mastery_recorded_to_mastery_velocity
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from src.intelligence.extraction_rules.base import (
    ExtractionRule,
    RuleRegistry,
    register_extractor,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from src.models import LearningEvent

_MASTERY_INT = {"unknown": 0, "L1": 1, "L2": 2, "L3": 3, "L4": 4}


# ── P-1: CheckinSubmitted → completion_rate_trend ──────────────────────────

_P1 = ExtractionRule(
    rule_id="checkin_submitted_to_completion_trend",
    source_event_type="CheckinSubmitted",
    target_pattern_type="completion_rate_trend",
    target_scope="goal",
    base_contribution=1.0,
    reliability=0.8,
    condition="payload.get('completion_rate') is not None",
    description=(
        "每次打卡的 completion_rate → completion_rate_trend 时间序列。"
        "scope=goal：完成率因目标不同而异。"
    ),
)
RuleRegistry.register(_P1)


@register_extractor("checkin_submitted_to_completion_trend")
async def _extract_p1(event: "LearningEvent", db: "AsyncSession") -> dict[str, Any]:
    return {
        "completion_rate": event.payload["completion_rate"],
        "date": event.payload.get("date", event.occurred_at.date().isoformat()),
        "total_tasks": event.payload.get("total_tasks", 0),
        "completed_count": event.payload.get("completed_count", 0),
    }


# ── P-2: MasteryRecorded → mastery_velocity ─────────────────────────────────

_P2 = ExtractionRule(
    rule_id="mastery_recorded_to_mastery_velocity",
    source_event_type="MasteryRecorded",
    target_pattern_type="mastery_velocity",
    target_scope="goal",
    base_contribution=1.0,
    reliability=0.8,
    condition="payload.get('to_level') != payload.get('from_level')",
    description=(
        "掌握等级变化 → mastery_velocity。条件过滤：from_level == to_level 的无效更新不计入。"
    ),
)
RuleRegistry.register(_P2)


@register_extractor("mastery_recorded_to_mastery_velocity")
async def _extract_p2(event: "LearningEvent", db: "AsyncSession") -> dict[str, Any]:
    from_int = _MASTERY_INT.get(event.payload.get("from_level", "unknown"), 0)
    to_int = _MASTERY_INT.get(event.payload.get("to_level", "L1"), 1)
    return {
        "from_level_int": from_int,
        "to_level_int": to_int,
        "level_delta": to_int - from_int,
        "occurred_at": event.occurred_at.isoformat(),
    }
