"""Run the concise, versioned v19 product judge over frozen visible inputs."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.evaluation.synthetic_v1.artifacts import read_jsonl, utc_iso
from src.evaluation.synthetic_v1.v19 import (
    JUDGE_V2_PROMPT_HASH,
    JUDGE_V2_PROMPT_VERSION,
    JUDGE_V2_SYSTEM_PROMPT,
    JUDGE_V3_PROMPT_HASH,
    JUDGE_V3_PROMPT_VERSION,
    JUDGE_V3_SYSTEM_PROMPT,
    judge_case,
)


def _dump(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _jsonl_dump(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--provider", choices=("local", "smart"), default="local")
    parser.add_argument("--retry-failures", action="store_true")
    parser.add_argument("--judge-version", choices=("v2", "v3"), default="v2")
    parser.add_argument("--max-tokens", type=int, default=220)
    args = parser.parse_args()
    cases = read_jsonl(args.input / "cases.jsonl")
    inputs = read_jsonl(args.input / "judge_inputs.jsonl")
    if len(cases) not in {60, 120} or len(inputs) != len(cases):
        raise RuntimeError("judge requires a frozen 60- or 120-case matrix")
    input_by_id = {str(row["case_id"]): row for row in inputs}
    if set(input_by_id) != {str(row["case_id"]) for row in cases}:
        raise RuntimeError("case and judge input ids differ")
    forbidden_keys = {"need_frame", "action_intent", "internal_prompt", "hidden_oracle"}

    def keys(value: Any) -> set[str]:
        if isinstance(value, dict):
            return {str(key).lower() for key in value} | {
                nested for item in value.values() for nested in keys(item)
            }
        if isinstance(value, list):
            return {nested for item in value for nested in keys(item)}
        return set()

    if any(keys(row) & forbidden_keys for row in inputs):
        raise RuntimeError("judge input contains forbidden internal keys")

    judge_name = f"judge-{args.judge_version}"
    if args.judge_version == "v3":
        prompt_version, prompt_hash, system_prompt = (
            JUDGE_V3_PROMPT_VERSION,
            JUDGE_V3_PROMPT_HASH,
            JUDGE_V3_SYSTEM_PROMPT,
        )
    else:
        prompt_version, prompt_hash, system_prompt = (
            JUDGE_V2_PROMPT_VERSION,
            JUDGE_V2_PROMPT_HASH,
            JUDGE_V2_SYSTEM_PROMPT,
        )
    output = args.input / f"{judge_name}.jsonl"
    existing = read_jsonl(output)
    if args.retry_failures:
        failed = [row for row in existing if row.get("status") != "completed"]
        if failed:
            archive = args.input / f"{judge_name}-retry-archive.jsonl"
            archived = {row.get("case_id") for row in read_jsonl(archive)}
            with archive.open("a", encoding="utf-8") as handle:
                for row in failed:
                    if row.get("case_id") not in archived:
                        handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
            existing = [row for row in existing if row.get("status") == "completed"]
            _jsonl_dump(output, existing)
    complete_ids = {row.get("case_id") for row in existing if row.get("status") == "completed"}
    pending = [row for row in cases if row.get("case_id") not in complete_ids]
    semaphore = asyncio.Semaphore(max(1, args.concurrency))
    lock = asyncio.Lock()

    async def one(case: dict[str, Any]) -> None:
        async with semaphore:
            judge_input = input_by_id[str(case["case_id"])]
            result = await judge_case(
                case,
                dict(judge_input.get("pilo_observable_context") or {}),
                provider=args.provider,
                system_prompt=system_prompt,
                prompt_version=prompt_version,
                prompt_hash=prompt_hash,
                max_tokens=args.max_tokens,
            )
            async with lock:
                with output.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(result, ensure_ascii=False, sort_keys=True) + "\n")
                    handle.flush()

    await asyncio.gather(*(one(case) for case in pending))
    rows = read_jsonl(output)
    latest = {str(row["case_id"]): row for row in rows}
    final = [latest[str(case["case_id"])] for case in cases]
    completed = [row for row in final if row.get("status") == "completed"]
    dimensions: dict[str, list[int]] = defaultdict(list)
    for row in completed:
        for name, score in (row.get("scores") or {}).items():
            dimensions[name].append(int(score))
    summary = {
        "schema_version": f"synthetic-v19-judge-summary.{args.judge_version}",
        "generated_at": utc_iso(),
        "coverage": len(completed),
        "failures": len(final) - len(completed),
        "prompt_version": prompt_version,
        "prompt_hash": prompt_hash,
        "models": dict(Counter(row.get("judge_model") for row in final)),
        "providers": dict(Counter(row.get("judge_provider") for row in final)),
        "attempts": sum(int(row.get("attempts") or 0) for row in final),
        "retry_count": sum(max(0, int(row.get("attempts") or 0) - 1) for row in final),
        "dimensions": {
            name: round(sum(values) / len(values), 3)
            for name, values in sorted(dimensions.items())
            if values
        },
        "visible_input_boundary_pass": True,
        "usage": {
            key: sum(int((row.get("usage") or {}).get(key) or 0) for row in final)
            for key in ("input_tokens", "output_tokens", "total_tokens")
        },
    }
    _dump(args.input / f"{judge_name}-manifest.json", {
        "prompt_version": prompt_version,
        "prompt_hash": prompt_hash,
        "provider": args.provider,
        "case_count": len(cases),
        "input_count": len(inputs),
    })
    _dump(args.input / f"{judge_name}-summary.json", summary)
    case_by_id = {str(row["case_id"]): row for row in cases}
    low_quality = [
        {
            **row,
            "intent_id": case_by_id[str(row["case_id"])].get("intent_id"),
            "difficulty": case_by_id[str(row["case_id"])].get("difficulty"),
        }
        for row in completed
        if min((row.get("scores") or {"missing": 0}).values()) <= 1
    ]
    _jsonl_dump(args.input / f"{judge_name}-low-quality.jsonl", low_quality)
    deterministic = json.loads((args.input / "deterministic_summary.json").read_text())
    expected_count = len(cases)
    runtime_legacy = deterministic.get("runtime_result") or {}
    calibrated = {
        "cases": deterministic.get("cases"),
        "unique_cases": deterministic.get("unique_cases"),
        "unique_sessions": deterministic.get("unique_sessions"),
        "unique_action_runs": deterministic.get("unique_action_runs"),
        "outcome_counts": deterministic.get("outcome_counts"),
        "hard_safety_pass": deterministic.get("hard_safety_pass"),
        "hard_safety_failures": expected_count - int(deterministic.get("hard_safety_pass") or 0),
        "infrastructure_pass": deterministic.get("infrastructure_pass"),
        "infrastructure_failures": expected_count - int(deterministic.get("infrastructure_pass") or 0),
        "routing_failures": deterministic.get("routing_failures"),
        "database_invariants_pass": deterministic.get("database_invariants_pass"),
        "manifest_hash": deterministic.get("manifest_hash"),
    }
    final_summary = {
        "schema_version": "synthetic-v19-final-summary.v1",
        "deterministic_calibrated": calibrated,
        "legacy_runtime_scoring": {
            "schema_version": runtime_legacy.get("schema_version"),
            "hard_gate_failures": runtime_legacy.get("hard_gate_failures"),
            "mean_score": runtime_legacy.get("mean_score"),
            "not_used_for_v19_gate": True,
            "reason": "pre-v19 score_case does not apply calibrated outcome contracts",
        },
        "retry_evidence": {
            "pilo_infrastructure_records_archived": len(
                read_jsonl(args.input / "runtime/retry_archive.jsonl")
            ),
            "judge_v1_partial_records": len(read_jsonl(args.input / "judge.jsonl")),
            f"{judge_name}_connection_failures_archived": len(
                read_jsonl(args.input / f"{judge_name}-retry-archive.jsonl")
            ),
        },
        judge_name.replace("-", "_"): summary,
        "low_quality_cases": len(low_quality),
        "low_quality_by_intent": dict(
            Counter(str(row.get("intent_id")) for row in low_quality)
        ),
        "preflight_gate": {
            "cases_complete": calibrated["cases"] == expected_count
            and calibrated["unique_cases"] == expected_count
            and calibrated["unique_sessions"] == expected_count,
            "hard_safety_100_percent": calibrated["hard_safety_pass"] == expected_count,
            "infrastructure_100_percent": calibrated["infrastructure_pass"] == expected_count,
            "routing_failures_zero": calibrated["routing_failures"] == 0,
            "judge_coverage_100_percent": summary["coverage"] == expected_count
            and summary["failures"] == 0,
            "database_invariants_pass": bool(calibrated["database_invariants_pass"]),
        },
    }
    final_summary["eligible_for_independent_full_run_review"] = all(
        final_summary["preflight_gate"].values()
    )
    _dump(args.input / "summary.v19-final.json", final_summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
