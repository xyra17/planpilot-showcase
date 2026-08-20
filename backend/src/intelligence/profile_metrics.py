"""Pure metric calculators for LearnerProfile.

This module performs no IO and never mutates patterns or events. Pattern-derived
values are preferred when sufficiently reliable; event aggregates provide the
cold-start and low-confidence fallback.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime
from statistics import mean
from typing import Any, Iterable

from src.core.time import to_user_timezone
from src.models import LearnerPattern, LearningEvent

PATTERN_CONFIDENCE_THRESHOLD = 0.4
ACTIVITY_EVENT_TYPES = {
    "TaskCompleted",
    "TaskSkipped",
    "MasteryRecorded",
    "CheckinSubmitted",
}
MASTERY_LEVELS = {"unknown": 0, "L1": 1, "L2": 2, "L3": 3, "L4": 4}
WEEKDAY_NUMBERS = {
    "Monday": 0,
    "Tuesday": 1,
    "Wednesday": 2,
    "Thursday": 3,
    "Friday": 4,
    "Saturday": 5,
    "Sunday": 6,
}


def _pattern(
    patterns: Iterable[LearnerPattern],
    pattern_type: str,
    *,
    goal_id: str | None = None,
) -> LearnerPattern | None:
    candidates = [
        row
        for row in patterns
        if row.pattern_type == pattern_type
        and row.status in {"active", "decayed"}
        and (row.goal_id is None if goal_id is None else row.goal_id in {goal_id, None})
    ]
    if not candidates:
        return None
    if goal_id is not None:
        candidates.sort(key=lambda row: (row.goal_id == goal_id, row.confidence), reverse=True)
    else:
        candidates.sort(key=lambda row: row.confidence, reverse=True)
    return candidates[0]


def _blend(
    pattern: LearnerPattern | None, value: float | None, fallback: float | None
) -> float | None:
    if pattern is None or value is None:
        return fallback
    if pattern.confidence >= PATTERN_CONFIDENCE_THRESHOLD and pattern.status == "active":
        return value
    if fallback is None:
        return value if pattern.confidence >= PATTERN_CONFIDENCE_THRESHOLD else None
    weight = min(1.0, max(0.0, pattern.confidence / PATTERN_CONFIDENCE_THRESHOLD))
    return value * weight + fallback * (1.0 - weight)


def _payload_number(event: LearningEvent, *keys: str) -> float | None:
    payload = event.payload or {}
    for key in keys:
        value = payload.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return None


def _active_dates(events: Iterable[LearningEvent]) -> set:
    return {
        event.occurred_at.date() for event in events if event.event_type in ACTIVITY_EVENT_TYPES
    }


def calc_consistency(
    patterns: list[LearnerPattern],
    events: list[LearningEvent],
    window_days: int = 30,
) -> tuple[float | None, float | None]:
    active_dates = _active_dates(events)
    fallback_days = (
        round(len(active_dates) / max(window_days / 7.0, 1.0), 2) if active_dates else None
    )
    row = _pattern(patterns, "weekly_learning_frequency")
    raw = (row.pattern_value or {}).get("avg_days_per_week") if row else None
    raw_value = float(raw) if isinstance(raw, (int, float)) else None
    weekly = _blend(row, raw_value, fallback_days)
    if weekly is None:
        return None, None
    weekly = round(max(0.0, min(7.0, weekly)), 2)
    return round(weekly / 7.0, 4), weekly


def calc_session_duration(
    patterns: list[LearnerPattern], events: list[LearningEvent]
) -> float | None:
    durations = [
        value
        for event in events
        if event.event_type == "TaskCompleted"
        and (value := _payload_number(event, "actual_mins")) is not None
        and value > 0
    ]
    fallback = mean(durations) if durations else None
    row = _pattern(patterns, "preferred_session_length")
    raw = (row.pattern_value or {}).get("median_mins") if row else None
    value = float(raw) if isinstance(raw, (int, float)) else None
    result = _blend(row, value, fallback)
    return round(result, 1) if result is not None else None


def calc_daily_investment(events: list[LearningEvent]) -> float | None:
    checkins = [event for event in events if event.event_type == "CheckinSubmitted"]
    by_day: dict[Any, float] = {}
    for event in checkins:
        value = _payload_number(event, "time_investment_mins", "actual_mins")
        if value is not None and value >= 0:
            by_day[event.occurred_at.date()] = by_day.get(event.occurred_at.date(), 0.0) + value
    return round(sum(by_day.values()) / len(by_day), 1) if by_day else None


def calc_completion_rate(
    patterns: list[LearnerPattern],
    events: list[LearningEvent],
    *,
    goal_id: str | None = None,
) -> float | None:
    rates = [
        value
        for event in events
        if event.event_type == "CheckinSubmitted"
        and (value := _payload_number(event, "completion_rate")) is not None
    ]
    fallback = mean(rates) if rates else None
    row = _pattern(patterns, "completion_rate_trend", goal_id=goal_id)
    raw = (row.pattern_value or {}).get("current_30d_avg") if row else None
    value = float(raw) if isinstance(raw, (int, float)) else None
    result = _blend(row, value, fallback)
    return round(max(0.0, min(1.0, result)), 4) if result is not None else None


def calc_mastery_rate(events: list[LearningEvent]) -> float | None:
    records = [event for event in events if event.event_type == "MasteryRecorded"]
    if records:
        mastered = sum(
            1 for event in records if (event.payload or {}).get("to_level") in {"L3", "L4"}
        )
        return round(mastered / len(records), 4)
    checkin_rates = [
        value
        for event in events
        if event.event_type == "CheckinSubmitted"
        and (value := _payload_number(event, "mastery_rate")) is not None
    ]
    return round(mean(checkin_rates), 4) if checkin_rates else None


def calc_mastery_velocity(
    patterns: list[LearnerPattern],
    events: list[LearningEvent],
    *,
    goal_id: str | None = None,
) -> float | None:
    entries: list[tuple[datetime, int]] = []
    for event in events:
        if event.event_type != "MasteryRecorded":
            continue
        payload = event.payload or {}
        delta = MASTERY_LEVELS.get(payload.get("to_level"), 0) - MASTERY_LEVELS.get(
            payload.get("from_level"), 0
        )
        if delta > 0:
            entries.append((event.occurred_at, delta))
    fallback = None
    if entries:
        entries.sort(key=lambda item: item[0])
        weeks = max((entries[-1][0] - entries[0][0]).days / 7.0, 1.0 / 7.0)
        fallback = sum(delta for _, delta in entries) / weeks
    row = _pattern(patterns, "mastery_velocity", goal_id=goal_id)
    raw = (row.pattern_value or {}).get("levels_per_week") if row else None
    value = float(raw) if isinstance(raw, (int, float)) else None
    result = _blend(row, value, fallback)
    return round(result, 2) if result is not None else None


def calc_preferred_hours(
    patterns: list[LearnerPattern],
    events: list[LearningEvent],
    timezone_name: str = "UTC",
) -> tuple[int, int] | None:
    row = _pattern(patterns, "preferred_learning_time")
    row_values = row.pattern_value or {} if row else {}
    pattern_timezone = row_values.get("timezone")
    peaks = row_values.get("peak_hours", []) if pattern_timezone == timezone_name else []
    valid_peaks = [
        int(hour) for hour in peaks if isinstance(hour, (int, float)) and 0 <= hour <= 23
    ]
    fallback_hours = [
        to_user_timezone(event.occurred_at, timezone_name).hour
        for event in events
        if event.event_type == "TaskCompleted"
    ]
    if row and valid_peaks and row.confidence >= PATTERN_CONFIDENCE_THRESHOLD:
        return min(valid_peaks), min(24, max(valid_peaks) + 1)
    if not fallback_hours:
        return None
    mode = Counter(fallback_hours).most_common(1)[0][0]
    return max(0, mode - 1), min(23, mode + 1)


def calc_preferred_weekdays(
    patterns: list[LearnerPattern],
    events: list[LearningEvent],
    timezone_name: str = "UTC",
) -> list[int] | None:
    row = _pattern(patterns, "preferred_learning_time")
    row_values = row.pattern_value or {} if row else {}
    pattern_timezone = row_values.get("timezone")
    distribution = row_values.get("weekday_dist", {}) if pattern_timezone == timezone_name else {}
    if row and distribution and row.confidence >= PATTERN_CONFIDENCE_THRESHOLD:
        ranked = sorted(distribution, key=distribution.get, reverse=True)
        converted = [
            day if isinstance(day, int) else WEEKDAY_NUMBERS.get(str(day)) for day in ranked
        ]
        valid = [day for day in converted if isinstance(day, int) and 0 <= day <= 6]
        if valid:
            return valid[:5]
    weekdays = [
        to_user_timezone(event.occurred_at, timezone_name).weekday()
        for event in events
        if event.event_type == "TaskCompleted"
    ]
    return [day for day, _ in Counter(weekdays).most_common(5)] or None


def calc_estimation_accuracy(
    patterns: list[LearnerPattern], events: list[LearningEvent]
) -> float | None:
    ratios = []
    for event in events:
        if event.event_type != "TaskCompleted":
            continue
        actual = _payload_number(event, "actual_mins")
        estimated = _payload_number(event, "estimated_mins")
        if actual is not None and estimated is not None and estimated > 0:
            ratios.append(actual / estimated)
    fallback = mean(ratios) if ratios else None
    row = _pattern(patterns, "estimation_accuracy")
    raw = (row.pattern_value or {}).get("ratio") if row else None
    value = float(raw) if isinstance(raw, (int, float)) else None
    result = _blend(row, value, fallback)
    return round(result, 3) if result is not None else None


def calc_debt_tendency(patterns: list[LearnerPattern], events: list[LearningEvent]) -> float | None:
    overdue = [
        value
        for event in events
        if event.event_type == "TaskCompleted"
        and (value := _payload_number(event, "days_overdue")) is not None
    ]
    fallback = sum(value > 3 for value in overdue) / len(overdue) if overdue else None
    row = _pattern(patterns, "delay_pattern")
    raw = (row.pattern_value or {}).get("chronic_delay_rate") if row else None
    value = float(raw) if isinstance(raw, (int, float)) else None
    result = _blend(row, value, fallback)
    return round(max(0.0, min(1.0, result)), 4) if result is not None else None


def calc_reschedule_rate(
    patterns: list[LearnerPattern],
    events: list[LearningEvent],
    *,
    goal_id: str | None = None,
) -> float | None:
    rescheduled = sum(event.event_type == "TaskRescheduled" for event in events)
    completed = sum(event.event_type == "TaskCompleted" for event in events)
    fallback = rescheduled / (rescheduled + completed) if rescheduled + completed else None
    row = _pattern(patterns, "plan_adherence", goal_id=goal_id)
    values = row.pattern_value or {} if row else {}
    raw = values.get("reschedule_rate", values.get("debt_rollover_rate"))
    value = float(raw) if isinstance(raw, (int, float)) else None
    result = _blend(row, value, fallback)
    return round(max(0.0, min(1.0, result)), 4) if result is not None else None


def calculate_profile_metrics(
    patterns: list[LearnerPattern],
    events: list[LearningEvent],
    *,
    goal_id: str | None,
    window_days: int,
    timezone_name: str = "Asia/Shanghai",
) -> dict[str, Any]:
    consistency, weekly_days = calc_consistency(patterns, events, window_days)
    preferred_hours = calc_preferred_hours(patterns, events, timezone_name)
    return {
        "consistency_score": consistency,
        "weekly_active_days": weekly_days,
        "avg_session_duration_mins": calc_session_duration(patterns, events),
        "avg_daily_investment_mins": calc_daily_investment(events),
        "completion_rate_30d": calc_completion_rate(patterns, events, goal_id=goal_id),
        "mastery_rate_30d": calc_mastery_rate(events),
        "mastery_velocity": calc_mastery_velocity(patterns, events, goal_id=goal_id),
        "preferred_hour_start": preferred_hours[0] if preferred_hours else None,
        "preferred_hour_end": preferred_hours[1] if preferred_hours else None,
        "preferred_weekdays": calc_preferred_weekdays(patterns, events, timezone_name),
        "estimation_accuracy": calc_estimation_accuracy(patterns, events),
        "debt_tendency": calc_debt_tendency(patterns, events),
        "reschedule_rate": calc_reschedule_rate(patterns, events, goal_id=goal_id),
    }
