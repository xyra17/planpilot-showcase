"""Run six real delete/approval/undo regressions against the repaired executor."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import httpx
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import AsyncSessionLocal
from src.evaluation.synthetic_v1.artifacts import JsonlArtifactStore
from src.evaluation.synthetic_v1.pilo_blackbox import BlackboxCase, BlackboxRunner, PiloHttpClient
from src.models import User
from src.services.auth_session_service import issue_session


def _task_rows(readback: dict | None) -> list[dict]:
    if not isinstance(readback, dict):
        return []
    rows = readback.get("/api/v1/tasks", [])
    return rows if isinstance(rows, list) else []


def _write_evidence_summary(output: Path) -> None:
    required_snapshot_fields = {
        "actual_mins",
        "completed_at",
        "description",
        "estimated_mins",
        "goal_id",
        "id",
        "kb_refs",
        "mastery_level",
        "plan_id",
        "priority",
        "scheduled_date",
        "sequence_in_plan",
        "stage_label",
        "status",
        "title",
        "type",
        "version",
    }
    evidence = []
    for line in (output / "cases.jsonl").read_text().splitlines():
        case = json.loads(line)
        turn = case["turns"][0]
        run = turn["run"]
        approvals = run.get("approvals") or []
        operations = approvals[0]["change_set"].get("operations", []) if approvals else []
        operation = operations[0] if operations else {}
        target_id = operation.get("entity_id")
        before_snapshot = operation.get("before") or {}
        before_rows = _task_rows(case.get("readback_before"))
        executed_rows = _task_rows(case.get("readback_after_execution"))
        undo_rows = _task_rows(case.get("readback_after_undo"))
        before_entity = next((row for row in before_rows if row.get("id") == target_id), None)
        undo_entity = next((row for row in undo_rows if row.get("id") == target_id), None)
        before_content = {k: v for k, v in (before_entity or {}).items() if k != "version"}
        undo_content = {k: v for k, v in (undo_entity or {}).items() if k != "version"}
        before_non_target = sorted(
            (row for row in before_rows if row.get("id") != target_id),
            key=lambda row: str(row.get("id")),
        )
        undo_non_target = sorted(
            (row for row in undo_rows if row.get("id") != target_id),
            key=lambda row: str(row.get("id")),
        )
        event_types = [event.get("type") for event in run.get("events", [])]
        chain = [
            "approval.requested",
            "approval.approved",
            "executor.started",
            "executor.completed",
            "run.completed",
            "executor.undo_started",
            "executor.undo_completed",
            "run.rolled_back",
        ]
        positions = [event_types.index(name) if name in event_types else -1 for name in chain]
        evidence.append(
            {
                "case_id": case["case_id"],
                "run_id": run.get("id"),
                "target_task_id": target_id,
                "change_set_before": before_snapshot,
                "change_set_missing_snapshot_fields": sorted(
                    required_snapshot_fields - before_snapshot.keys()
                ),
                "readback_before_target": before_entity,
                "readback_after_execution_target": next(
                    (row for row in executed_rows if row.get("id") == target_id), None
                ),
                "target_absent_after_execution": not any(
                    row.get("id") == target_id for row in executed_rows
                ),
                "readback_after_undo_target": undo_entity,
                "executor_result": (run.get("result") or {}).get("last_output"),
                "undo_result": (run.get("result") or {}).get("undo_result"),
                "target_content_equal_excluding_version": before_content == undo_content,
                "version_before": (before_entity or {}).get("version"),
                "version_after_undo": (undo_entity or {}).get("version"),
                "version_not_decreased": bool(
                    before_entity
                    and undo_entity
                    and undo_entity.get("version", 0) >= before_entity.get("version", 0)
                ),
                "non_target_entities_unchanged": before_non_target == undo_non_target,
                "approval_count": len(approvals),
                "audit_chain": chain,
                "audit_chain_positions": positions,
                "audit_chain_ordered": all(position >= 0 for position in positions)
                and positions == sorted(positions),
                "terminal": run.get("status"),
                "hard_gate_pass": case.get("hard_gate_pass"),
            }
        )
    (output / "evidence_summary.json").write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n"
    )


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-url", default="http://127.0.0.1:8000")
    parser.add_argument(
        "--source",
        type=Path,
        default=Path(
            "../documents/evaluations/synthetic-v1-20260823/route-recheck-v17/cases.jsonl"
        ),
    )
    parser.add_argument(
        "--fixture-source",
        type=Path,
        default=Path(
            "../documents/evaluations/synthetic-v1-20260823/route-regression-v16/cases.jsonl"
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("../documents/evaluations/synthetic-v1-20260823/undo-fix-v18"),
    )
    parser.add_argument("--case-ids", nargs="*", default=None)
    args = parser.parse_args()
    async with httpx.AsyncClient(base_url=args.api_url, timeout=10, trust_env=False) as ready:
        response = await ready.get("/ready")
        response.raise_for_status()
    rows = [json.loads(line) for line in args.source.read_text().splitlines() if line.strip()]
    delete_rows = [
        row for row in rows if row.get("intent_id") == "delete_task_high_risk" and row.get("turns")
    ]
    original_ids = ("sv1-50a8b5233b82d5ea", "sv1-0335cc68acabfd88")
    selected = [
        next(row for row in delete_rows if row.get("case_id") == case_id)
        for case_id in original_ids
    ]
    fixture_rows = [
        json.loads(line) for line in args.fixture_source.read_text().splitlines() if line.strip()
    ]
    fixture_delete_rows = [
        row
        for row in fixture_rows
        if row.get("intent_id") == "delete_task_high_risk"
        and row.get("turns")
        and row["turns"][0].get("run", {}).get("id")
    ]
    selected.extend(fixture_delete_rows)
    selected = selected[:6]
    if args.case_ids:
        requested_ids = set(args.case_ids)
        selected = [
            row
            for row in [*delete_rows, *fixture_delete_rows]
            if row.get("case_id") in requested_ids
        ]
    expected_selected = len(args.case_ids) if args.case_ids else 6
    if len(selected) != expected_selected:
        raise RuntimeError(f"expected {expected_selected} delete cases, got {len(selected)}")
    user_ids = {row["user_id"] for row in selected}
    async with AsyncSessionLocal() as db:
        users = list((await db.execute(select(User).where(User.id.in_(user_ids)))).scalars())
        tokens = {
            user.id: (await issue_session(db, user, remember_me=False)).access_token
            for user in users
        }
        await db.commit()
    cases = [
        BlackboxCase(
            case_id=f"v18-http-{row['case_id']}",
            user_id=row["user_id"],
            intent_id=row["intent_id"],
            repetition=row.get("repetition", 0),
            variant=row.get("variant", 0),
            prompt=row["turns"][0]["user_message"],
            goal_id=row.get("goal_id"),
            decision=row.get("decision", "undo"),
            expected=row.get("expected", {}),
            readback_paths=("/api/v1/tasks",),
            follow_up_rules=(),
            edit_patch=None,
        )
        for row in selected
    ]
    run_id = f"undo-fix-v18-{args.output.name}"
    store = JsonlArtifactStore(args.output, run_id)
    args.output.mkdir(parents=True, exist_ok=True)
    mapping = [
        {
            "source_case_id": row["case_id"],
            "v18_http_case_id": f"v18-http-{row['case_id']}",
            "source_artifact": str(
                args.source if row["case_id"] in original_ids else args.fixture_source
            ),
            "user_id": row["user_id"],
            "goal_id": row.get("goal_id"),
        }
        for row in selected
    ]
    (args.output / "case_mapping.json").write_text(
        json.dumps(mapping, ensure_ascii=False, indent=2) + "\n"
    )
    async with httpx.AsyncClient(base_url=args.api_url, timeout=180, trust_env=False) as client:
        runner = BlackboxRunner(
            PiloHttpClient(client, tokens),
            store,
            run_id=run_id,
            resume_command="python scripts/run_undo_fix_v18.py",
            concurrency=2,
        )
        result = await runner.run(cases)
    (args.output / "summary.json").write_text(
        json.dumps(
            {
                "expected_cases": expected_selected,
                "original_cases": sum(row["case_id"] in original_ids for row in selected),
                "same_class_fixture_cases": sum(
                    row["case_id"] not in original_ids for row in selected
                ),
                "runner_result": result,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    _write_evidence_summary(args.output)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
