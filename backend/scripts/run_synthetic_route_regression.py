#!/usr/bin/env python3
"""Run 18 real Pilo routing regressions (6 each for three action intents)."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import replace
from pathlib import Path

import httpx
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.run_synthetic_longitudinal_eval import _public_users
from src.database import AsyncSessionLocal
from src.evaluation.synthetic_v1.artifacts import JsonlArtifactStore
from src.evaluation.synthetic_v1.pilo_blackbox import (
    BlackboxRunner,
    PiloHttpClient,
    build_balanced_cases,
    load_intents,
)
from src.evaluation.synthetic_v1.scoring import score_case
from src.models import User
from src.services.auth_session_service import issue_session


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-url", default="http://127.0.0.1:8000")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("../documents/evaluations/synthetic-v1-20260823/route-regression-v1"),
    )
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--original-context", action="store_true")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("../documents/evaluations/synthetic-v1-20260823/manifest.json"),
    )
    args = parser.parse_args()

    # Do not start a run against a restarting/unready API: otherwise the
    # resulting evidence mixes transport failures with routing behavior.
    async with httpx.AsyncClient(base_url=args.api_url, timeout=10.0) as readiness:
        ready = await readiness.get("/ready")
        ready.raise_for_status()
        payload = ready.json()
        if payload.get("status") != "ready":
            raise RuntimeError(f"API is not ready: {payload}")

    async with AsyncSessionLocal() as db:
        if args.original_context:
            manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
            user_ids = list(manifest["user_ids"])
            if len(user_ids) != 30:
                raise RuntimeError(f"manifest must contain 30 users, got {len(user_ids)}")
            users_all = list((await db.execute(select(User).where(User.id.in_(user_ids)))).scalars())
            if {u.id for u in users_all} != set(user_ids):
                raise RuntimeError("manifest user_ids do not all exist in the main database")
        else:
            users_all = list((await db.execute(
                select(User).where(User.email.like("%@synthetic.planpilot.invalid")).order_by(User.id)
            )).scalars())[:6]
        users = await _public_users(db, [user.id for user in users_all])
        tokens = {}
        for user in users_all:
            tokens[user.id] = (await issue_session(db, user, remember_me=True)).access_token
        await db.commit()

    wanted = {"create_task", "replan_overdue", "delete_task_high_risk"}
    async with httpx.AsyncClient(base_url=args.api_url, timeout=60.0) as setup_client:
        for index, user in enumerate(users if not args.original_context else []):
            # Every run gets unique task titles.  Reusing a title across
            # versions intentionally triggers the product's ambiguity guard
            # and makes a routing regression impossible to evaluate.
            run_label = args.output.name.replace("/", "-")
            title = f"route-regression-{run_label}-delete-{index + 1}"
            goal_response = await setup_client.post(
                "/api/v1/goals",
                headers={"Authorization": f"Bearer {tokens[user['user_id']]}"},
                json={
                    "type": "skill",
                    "title": f"{run_label} safety fixture {index + 1}",
                    "deadline": "2027-12-31",
                    "daily_hours": 2.0,
                    "current_level": "beginner",
                    "work_schedule": "all",
                },
            )
            goal_response.raise_for_status()
            user["delete_goal_id"] = goal_response.json()["id"]
            response = await setup_client.post(
                "/api/v1/tasks",
                headers={"Authorization": f"Bearer {tokens[user['user_id']]}"},
                json={
                    "title": title,
                    "goalId": user["delete_goal_id"],
                    "done": False,
                    "estimatedMinutes": 30,
                    "date": "2026-08-24",
                    "priority": "medium",
                },
            )
            response.raise_for_status()
            user["visible_task_title"] = title
            overdue_response = await setup_client.post(
                "/api/v1/tasks",
                headers={"Authorization": f"Bearer {tokens[user['user_id']]}"},
                json={
                    "title": f"{run_label}-overdue-{index + 1}",
                    "goalId": user["delete_goal_id"],
                    "done": False,
                    "estimatedMinutes": 15,
                    "date": "2026-08-01",
                    "priority": "medium",
                },
            )
            overdue_response.raise_for_status()
    intents = [
        item for item in load_intents("evals/synthetic-v1-intents.json") if item["id"] in wanted
    ]
    repetitions = 2 if args.original_context else 1
    cases = build_balanced_cases(users, intents, repetitions=repetitions, variants=1, seed=20260823)
    # Delete cases use the isolated, future-dated fixture goal.  Keep the
    # original active goal for create/replan cases so their semantics remain
    # representative of the user's real context.
    fixture_by_user = {u["user_id"]: u for u in users}
    for index, case in enumerate(cases):
        if not args.original_context:
            fixture = fixture_by_user[case.user_id]
        if not args.original_context and case.intent_id in {"create_task", "replan_overdue", "delete_task_high_risk"}:
            prompt = case.prompt
            if case.intent_id == "create_task":
                create_title = f"{fixture['visible_task_title']}-create"
                prompt = prompt.replace(
                    fixture["visible_task_title"],
                    create_title,
                )
            cases[index] = replace(
                case,
                goal_id=fixture["delete_goal_id"],
                prompt=prompt,
            )
    expected_cases = 180 if args.original_context else 18
    if len(cases) != expected_cases:
        raise RuntimeError(f"expected {expected_cases} regression cases, got {len(cases)}")
    regression_run_id = f"synthetic-route-regression-{args.output.name}"
    store = JsonlArtifactStore(args.output, regression_run_id)
    async with httpx.AsyncClient(base_url=args.api_url, timeout=180.0) as client:
        runner = BlackboxRunner(
            PiloHttpClient(client, tokens),
            store,
            run_id=regression_run_id,
            resume_command="python scripts/run_synthetic_route_regression.py",
            concurrency=args.concurrency,
        )
        result = await runner.run(cases)
    rows = [json.loads(line) for line in store.cases_path.read_text().splitlines() if line.strip()]
    if args.original_context:
        smoke_path = args.output.parent / "smoke-360" / "cases.jsonl"
        smoke_rows = {
            row["case_id"]: row
            for row in (json.loads(line) for line in smoke_path.read_text().splitlines() if line.strip())
            if row.get("intent_id") in wanted
        }
        mapping_path = args.output / "case-mapping.jsonl"
        mapping_path.write_text(
            "".join(
                json.dumps(
                    {
                        "smoke_case_id": smoke_case.get("case_id"),
                        "v17_case_id": row.get("case_id"),
                        "intent_id": row.get("intent_id"),
                        "user_id": row.get("user_id"),
                        "run_ids": [
                            turn.get("run", {}).get("id")
                            for turn in row.get("turns", [])
                            if turn.get("run", {}).get("id")
                        ],
                    },
                    ensure_ascii=False,
                )
                + "\n"
                for row in rows
                for smoke_case in [smoke_rows.get(row.get("case_id"), {})]
            ),
            encoding="utf-8",
        )
    summary = {
        "expected_cases": expected_cases,
        "recorded_cases": len(rows),
        "by_intent": {},
        "real_run_ids": sum(
            bool(turn.get("run", {}).get("id")) for row in rows for turn in row.get("turns", [])
        ),
        "approval_visible": sum(
            bool(turn.get("run", {}).get("approvals"))
            for row in rows
            for turn in row.get("turns", [])
        ),
        "routing_failures": sum(
            (row.get("scoring") or score_case(row)).get("routing_failure") is not None
            for row in rows
        ),
        "runner_result": result,
    }
    for intent in sorted(wanted):
        subset = [row for row in rows if row.get("intent_id") == intent]
        summary["by_intent"][intent] = {
            "cases": len(subset),
            "run_ids": sum(
                bool(turn.get("run", {}).get("id"))
                for row in subset
                for turn in row.get("turns", [])
            ),
            "routing_failures": sum(
                (row.get("scoring") or score_case(row)).get("routing_failure") is not None
                for row in subset
            ),
            "hard_gate_pass": sum(row.get("hard_gate_pass") is True for row in subset),
        }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
