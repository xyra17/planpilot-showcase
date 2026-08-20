"""Learning Habit Rules（H-1 ~ H-4）— Phase 2C-3

H-1: task_completed_to_preferred_time
H-2: task_completed_to_session_length
H-3: checkin_submitted_to_session_length
H-4: checkin_submitted_to_weekly_frequency
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from src.core.time import to_user_timezone
from src.intelligence.extraction_rules.base import (
    ExtractionRule,
    RuleRegistry,
    register_extractor,
)
from src.models import User

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from src.models import LearningEvent


# ── H-1: TaskCompleted → preferred_learning_time ───────────────────────────

_H1 = ExtractionRule(
    rule_id="task_completed_to_preferred_time",
    source_event_type="TaskCompleted",
    target_pattern_type="preferred_learning_time",
    target_scope="user",
    base_contribution=1.0,
    reliability=0.9,
    condition=None,
    description=(
        "TaskCompleted 的完成时间 → preferred_learning_time。"
        "occurred_at.hour 反映用户在哪个时段标记完成，与实际学习时段强相关。"
    ),
)
RuleRegistry.register(_H1)


@register_extractor("task_completed_to_preferred_time")
async def _extract_h1(event: "LearningEvent", db: "AsyncSession") -> dict[str, Any]:
    timezone_name = await db.scalar(select(User.timezone).where(User.id == event.user_id))
    local_time = to_user_timezone(event.occurred_at, timezone_name or "Asia/Shanghai")
    return {
        "extracted_hour": local_time.hour,
        "weekday": local_time.strftime("%A"),
        "timezone": timezone_name or "Asia/Shanghai",
        "mastery_level": event.payload.get("mastery_level"),
    }


# ── H-2: TaskCompleted → preferred_session_length ──────────────────────────

_H2 = ExtractionRule(
    rule_id="task_completed_to_session_length",
    source_event_type="TaskCompleted",
    target_pattern_type="preferred_session_length",
    target_scope="user",
    base_contribution=1.0,
    reliability=0.9,
    condition="payload.get('actual_mins', 0) > 0",
    description=(
        "TaskCompleted.actual_mins → preferred_session_length（主要数据源）。"
        "actual_mins 是客观记录的完成时长，reliability=0.9。"
    ),
)
RuleRegistry.register(_H2)


@register_extractor("task_completed_to_session_length")
async def _extract_h2(event: "LearningEvent", db: "AsyncSession") -> dict[str, Any]:
    return {
        "session_mins": event.payload["actual_mins"],
    }


# ── H-3: CheckinSubmitted → preferred_session_length ───────────────────────

_H3 = ExtractionRule(
    rule_id="checkin_submitted_to_session_length",
    source_event_type="CheckinSubmitted",
    target_pattern_type="preferred_session_length",
    target_scope="user",
    base_contribution=0.7,
    reliability=0.6,
    condition="payload.get('completed_count', 0) > 0",
    description=(
        "CheckinSubmitted 每任务平均时长 → preferred_session_length（辅助数据源）。"
        "time_investment_mins 是用户自填估算，可靠性低于 actual_mins。"
    ),
)
RuleRegistry.register(_H3)


@register_extractor("checkin_submitted_to_session_length")
async def _extract_h3(event: "LearningEvent", db: "AsyncSession") -> dict[str, Any]:
    total_mins = event.payload.get("time_investment_mins", 0) or 0
    completed = event.payload.get("completed_count", 1) or 1
    return {
        "session_mins": round(total_mins / completed, 1),
    }


# ── H-4: CheckinSubmitted → weekly_learning_frequency ──────────────────────

_H4 = ExtractionRule(
    rule_id="checkin_submitted_to_weekly_frequency",
    source_event_type="CheckinSubmitted",
    target_pattern_type="weekly_learning_frequency",
    target_scope="user",
    base_contribution=1.0,
    reliability=0.9,
    condition=None,
    description=(
        "每次打卡 = 当天活跃学习。"
        "pattern_value.preferred_days 统计各 weekday 打卡频率，"
        "avg_days_per_week 用28天滑动窗口计算。"
    ),
)
RuleRegistry.register(_H4)


@register_extractor("checkin_submitted_to_weekly_frequency")
async def _extract_h4(event: "LearningEvent", db: "AsyncSession") -> dict[str, Any]:
    timezone_name = await db.scalar(select(User.timezone).where(User.id == event.user_id))
    timezone_name = timezone_name or "Asia/Shanghai"
    local_time = to_user_timezone(event.occurred_at, timezone_name)
    return {
        "date": event.payload.get("date", local_time.date().isoformat()),
        "weekday": local_time.strftime("%A"),
        "timezone": timezone_name,
    }
