from datetime import date, timedelta


def expected_study_dates(
    end_date: date,
    work_schedule: str,
    count: int = 3,
) -> list[str]:
    """Return the latest planned study dates, newest first."""
    result: list[str] = []
    cursor = end_date
    while len(result) < count:
        weekday = cursor.weekday()
        is_study_day = (
            (work_schedule == "weekday" and weekday < 5)
            or (work_schedule == "weekend" and weekday >= 5)
            or work_schedule not in {"weekday", "weekend"}
        )
        if is_study_day:
            result.append(cursor.isoformat())
        cursor -= timedelta(days=1)
    return result


def should_suggest_replan(
    *,
    rates_by_date: dict[str, float],
    end_date: date,
    work_schedule: str,
    threshold: float = 0.6,
    required_days: int = 3,
) -> bool:
    """Suggest rescheduling only after consecutive low-execution study days."""
    dates = expected_study_dates(end_date, work_schedule, required_days)
    return all(
        day in rates_by_date and rates_by_date[day] < threshold
        for day in dates
    )
