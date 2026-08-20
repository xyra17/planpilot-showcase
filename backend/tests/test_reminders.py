from datetime import datetime, timezone
from types import SimpleNamespace

from src.tasks.reminders import _local_reminder_context, _reminder_recipient


def reminder_user(
    *,
    enabled: bool = True,
    reminder_time: str = "21:30",
    last_sent_date: str | None = None,
    timezone_name: str = "Asia/Shanghai",
    reminder_email: str | None = None,
) -> SimpleNamespace:
    study_preferences: dict[str, object] = {
        "reminder_enabled": enabled,
        "reminder_time": reminder_time,
        "reminder_channel": "email",
    }
    if last_sent_date:
        study_preferences["last_email_reminder_date"] = last_sent_date
    if reminder_email is not None:
        study_preferences["reminder_email"] = reminder_email
    return SimpleNamespace(
        email="registered@example.com",
        timezone=timezone_name,
        account_preferences={"study_preferences": study_preferences},
    )


def test_reminder_uses_user_timezone_and_configured_time() -> None:
    user = reminder_user()

    local_date, due = _local_reminder_context(
        user,
        datetime(2026, 8, 18, 13, 30, tzinfo=timezone.utc),
    )

    assert local_date == "2026-08-18"
    assert due is True


def test_reminder_waits_until_local_time_and_sends_once_per_day() -> None:
    before_time = datetime(2026, 8, 18, 13, 29, tzinfo=timezone.utc)
    assert _local_reminder_context(reminder_user(), before_time) == ("2026-08-18", False)

    already_sent = reminder_user(last_sent_date="2026-08-18")
    at_time = datetime(2026, 8, 18, 13, 30, tzinfo=timezone.utc)
    assert _local_reminder_context(already_sent, at_time) == ("2026-08-18", False)


def test_disabled_reminder_is_never_due() -> None:
    user = reminder_user(enabled=False)
    assert _local_reminder_context(
        user,
        datetime(2026, 8, 18, 15, 0, tzinfo=timezone.utc),
    ) == ("2026-08-18", False)


def test_invalid_reminder_time_falls_back_to_2130() -> None:
    user = reminder_user(reminder_time="25:99")
    before_fallback = datetime(2026, 8, 18, 13, 29, tzinfo=timezone.utc)
    at_fallback = datetime(2026, 8, 18, 13, 30, tzinfo=timezone.utc)

    assert _local_reminder_context(user, before_fallback) == ("2026-08-18", False)
    assert _local_reminder_context(user, at_fallback) == ("2026-08-18", True)


def test_reminder_recipient_defaults_to_account_email_and_allows_override() -> None:
    assert _reminder_recipient(reminder_user()) == "registered@example.com"
    assert _reminder_recipient(reminder_user(reminder_email="alerts@example.com")) == "alerts@example.com"
    assert _reminder_recipient(reminder_user(reminder_email="  ")) == "registered@example.com"
