"""Freeze holdout-v2 inputs and environment hashes before its single run."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def normalized(text: str) -> set[str]:
    return {re.sub(r"[^\w\u4e00-\u9fff]", "", text).lower() for text in text.splitlines() if text.strip()}


def _git_output(*args: str) -> bytes:
    return subprocess.run(["git", *args], capture_output=True, check=True).stdout


def _source_files() -> tuple[list[Path], list[Path]]:
    production = sorted(path for path in Path("src").rglob("*.py") if path.is_file())
    evaluation = sorted(
        [path for path in Path("scripts").glob("*.py") if "synthetic" in path.name]
        + [path for path in Path("src/evaluation").rglob("*.py") if path.is_file()]
    )
    return production, evaluation


def _hashes(paths: list[Path]) -> dict[str, str]:
    return {str(path): sha(path) for path in paths}


def _near_duplicates(new_items: list[str], old_items: list[str]) -> list[dict[str, Any]]:
    from difflib import SequenceMatcher

    findings = []
    for new in new_items:
        normalized_new = next(iter(normalized(new)), "")
        for old in old_items:
            normalized_old = next(iter(normalized(old)), "")
            if not normalized_new or not normalized_old:
                continue
            ratio = SequenceMatcher(None, normalized_new, normalized_old).ratio()
            if ratio >= 0.86:
                findings.append({"new": new, "old": old, "sequence_ratio": round(ratio, 4)})
    return sorted(findings, key=lambda item: item["sequence_ratio"], reverse=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--main", type=Path, required=True)
    parser.add_argument("--v1", type=Path, required=True)
    parser.add_argument("--prior", type=Path, action="append", default=[])
    parser.add_argument("--runtime-manifest", type=Path, required=True)
    parser.add_argument("--fixture-audit", type=Path, required=True)
    parser.add_argument("--database-snapshot", type=Path, required=True)
    parser.add_argument("--expected-schema", default="synthetic-v20-holdout.v2")
    parser.add_argument("--manifest-name", default="holdout-v2-freeze-manifest.json")
    args = parser.parse_args()
    dataset = json.loads(args.dataset.read_text(encoding="utf-8"))
    if dataset.get("schema_version") != args.expected_schema:
        raise RuntimeError("unexpected holdout-v2 schema")
    expressions = dataset.get("expressions") or {}
    main_intents = json.loads(args.main.read_text()).get("intents") or []
    if set(expressions) != {str(item.get("id")) for item in main_intents}:
        raise RuntimeError("holdout-v2 intent ids differ")
    if any(len(rows) != 3 for rows in expressions.values()) or len(expressions) != 20:
        raise RuntimeError("holdout-v2 requires 20 intents x 3 expressions")
    prior_paths = [args.main, args.v1, *args.prior]
    prior_data = [json.loads(path.read_text(encoding="utf-8")) for path in prior_paths]
    new_items = [item for rows in expressions.values() for item in rows]
    old_items = [
        str(prompt)
        for source in prior_data
        for item in source.get("intents", [])
        for prompt in item.get("prompts", [])
    ]
    old_items += [
        str(item)
        for source in prior_data
        for rows in (source.get("expressions") or {}).values()
        for item in rows
    ]
    exact = sorted(set(normalized("\n".join(new_items))) & set(normalized("\n".join(old_items))))
    if exact:
        raise RuntimeError(f"holdout exact normalized duplicates found: {exact[:3]}")
    near = _near_duplicates(new_items, old_items)
    if near:
        raise RuntimeError(f"holdout near duplicates found: {near[:3]}")
    runtime_manifest = json.loads(args.runtime_manifest.read_text(encoding="utf-8"))
    fixture_audit = json.loads(args.fixture_audit.read_text(encoding="utf-8"))
    database_snapshot = json.loads(args.database_snapshot.read_text(encoding="utf-8"))
    if runtime_manifest.get("holdout_dataset_hash") != sha(args.dataset):
        raise RuntimeError("runtime case contracts do not reference this dataset hash")
    if runtime_manifest.get("case_count") != 60 or len(runtime_manifest.get("case_contracts") or []) != 60:
        raise RuntimeError("runtime manifest must freeze exactly 60 materialized case contracts")
    if not fixture_audit.get("pass"):
        raise RuntimeError("fixture audit did not pass")
    if database_snapshot.get("synthetic_users_present") != 30 or database_snapshot.get("orphan_tasks") != 0:
        raise RuntimeError("database snapshot invariants failed")

    production, evaluation = _source_files()
    if not production or not evaluation:
        raise RuntimeError("source inventory is unexpectedly empty")
    tracked = sorted(set(production + evaluation))
    diff = _git_output("diff", "--binary")
    cached_diff = _git_output("diff", "--binary", "--cached")
    status = _git_output("status", "--porcelain=v1", "-z")
    from src.core.agent.nodes.chat import ACTUAL_CONTEXT_TRACE_SCHEMA_HASH
    from src.evaluation.synthetic_v1.v20 import (
        RUBRIC_HASH,
        RUBRIC_VERSION,
        V20_JUDGE_PROMPT_HASH,
        V20_JUDGE_PROMPT_VERSION,
    )
    manifest = {
        "schema_version": "synthetic-v20-holdout-freeze.v2",
        "dataset": str(args.dataset), "dataset_hash": sha(args.dataset),
        "main_dataset_hash": sha(args.main), "holdout_v1_hash": sha(args.v1),
        "prior_dataset_hashes": {str(path): sha(path) for path in prior_paths},
        "intent_count": len(expressions), "expression_count": sum(len(rows) for rows in expressions.values()),
        "normalized_exact_duplicate_count": len(exact),
        "near_duplicate_threshold": 0.86,
        "near_duplicate_count": len(near),
        "runtime_manifest": str(args.runtime_manifest),
        "runtime_manifest_hash": sha(args.runtime_manifest),
        "fixture_audit": str(args.fixture_audit),
        "fixture_audit_hash": sha(args.fixture_audit),
        "database_snapshot": str(args.database_snapshot),
        "database_snapshot_hash": sha(args.database_snapshot),
        "materialized_case_contracts_hash": hashlib.sha256(
            json.dumps(runtime_manifest["case_contracts"], ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest(),
        "production_code_hashes": _hashes(production),
        "evaluation_code_hashes": _hashes(evaluation),
        "source_file_count": len(tracked),
        "workspace_diff_hash": hashlib.sha256(diff).hexdigest(),
        "workspace_cached_diff_hash": hashlib.sha256(cached_diff).hexdigest(),
        "workspace_status_hash": hashlib.sha256(status).hexdigest(),
        "git_head": _git_output("rev-parse", "HEAD").decode().strip(),
        "judge_prompt_version": V20_JUDGE_PROMPT_VERSION, "judge_prompt_hash": V20_JUDGE_PROMPT_HASH,
        "rubric_version": RUBRIC_VERSION, "rubric_hash": RUBRIC_HASH,
        "actual_context_trace_schema_hash": ACTUAL_CONTEXT_TRACE_SCHEMA_HASH,
        "database_invariants": database_snapshot,
        "single_run": True, "frozen_before_results": True,
    }
    args.output.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output / args.manifest_name
    if manifest_path.exists():
        raise RuntimeError("freeze manifest already exists; refusing to overwrite")
    snapshot_root = args.output / "source_snapshot"
    if snapshot_root.exists():
        raise RuntimeError("source snapshot already exists; freeze must be immutable")
    for path in tracked:
        target = snapshot_root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    manifest["source_snapshot"] = {
        "root": str(snapshot_root),
        "hashes": {str(path): sha(snapshot_root / path) for path in tracked},
    }
    expected_hashes = {**manifest["production_code_hashes"], **manifest["evaluation_code_hashes"]}
    if manifest["source_snapshot"]["hashes"] != expected_hashes:
        raise RuntimeError("source snapshot differs from frozen production hashes")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
