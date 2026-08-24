#!/usr/bin/env python3
"""Run the reproducible synthetic-v1 longitudinal and Pilo evaluations."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path

import httpx
from sqlalchemy import func, select, text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import AsyncSessionLocal
from src.evaluation.synthetic_v1.artifacts import JsonlArtifactStore, read_jsonl
from src.evaluation.synthetic_v1.clock import SimulationClock
from src.evaluation.synthetic_v1.history_import import (
    BEHAVIOR_VERSION,
    GENERATOR_VERSION,
    build_profiles,
    import_longitudinal_history,
    replay_run_events,
)
from src.evaluation.synthetic_v1.pilo_blackbox import (
    BlackboxRunner,
    PiloHttpClient,
    build_balanced_cases,
    load_intents,
)
from src.evaluation.synthetic_v1.profile_eval import evaluate_profile_restoration
from src.evaluation.synthetic_v1.schemas import RunManifest, build_personas
from src.evaluation.synthetic_v1.scoring import score_case
from src.models import Goal, LearnerProfile, LearningEvent, Task, User
from src.services.auth_session_service import issue_session

BACKEND_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_ROOT.parent
DEFAULT_DOCUMENT_ROOT = PROJECT_ROOT / "documents" / "evaluations"
INTENTS_PATH = BACKEND_ROOT / "evals" / "synthetic-v1-intents.json"
SMOKE_INTENTS = {
    "status_overview",
    "targeted_advice",
    "replan_overdue",
    "create_task",
    "reject_preview",
    "delete_task_high_risk",
}


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _rescore_cases(artifacts: JsonlArtifactStore) -> None:
    rows = read_jsonl(artifacts.cases_path)
    for row in rows:
        if row.get("status") == "completed" and row.get("turns"):
            scoring = score_case(row)
            row["scoring"] = scoring
            row["score"] = scoring["score"]
            row["hard_gate_pass"] = scoring["hard_gate_pass"]
    encoded = "".join(
        json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
        for row in rows
    )
    temporary = artifacts.cases_path.with_suffix(".rescored.tmp")
    temporary.write_text(encoded, encoding="utf-8")
    temporary.replace(artifacts.cases_path)
    failures = [
        row
        for row in rows
        if row.get("status") in {"failed", "blocked"} or row.get("hard_gate_pass") is False
    ]
    artifacts.failures_path.write_text(
        "".join(
            json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
            for row in failures
        ),
        encoding="utf-8",
    )


async def _assert_main_database(db) -> None:
    name = await db.scalar(text("select current_database()"))
    if name != "planpilot":
        raise RuntimeError(f"refusing to run against {name!r}; expected 'planpilot'")


async def longitudinal(args: argparse.Namespace, output: Path) -> dict:
    personas = build_personas(args.seed)
    clock = SimulationClock(
        as_of=datetime.fromisoformat(args.evaluation_date + "T23:59:00+08:00"),
        history_days=60,
        timezone_name="Asia/Shanghai",
        seed=args.seed,
    )
    async with AsyncSessionLocal() as db:
        await _assert_main_database(db)
        generated = await import_longitudinal_history(
            db, run_id=args.run_id, personas=personas, clock=clock
        )
        user_ids = [row.user_id for row in generated]
        replay = await replay_run_events(db, user_ids=user_ids)
        as_of = clock.utc_at(59, hour=23, minute=59).replace(tzinfo=None)
        await build_profiles(db, user_ids=user_ids, as_of=as_of)
        first_profiles = int(
            await db.scalar(
                select(func.count(LearnerProfile.id)).where(LearnerProfile.user_id.in_(user_ids))
            )
            or 0
        )
        await build_profiles(db, user_ids=user_ids, as_of=as_of)
        second_profiles = int(
            await db.scalar(
                select(func.count(LearnerProfile.id)).where(LearnerProfile.user_id.in_(user_ids))
            )
            or 0
        )
        if first_profiles != second_profiles:
            raise RuntimeError("profile rebuild is not idempotent")
        profile_eval = await evaluate_profile_restoration(
            db, personas_by_user={row.user_id: persona for row, persona in zip(generated, personas)}
        )
        counts = {
            "users": len(user_ids),
            "goals": int(
                await db.scalar(select(func.count(Goal.id)).where(Goal.user_id.in_(user_ids))) or 0
            ),
            "tasks": int(
                await db.scalar(
                    select(func.count(Task.id)).join(Goal).where(Goal.user_id.in_(user_ids))
                )
                or 0
            ),
            "events": int(
                await db.scalar(
                    select(func.count(LearningEvent.id)).where(LearningEvent.user_id.in_(user_ids))
                )
                or 0
            ),
            "profiles": second_profiles,
        }

    manifest = RunManifest.create(
        seed=args.seed,
        created_at=datetime.fromisoformat(args.evaluation_date + "T00:00:00+08:00"),
        run_id=args.run_id,
    ).model_copy(
        update={
            "persona_ids": tuple(persona.persona_id for persona in personas),
            "user_ids": tuple(user_ids),
        }
    )
    _write_json(output / "manifest.json", manifest.model_dump(mode="json"))
    # Hidden truth is deliberately filesystem-only and never passed to Pilo.
    _write_json(
        output / "hidden_oracle.json",
        {
            "schema_version": "synthetic-hidden-oracle-v1",
            "run_id": args.run_id,
            "personas": [persona.model_dump(mode="json") for persona in personas],
        },
    )
    _write_json(output / "profile_evaluation.json", profile_eval)
    summary = {
        "run_id": args.run_id,
        "generator_version": GENERATOR_VERSION,
        "behavior_version": BEHAVIOR_VERSION,
        "seed": args.seed,
        "evaluation_date": args.evaluation_date,
        "counts": counts,
        "replay": replay,
        "profile_rebuild_idempotent": first_profiles == second_profiles,
        "profile_evaluation": {
            key: profile_eval[key]
            for key in ("case_count", "mean_score", "hard_boundary_pass", "failure_clusters")
        },
    }
    _write_json(output / "longitudinal_summary.json", summary)
    return summary


async def _public_users(db, user_ids: list[str]) -> list[dict]:
    rows: list[dict] = []
    for user_id in user_ids:
        goal = await db.scalar(
            select(Goal)
            .where(Goal.user_id == user_id, Goal.status == "active")
            .order_by(Goal.created_at)
            .limit(1)
        )
        task = await db.scalar(
            select(Task)
            .join(Goal)
            .where(Goal.user_id == user_id)
            .order_by(Task.created_at)
            .limit(1)
        )
        rows.append(
            {
                "user_id": user_id,
                "active_goal_id": goal.id if goal else None,
                "active_goal_title": goal.title if goal else "当前目标",
                "visible_task_title": task.title if task else "今天的任务",
            }
        )
    return rows


async def conversations(
    args: argparse.Namespace,
    output: Path,
    *,
    full: bool,
    rerun_intent: str | None = None,
) -> dict:
    manifest = _load_json(output / "manifest.json")
    if manifest["run_id"] != args.run_id:
        raise RuntimeError("manifest run_id mismatch")
    user_ids = list(manifest["user_ids"])
    async with AsyncSessionLocal() as db:
        await _assert_main_database(db)
        users = await _public_users(db, user_ids)
        tokens: dict[str, str] = {}
        for user_id in user_ids:
            user = await db.get(User, user_id)
            if user is None:
                raise RuntimeError(f"manifest user missing: {user_id}")
            session = await issue_session(db, user, remember_me=True)
            tokens[user_id] = session.access_token
        await db.commit()

    intents = load_intents(INTENTS_PATH)
    if not full:
        intents = [item for item in intents if item["id"] in SMOKE_INTENTS]
        repetitions, variants, phase = 2, 1, "smoke-360"
    else:
        repetitions, variants, phase = 3, 2, "full-3600"
    cases = build_balanced_cases(
        users, intents, repetitions=repetitions, variants=variants, seed=args.seed
    )
    expected = 3600 if full else 360
    if len(cases) != expected:
        raise RuntimeError(f"invalid {phase} matrix: expected {expected}, got {len(cases)}")
    phase_dir = output / phase
    artifacts = JsonlArtifactStore(phase_dir, args.run_id)
    if rerun_intent:
        retry_ids = {
            row["case_id"]
            for row in read_jsonl(artifacts.cases_path)
            if row.get("intent_id") == rerun_intent and row.get("status") == "failed"
        }
        archived = artifacts.prepare_retry(retry_ids)
        print(
            json.dumps(
                {"retry_intent": rerun_intent, "archived_cases": archived}, ensure_ascii=False
            )
        )
    resume = (
        f"cd {BACKEND_ROOT} && uv run python scripts/run_synthetic_longitudinal_eval.py "
        f"{('full' if full else 'smoke')} --run-id {args.run_id} --seed {args.seed} "
        f"--evaluation-date {args.evaluation_date}"
    )
    async with httpx.AsyncClient(base_url=args.api_url, timeout=180.0) as client:
        runner = BlackboxRunner(
            PiloHttpClient(client, tokens),
            artifacts,
            run_id=args.run_id,
            resume_command=resume,
            max_conversation_turns=args.max_turns,
            concurrency=args.concurrency,
        )
        result = await runner.run(cases)
    _rescore_cases(artifacts)
    if result.get("status") != "blocked":
        result = artifacts.finalize(case.case_id for case in cases)
    _write_json(
        phase_dir / "matrix.json",
        {
            "phase": phase,
            "users": 30,
            "intents": len(intents),
            "repetitions": repetitions,
            "variants": variants,
            "expected_cases": expected,
            "intent_ids": [item["id"] for item in intents],
        },
    )
    return result


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("longitudinal", "smoke", "full", "all"))
    parser.add_argument("--run-id", default="synthetic-v1-20260823")
    parser.add_argument("--seed", type=int, default=20260823)
    parser.add_argument("--evaluation-date", default="2026-08-23")
    parser.add_argument("--api-url", default="http://127.0.0.1:8000")
    parser.add_argument("--output-root", type=Path, default=DEFAULT_DOCUMENT_ROOT)
    parser.add_argument("--max-turns", type=int, default=4)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--rerun-intent")
    args = parser.parse_args()
    output = args.output_root / args.run_id
    if args.phase in {"longitudinal", "all"}:
        print(json.dumps(await longitudinal(args, output), ensure_ascii=False, indent=2))
    if args.phase in {"smoke", "all"}:
        print(
            json.dumps(
                await conversations(args, output, full=False, rerun_intent=args.rerun_intent),
                ensure_ascii=False,
                indent=2,
            )
        )
    if args.phase in {"full", "all"}:
        print(
            json.dumps(await conversations(args, output, full=True), ensure_ascii=False, indent=2)
        )


if __name__ == "__main__":
    asyncio.run(main())
