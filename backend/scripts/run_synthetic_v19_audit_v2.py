"""Create a read-only v19 audit-v2 derivative without altering historical evidence."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import AsyncSessionLocal
from src.evaluation.synthetic_v1.artifacts import read_jsonl, utc_iso
from src.evaluation.synthetic_v1.pilo_blackbox import PiloHttpClient
from src.evaluation.synthetic_v1.v19 import (
    ACTION_PROJECTION_HASH,
    ACTION_PROJECTION_VERSION,
    JUDGE_V3_PROMPT_HASH,
    JUDGE_V3_PROMPT_VERSION,
    aggregate_v19,
    build_judge_input,
    compact_observable_context,
    score_v19_case,
    user_visible_action_projection,
)
from src.models import User
from src.services.auth_session_service import issue_session


def dump(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def dump_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def nested_keys(value: Any) -> set[str]:
    if isinstance(value, dict):
        return {str(key).lower() for key in value} | {
            key for item in value.values() for key in nested_keys(item)
        }
    if isinstance(value, list):
        return {key for item in value for key in nested_keys(item)}
    return set()


def projection_quality(
    cases: list[dict[str, Any]], inputs: list[dict[str, Any]], contexts: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    projected_tasks = [task for row in inputs for task in row["pilo_observable_context"]["tasks"]]
    fields = ("done", "date", "estimatedMinutes", "actualMinutes", "priority", "masteryLevel", "version")
    errors = [
        run.get("error")
        for case in cases
        for turn in case.get("turns", [])
        for run in [turn.get("run") or {}]
        if run.get("error")
    ]
    projected_errors = [
        projection.get("error")
        for case in cases
        for turn in case.get("turns", [])
        for projection in [user_visible_action_projection(turn.get("run") or {})]
        if projection and projection.get("error")
    ]
    hashes = {
        str(row["case_id"]): hashlib.sha256(
            json.dumps(row, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()
        for row in inputs
    }
    forbidden = {"need_frame", "action_intent", "internal_prompt", "hidden_oracle", "trace"}
    profile_states = [
        compact_observable_context({"readback_before": {}}, context)["profile"]
        for context in contexts.values()
    ]
    available = sum(state.get("available") is True for state in profile_states)
    unavailable = sum(state.get("available") is False for state in profile_states)
    source_non_null_projection_losses = 0
    for row in inputs:
        case = next(case for case in cases if case["case_id"] == row["case_id"])
        source_tasks = (case.get("readback_before") or {}).get("/api/v1/tasks") or contexts[str(case["user_id"])]["tasks"]
        source_by_id = {task.get("id"): task for task in source_tasks}
        for task in row["pilo_observable_context"]["tasks"]:
            source = source_by_id.get(task.get("id"), {})
            source_non_null_projection_losses += sum(
                source.get(field) is not None and task.get(field) is None for field in fields
            )
    return {
        "schema_version": "synthetic-v19-projection-quality.v2",
        "generated_at": utc_iso(),
        "projection_version": ACTION_PROJECTION_VERSION,
        "projection_hash": ACTION_PROJECTION_HASH,
        "profile_users_available": available,
        "profile_users_unavailable": unavailable,
        "profile_users_total": len(contexts),
        "task_field_non_null": {
            field: sum(task.get(field) is not None for task in projected_tasks) for field in fields
        },
        "projected_task_rows": len(projected_tasks),
        "source_non_null_projection_losses": source_non_null_projection_losses,
        "source_action_errors": len(errors),
        "projected_action_errors": len(projected_errors),
        "action_error_projection_complete": Counter(errors) == Counter(projected_errors),
        "input_hashes": hashes,
        "unique_input_hashes": len(set(hashes.values())),
        "forbidden_fields_found": sorted(
            {key for row in inputs for key in nested_keys(row) if key in forbidden}
        ),
    }


def rejection_rows(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for case in cases:
        scoring = case.get("v19_scoring") or {}
        if scoring.get("outcome_type") != "rejected":
            continue
        runs = [
            turn.get("run") or {} for turn in case.get("turns", []) if (turn.get("run") or {}).get("id")
        ]
        events = [item for run in runs for item in (run.get("events") or [])]
        denied = [item for item in events if item.get("type") == "policy.denied"]
        operations = [
            operation
            for run in runs
            for approval in (run.get("approvals") or [])
            for operation in ((approval.get("change_set") or {}).get("operations") or [])
        ]
        projection = user_visible_action_projection(runs[-1]) if runs else None
        rows.append(
            {
                "case_id": case.get("case_id"),
                "intent_id": case.get("intent_id"),
                "run_id": runs[-1].get("id") if runs else None,
                "trigger_rules": [
                    code
                    for event in denied
                    for code in ((event.get("detail") or {}).get("review_finding_codes") or [])
                ],
                "operation_targets": [
                    {key: operation.get(key) for key in ("entity", "entity_id", "field", "label")}
                    for operation in operations
                ],
                "existing_risk_vs_incremental_risk": "requires_product_policy_review",
                "write_events": sum(
                    item.get("type") in {"executor.started", "executor.completed"} for item in events
                ),
                "visible_rejection": (projection or {}).get("error"),
            }
        )
    return rows


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--api-url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    if args.output.exists() and any(args.output.iterdir()):
        raise RuntimeError("audit output must be a new empty versioned directory")
    args.output.mkdir(parents=True, exist_ok=True)
    cases = read_jsonl(args.source / "cases.jsonl")
    user_ids = sorted({str(case["user_id"]) for case in cases})
    tokens: dict[str, str] = {}
    async with AsyncSessionLocal() as db:
        users = list((await db.execute(select(User).where(User.id.in_(user_ids)))).scalars())
        for user in users:
            tokens[user.id] = (await issue_session(db, user, remember_me=False)).access_token
        await db.commit()
    contexts: dict[str, dict[str, Any]] = {}
    async with httpx.AsyncClient(base_url=args.api_url, timeout=120, trust_env=False) as client:
        api = PiloHttpClient(client, tokens)
        for user_id in user_ids:
            goals = await api.request("GET", "/api/v1/goals", user_id)
            tasks = await api.request("GET", "/api/v1/tasks", user_id)
            try:
                profile = await api.request("GET", "/api/v1/learner/profile", user_id)
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code not in {403, 404}:
                    raise
                profile = {"available": False, "status_code": exc.response.status_code, "reason": "not authorized or not built"}
            contexts[user_id] = {"goals": goals, "tasks": tasks, "profile": profile}
    rescored = []
    inputs = []
    for original in cases:
        case = json.loads(json.dumps(original))
        case["v19_scoring"] = score_v19_case(case)
        context = compact_observable_context(case, contexts[str(case["user_id"])])
        rescored.append(case)
        inputs.append(build_judge_input(case, context))
    dump_jsonl(args.output / "cases.rescored.jsonl", rescored)
    dump_jsonl(args.output / "judge_inputs.v3.jsonl", inputs)
    summary = aggregate_v19(rescored, [])
    summary["source_directory"] = str(args.source)
    summary["source_cases_sha256"] = hashlib.sha256((args.source / "cases.jsonl").read_bytes()).hexdigest()
    dump(args.output / "deterministic_summary.json", summary)
    quality = projection_quality(rescored, inputs, contexts)
    dump(args.output / "projection_quality.json", quality)
    dump_jsonl(args.output / "rejection_analysis.jsonl", rejection_rows(rescored))
    manifest = {
        "schema_version": "synthetic-v19-audit-v2.manifest.v1",
        "created_at": utc_iso(),
        "source_directory": str(args.source),
        "source_immutable": True,
        "code_revision": subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip(),
        "projection_version": ACTION_PROJECTION_VERSION,
        "projection_hash": ACTION_PROJECTION_HASH,
        "judge_prompt_version": JUDGE_V3_PROMPT_VERSION,
        "judge_prompt_hash": JUDGE_V3_PROMPT_HASH,
        "case_count": len(rescored),
    }
    manifest["manifest_hash"] = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    dump(args.output / "manifest.json", manifest)
    print(json.dumps({"summary": summary, "projection_quality": quality}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
