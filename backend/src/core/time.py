"""Canonical application time helpers.

The current database schema uses ``TIMESTAMP WITHOUT TIME ZONE``.  Compute in
UTC with an aware datetime first, then remove the timezone marker at the
storage boundary so every application-generated timestamp is naive UTC.
"""

from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo


def utc_now_aware() -> datetime:
    """Return a timezone-aware UTC datetime for application computation."""
    return datetime.now(timezone.utc)


def utc_now() -> datetime:
    """Return the current time as naive UTC for existing DateTime columns."""
    return utc_now_aware().replace(tzinfo=None)


def as_utc_aware(value: datetime) -> datetime:
    """Interpret legacy naive values as UTC and normalize aware values to UTC."""
    return (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )


def to_user_timezone(value: datetime, timezone_name: str) -> datetime:
    return as_utc_aware(value).astimezone(ZoneInfo(timezone_name))


def local_date_for_timezone(
    timezone_name: str, *, now: datetime | None = None
) -> date:
    """Return the calendar date seen by a user in an IANA time zone.

    ``now`` is injectable so scheduling decisions remain deterministic in tests,
    replays, and delayed Agent executions. Naive values are interpreted as UTC,
    matching the application's existing database convention.
    """
    return to_user_timezone(now or utc_now_aware(), timezone_name).date()


def local_midnight_as_utc(value: date, timezone_name: str) -> datetime:
    """Convert a user's local midnight to naive UTC for database storage.

    Constructing the wall-clock boundary in the IANA zone before converting it
    keeps prediction windows correct across UTC offsets and DST transitions.
    """
    local_value = datetime.combine(value, time.min, tzinfo=ZoneInfo(timezone_name))
    return local_value.astimezone(timezone.utc).replace(tzinfo=None)
