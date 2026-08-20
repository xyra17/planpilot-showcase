"""Planning Rules（Pl-1 ~ Pl-2）— Phase 2C-3

Pl-1: task_completed_to_delay_pattern
Pl-2: task_rescheduled_to_plan_adherence
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


# ── Pl-1: TaskCompleted → delay_pattern ────────────────────────────────────

_PL1 = ExtractionRule(
    rule_id="task_completed_to_delay_pattern",
    source_event_type="TaskCompleted",
    target_pattern_type="delay_pattern",
    target_scope="user",
    base_contribution=1.0,
    reliability=0.9,
    condition=None,
    description=(
        "TaskCompleted.days_overdue → delay_pattern。"
        "每次任务完成都提供一个数据点（无论按时还是逾期）。"
    ),
)
RuleRegistry.register(_PL1)


@register_extractor("task_completed_to_delay_pattern")
async def _extract_pl1(event: "LearningEvent", db: "AsyncSession") -> dict[str, Any]:
    days_overdue = event.payload.get("days_overdue", 0) or 0
    return {
        "days_overdue": days_overdue,
        "on_time": days_overdue <= 0,
    }


# ── Pl-2: TaskRescheduled → plan_adherence ──────────────────────────────────

_PL2 = ExtractionRule(
    rule_id="task_rescheduled_to_plan_adherence",
    source_event_type="TaskRescheduled",
    target_pattern_type="plan_adherence",
    target_scope="goal",
    base_contribution=1.0,
    reliability=0.9,
    condition=None,
    description=(
        "每次改期 → plan_adherence。debt_rollover 触发的改期是慢性债务信号，需要特别标记。"
    ),
)
RuleRegistry.register(_PL2)


@register_extractor("task_rescheduled_to_plan_adherence")
async def _extract_pl2(event: "LearningEvent", db: "AsyncSession") -> dict[str, Any]:
    trigger = event.payload.get("trigger", "user_manual")
    return {
        "trigger": trigger,
        "is_debt_rollover": trigger == "debt_rollover",
    }
