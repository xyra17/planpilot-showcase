"""Run Phase 4 benchmark, optionally persist rows and write a JSON report."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import AsyncSessionLocal, engine  # noqa: E402
from src.intelligence.evaluation import evaluate_benchmark, persist_report  # noqa: E402


async def _persist(report: dict, cases: Path) -> None:
    try:
        async with AsyncSessionLocal() as db:
            await persist_report(db, report, cases)
    finally:
        await engine.dispose()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cases",
        type=Path,
        default=Path(__file__).parents[1] / "evals" / "agent_benchmark_v2.json",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--persist", action="store_true")
    args = parser.parse_args()
    report = evaluate_benchmark(args.cases)
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    if args.persist:
        asyncio.run(_persist(report, args.cases))
    print(rendered)
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
