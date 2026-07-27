from datetime import date

from src.core.replan_policy import expected_study_dates, should_suggest_replan


def test_weekday_policy_skips_weekend():
    # 2026-07-27 is Monday.
    end_date = date(2026, 7, 27)
    assert expected_study_dates(end_date, "weekday") == [
        "2026-07-27",
        "2026-07-24",
        "2026-07-23",
    ]


def test_replan_requires_every_expected_study_day():
    end_date = date(2026, 7, 27)
    rates = {
        "2026-07-27": 0.2,
        "2026-07-24": 0.4,
    }
    assert not should_suggest_replan(
        rates_by_date=rates,
        end_date=end_date,
        work_schedule="weekday",
    )


def test_replan_uses_execution_threshold():
    end_date = date(2026, 7, 27)
    low_rates = {
        "2026-07-27": 0.2,
        "2026-07-24": 0.4,
        "2026-07-23": 0.59,
    }
    assert should_suggest_replan(
        rates_by_date=low_rates,
        end_date=end_date,
        work_schedule="weekday",
    )
    low_rates["2026-07-23"] = 0.6
    assert not should_suggest_replan(
        rates_by_date=low_rates,
        end_date=end_date,
        work_schedule="weekday",
    )
