"""Explicit evaluation clock; production wall-clock functions are untouched."""

from __future__ import annotations

import random
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SimulationClock(BaseModel):
    """Maps a zero-based simulation day to coherent business timestamps."""

    model_config = ConfigDict(frozen=True, extra="forbid", arbitrary_types_allowed=True)

    as_of: datetime
    history_days: int = Field(default=60, ge=1, le=366)
    timezone_name: str = "Asia/Shanghai"
    seed: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def validate_timezone(self) -> "SimulationClock":
        ZoneInfo(self.timezone_name)
        if self.as_of.tzinfo is None:
            raise ValueError("as_of must be timezone-aware")
        return self

    @property
    def as_of_utc(self) -> datetime:
        return self.as_of.astimezone(timezone.utc)

    @property
    def timezone(self) -> str:
        return self.timezone_name

    @property
    def start_date(self) -> date:
        return self.local_date(self.history_days - 1)

    def local_date(self, days_ago: int = 0) -> date:
        if not 0 <= days_ago < self.history_days:
            raise ValueError(f"days_ago must be between 0 and {self.history_days - 1}")
        return (
            self.as_of.astimezone(ZoneInfo(self.timezone_name)) - timedelta(days=days_ago)
        ).date()

    def date_for_day(self, day_index: int) -> date:
        if not 0 <= day_index < self.history_days:
            raise ValueError(f"day_index must be between 0 and {self.history_days - 1}")
        return self.start_date + timedelta(days=day_index)

    def date_at(self, day_index: int) -> date:
        return self.date_for_day(day_index)

    def at(self, day_index: int, *, hour: int, minute: int = 0, second: int = 0) -> datetime:
        """Return naive UTC, matching PlanPilot's current DB storage convention."""

        if not 0 <= hour <= 23 or not 0 <= minute <= 59 or not 0 <= second <= 59:
            raise ValueError("invalid wall-clock time")
        local = datetime.combine(
            self.date_for_day(day_index),
            time(hour, minute, second),
            tzinfo=ZoneInfo(self.timezone_name),
        )
        return local.astimezone(timezone.utc).replace(tzinfo=None)

    def utc_at(self, day_index: int, *, hour: int, minute: int = 0, second: int = 0) -> datetime:
        return self.at(day_index, hour=hour, minute=minute, second=second).replace(
            tzinfo=timezone.utc
        )

    def rng(self, namespace: str) -> random.Random:
        """Return a stable stream scoped to this clock and caller namespace."""

        from .schemas import seeded_random

        return seeded_random(self.seed, self.as_of_utc.isoformat(), self.history_days, namespace)

    def deadline_after(self, day_index: int, days: int) -> date:
        if days < 1:
            raise ValueError("deadline offset must be positive")
        return self.date_for_day(day_index) + timedelta(days=days)

    def scheduled_date(self, day_index: int, *, offset_days: int = 0) -> str:
        return (self.date_for_day(day_index) + timedelta(days=offset_days)).isoformat()

    def future_deadline(self, *, days_after_as_of: int) -> str:
        """Explicit alternative to date.today() for evaluation GoalCreate input."""

        if days_after_as_of < 1:
            raise ValueError("a creation deadline must be after as_of")
        local_as_of = self.as_of.astimezone(ZoneInfo(self.timezone_name)).date()
        return (local_as_of + timedelta(days=days_after_as_of)).isoformat()
