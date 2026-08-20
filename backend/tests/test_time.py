from datetime import datetime, timezone

from src.core.time import local_date_for_timezone, utc_now, utc_now_aware


def test_utc_now_returns_naive_utc_for_existing_database_columns() -> None:
    before = utc_now_aware().replace(tzinfo=None)
    value = utc_now()
    after = utc_now_aware().replace(tzinfo=None)

    assert value.tzinfo is None
    assert before <= value <= after


def test_utc_now_aware_retains_utc_timezone():
    value = utc_now_aware()
    assert value.tzinfo == timezone.utc


def test_local_date_uses_user_timezone_at_utc_day_boundary() -> None:
    instant = datetime(2026, 8, 18, 16, 30, tzinfo=timezone.utc)

    assert local_date_for_timezone("UTC", now=instant).isoformat() == "2026-08-18"
    assert (
        local_date_for_timezone("Asia/Shanghai", now=instant).isoformat()
        == "2026-08-19"
    )


def test_local_date_is_stable_across_dst_transitions() -> None:
    before_spring_jump = datetime(2026, 3, 8, 6, 30, tzinfo=timezone.utc)
    after_spring_jump = datetime(2026, 3, 8, 7, 30, tzinfo=timezone.utc)
    first_fall_hour = datetime(2026, 11, 1, 5, 30, tzinfo=timezone.utc)
    repeated_fall_hour = datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc)

    for instant in (
        before_spring_jump,
        after_spring_jump,
        first_fall_hour,
        repeated_fall_hour,
    ):
        assert local_date_for_timezone("America/New_York", now=instant) == instant.date()
