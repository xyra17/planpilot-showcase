"""Run deterministic guardrail evaluations for the Coach Agent."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.agents.coach_agent import CoachAgent  # noqa: E402


def evaluate(path: Path) -> dict[str, object]:
    cases = json.loads(path.read_text(encoding="utf-8"))
    rows = []
    for case in cases:
        context = case["context"]
        action = CoachAgent.recommend_action(context)
        window = CoachAgent.preferred_window(context)
        passed = action == case["expected_action"]
        expected_window = case.get("expected_window_contains")
        if expected_window:
            passed = passed and window is not None and expected_window in window
        rows.append(
            {
                "id": case["id"],
                "passed": passed,
                "actual_action": action,
                "actual_window": window,
            }
        )
    passed_count = sum(row["passed"] for row in rows)
    return {
        "passed": passed_count,
        "total": len(rows),
        "pass_rate": passed_count / len(rows) if rows else 1.0,
        "cases": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cases",
        type=Path,
        default=Path(__file__).parents[1] / "evals" / "coach_agent_cases_v1.json",
    )
    args = parser.parse_args()
    report = evaluate(args.cases)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
