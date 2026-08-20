"""Versioned deterministic Agent benchmark evaluation and persistence."""

from __future__ import annotations

import json
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.agents.coach_agent import CoachAgent
from src.intelligence.adaptive_planner import FailurePredictor
from src.intelligence.cognitive_model import knowledge_retention
from src.models import AgentEval, Task

BENCHMARK_NAME = "phase4-agent-benchmark-v2"


def evaluate_case(case: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    kind = case["kind"]
    expected = case["expected"]
    actual: dict[str, Any]
    if kind == "coach_action":
        context = case["input"]["context"]
        actual = {
            "action": CoachAgent.recommend_action(context),
            "window": CoachAgent.preferred_window(context),
        }
        passed = actual["action"] == expected["action"]
        if expected.get("window_contains"):
            passed = (
                passed
                and bool(actual["window"])
                and expected["window_contains"] in actual["window"]
            )
    elif kind == "failure_prediction":
        data = case["input"]
        scheduled_date = (
            date.today() + timedelta(days=int(data["scheduled_offset_days"]))
        ).isoformat()
        deadline = (date.today() + timedelta(days=int(data["deadline_offset_days"]))).isoformat()
        task = Task(
            title=data.get("title", "benchmark task"),
            goal_id="benchmark",
            scheduled_date=scheduled_date,
            estimated_mins=data["estimated_mins"],
            mastery_level=data.get("mastery_level", "unknown"),
        )
        actual = FailurePredictor.predict(
            task,
            completion_rate=data.get("completion_rate"),
            procrastination_score=data.get("procrastination_score"),
            current_daily_load_mins=data["current_daily_load_mins"],
            daily_capacity_mins=data["daily_capacity_mins"],
            deadline=deadline,
        )
        passed = actual["risk_level"] == expected["risk_level"]
        if expected.get("factor"):
            passed = passed and expected["factor"] in actual["factors"]
    elif kind == "retention":
        data = case["input"]
        retention = knowledge_retention(
            data["initial_score"], data["forgetting_rate"], data["elapsed_days"]
        )
        actual = {"retention": retention}
        passed = expected.get("min", 0.0) <= retention <= expected.get("max", 1.0)
    else:
        raise ValueError(f"unknown benchmark kind: {kind}")
    accuracy = 1.0 if passed else 0.0
    return {
        "case_id": case["id"],
        "category": case["category"],
        "kind": kind,
        "passed": passed,
        "actual": actual,
        "expected": expected,
        "metrics": {
            "planning_quality": accuracy,
            "recommendation_accuracy": accuracy,
            "user_acceptance": case.get("expected_acceptance"),
            "long_term_improvement": case.get("expected_improvement"),
        },
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def evaluate_benchmark(path: Path) -> dict[str, Any]:
    cases = json.loads(path.read_text(encoding="utf-8"))
    rows = [evaluate_case(case) for case in cases]
    passed = sum(row["passed"] for row in rows)
    categories = sorted({row["category"] for row in rows})
    return {
        "benchmark": BENCHMARK_NAME,
        "passed": passed,
        "total": len(rows),
        "pass_rate": passed / len(rows) if rows else 1.0,
        "category_scores": {
            category: sum(row["passed"] for row in rows if row["category"] == category)
            / sum(1 for row in rows if row["category"] == category)
            for category in categories
        },
        "cases": rows,
    }


async def persist_report(db: AsyncSession, report: dict[str, Any], cases_path: Path) -> int:
    cases = {row["id"]: row for row in json.loads(cases_path.read_text(encoding="utf-8"))}
    count = 0
    for result in report["cases"]:
        row = (
            await db.execute(
                select(AgentEval).where(
                    AgentEval.benchmark_name == report["benchmark"],
                    AgentEval.case_id == result["case_id"],
                )
            )
        ).scalar_one_or_none()
        if row is None:
            row = AgentEval(
                benchmark_name=report["benchmark"],
                case_id=result["case_id"],
                category=result["category"],
            )
            db.add(row)
        metrics = result["metrics"]
        row.input_case = cases[result["case_id"]]["input"]
        row.expected_output = result["expected"]
        row.actual_output = result["actual"]
        row.planning_quality = metrics["planning_quality"]
        row.recommendation_accuracy = metrics["recommendation_accuracy"]
        row.user_acceptance = metrics["user_acceptance"]
        row.long_term_improvement = metrics["long_term_improvement"]
        row.passed = result["passed"]
        row.prompt_version = "coach-v2"
        row.duration_ms = result["duration_ms"]
        count += 1
    await db.commit()
    return count


async def evaluation_summary(db: AsyncSession) -> dict[str, Any]:
    rows = list((await db.execute(select(AgentEval))).scalars())
    if not rows:
        return {"total": 0, "pass_rate": None, "metrics": {}, "categories": {}}
    categories = sorted({row.category for row in rows})
    return {
        "total": len(rows),
        "pass_rate": round(sum(row.passed for row in rows) / len(rows), 4),
        "metrics": {
            "planning_quality": round(sum(row.planning_quality for row in rows) / len(rows), 4),
            "recommendation_accuracy": round(
                sum(row.recommendation_accuracy for row in rows) / len(rows), 4
            ),
            "user_acceptance": _average([row.user_acceptance for row in rows]),
            "long_term_improvement": _average([row.long_term_improvement for row in rows]),
        },
        "categories": {
            category: round(
                sum(row.passed for row in rows if row.category == category)
                / sum(1 for row in rows if row.category == category),
                4,
            )
            for category in categories
        },
    }


def _average(values: list[float | None]) -> float | None:
    present = [value for value in values if value is not None]
    return round(sum(present) / len(present), 4) if present else None
