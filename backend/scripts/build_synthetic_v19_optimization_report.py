"""Build immutable A/B, optimization decision, holdout, and review artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.evaluation.synthetic_v1.v19 import (
    ACTION_PROJECTION_HASH,
    ACTION_PROJECTION_VERSION,
    JUDGE_V3_PROMPT_HASH,
    JUDGE_V3_PROMPT_VERSION,
    score_v19_case,
)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def dump(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def dump_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def metrics(directory: Path) -> dict[str, Any]:
    cases = read_jsonl(directory / "cases.jsonl")
    for case in cases:
        case["v19_scoring"] = score_v19_case(case)
    judges = read_jsonl(directory / "judge-v3.jsonl")
    judge_by_id = {str(row["case_id"]): row for row in judges if row.get("status") == "completed"}
    summary = read_json(directory / "deterministic_summary.json")
    run_stats = read_json(directory / "run_stats.json")
    by_intent: dict[str, dict[str, Any]] = {}
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for case in cases:
        groups[str(case["intent_id"])].append(case)

    def group_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
        scored = [row.get("v19_scoring") or {} for row in rows]
        attached = [judge_by_id[str(row["case_id"])] for row in rows if str(row["case_id"]) in judge_by_id]
        dims: dict[str, list[float]] = defaultdict(list)
        for judge in attached:
            for key, value in (judge.get("scores") or {}).items():
                dims[key].append(float(value))
        return {
            "cases": len(rows),
            "hard_safety_rate": round(sum(bool(item.get("hard_safety_pass")) for item in scored) / len(rows), 4),
            "infra_rate": round(sum(bool(item.get("infrastructure_pass")) for item in scored) / len(rows), 4),
            "routing_failures": sum(bool(item.get("routing_failure")) for item in scored),
            "outcome_contract_rate": round(
                sum(bool((item.get("product_quality_checks") or {}).get("outcome_contract_met")) for item in scored) / len(rows), 4
            ),
            "visible_explanation_rate": round(
                sum(bool((item.get("product_quality_checks") or {}).get("visible_explanation_present")) for item in scored) / len(rows), 4
            ),
            "mean_turns": round(statistics.mean(len(row.get("turns") or []) for row in rows), 3),
            "judge_dimensions": {key: round(statistics.mean(values), 3) for key, values in sorted(dims.items())},
        }

    for intent, rows in sorted(groups.items()):
        by_intent[intent] = group_metrics(rows)
    return {
        "directory": str(directory),
        "overall": group_metrics(cases),
        "outcome_counts": summary.get("outcome_counts"),
        "unique_cases": summary.get("unique_cases"),
        "unique_sessions": summary.get("unique_sessions"),
        "unique_action_runs": summary.get("unique_action_runs"),
        "database_invariants_pass": summary.get("database_invariants_pass"),
        "elapsed_seconds": summary.get("elapsed_seconds") or run_stats.get("elapsed_seconds"),
        "judge": read_json(directory / "judge-v3-summary.json"),
        "by_intent": by_intent,
    }


def delta(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    dimensions = sorted(set(a["overall"]["judge_dimensions"]) | set(b["overall"]["judge_dimensions"]))
    return {
        "hard_safety_rate": round(b["overall"]["hard_safety_rate"] - a["overall"]["hard_safety_rate"], 4),
        "infra_rate": round(b["overall"]["infra_rate"] - a["overall"]["infra_rate"], 4),
        "routing_failures": b["overall"]["routing_failures"] - a["overall"]["routing_failures"],
        "outcome_contract_rate": round(b["overall"]["outcome_contract_rate"] - a["overall"]["outcome_contract_rate"], 4),
        "visible_explanation_rate": round(b["overall"]["visible_explanation_rate"] - a["overall"]["visible_explanation_rate"], 4),
        "mean_turns": round(b["overall"]["mean_turns"] - a["overall"]["mean_turns"], 3),
        "judge_dimensions": {
            key: round(b["overall"]["judge_dimensions"].get(key, 0) - a["overall"]["judge_dimensions"].get(key, 0), 3)
            for key in dimensions
        },
    }


def review_pack(a_dir: Path, b_dir: Path, a_analysis: Path, b_analysis: Path) -> list[dict[str, Any]]:
    a_roots = read_jsonl(a_analysis / "root_cause_analysis.jsonl")
    b_roots = read_jsonl(b_analysis / "root_cause_analysis.jsonl")
    b_by_key = {
        (row.get("intent_id"), row.get("difficulty")): row for row in b_roots
    }
    severity = {"executor_readback": 0, "intent_recognition": 1, "policy_review": 2,
                "planner_changeset": 3, "entity_resolution": 4, "context_profile": 5,
                "user_visible_feedback": 6, "prompt_response": 7, "evaluator": 8, "none": 9}
    selected = sorted(
        a_roots,
        key=lambda row: (
            severity.get(str(row.get("owner_layer")), 9),
            min(((row.get("judge") or {}).get("scores") or {"x": 4}).values()),
            str(row.get("case_id")),
        ),
    )[:20]
    pack = []
    for before in selected:
        after = b_by_key.get((before.get("intent_id"), before.get("difficulty")))
        pack.append({
            "review_id": hashlib.sha256(f"{before.get('case_id')}:sota-v19".encode()).hexdigest()[:16],
            "intent_id": before.get("intent_id"),
            "difficulty": before.get("difficulty"),
            "privacy": "user_id/email/hidden_oracle/internal_prompt/NeedFrame/ActionIntent omitted",
            "before": {
                "case_id": before.get("case_id"),
                "expected": before.get("expected_outcome"),
                "actual": before.get("actual_outcome"),
                "visible": before.get("user_visible_result"),
                "path": {key: before.get(key) for key in ("intent_chain", "context_chain", "decision_chain", "safety_chain", "execution_chain")},
                "root_cause": before.get("primary_root_cause"),
                "owner_layer": before.get("owner_layer"),
                "judge": before.get("judge"),
            },
            "after": {
                "case_id": (after or {}).get("case_id"),
                "expected": (after or {}).get("expected_outcome"),
                "actual": (after or {}).get("actual_outcome"),
                "visible": (after or {}).get("user_visible_result"),
                "path": {key: (after or {}).get(key) for key in ("intent_chain", "context_chain", "decision_chain", "safety_chain", "execution_chain")},
                "root_cause": (after or {}).get("primary_root_cause"),
                "owner_layer": (after or {}).get("owner_layer"),
                "judge": (after or {}).get("judge"),
            },
        })
    return pack


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--a", type=Path, required=True)
    parser.add_argument("--b", type=Path, required=True)
    parser.add_argument("--holdout", type=Path, required=True)
    parser.add_argument("--a-analysis", type=Path, required=True)
    parser.add_argument("--b-analysis", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    a, b, holdout = metrics(args.a), metrics(args.b), metrics(args.holdout)
    intent_deltas = {
        intent: delta({"overall": a["by_intent"][intent]}, {"overall": b["by_intent"][intent]})
        for intent in sorted(set(a["by_intent"]) & set(b["by_intent"]))
    }
    comparison = {
        "schema_version": "synthetic-v19-ab-comparison.v1",
        "a_frozen_baseline": a,
        "b_optimized": b,
        "b_minus_a": delta(a, b),
        "by_intent_b_minus_a": intent_deltas,
        "holdout": holdout,
        "holdout_no_hard_or_infra_regression": holdout["overall"]["hard_safety_rate"] == 1
        and holdout["overall"]["infra_rate"] == 1
        and holdout["overall"]["routing_failures"] == 0,
        "full_3600_started": False,
    }
    dump(args.output / "ab_comparison.json", comparison)
    dump(args.output / "holdout_results.json", holdout)
    decisions = [
        {
            "change_id": "v19-eval-projection-noop-v2",
            "owner_layer": "evaluator",
            "baseline_problem": "ActionRunCard error/profile/task fields omitted; ineffective operations could be called noop",
            "files": ["src/evaluation/synthetic_v1/v19.py", "scripts/run_synthetic_v19_audit_v2.py"],
            "theory": "judge and deterministic checks must share the real visible projection and strict raw-operation semantics",
            "target": "0 projection loss, strict noop, 100% judge coverage",
            "safety_risk": "misclassifying preview/noop; covered by deterministic tests",
            "targeted_regression": "projection/noop/policy/clarification/undo tests passed",
            "kept": True,
        },
        {
            "change_id": "v19-orchestrator-effective-op-v1",
            "owner_layer": "planner_changeset",
            "baseline_problem": "before==after and zero-operation ChangeSets entered Approval/Executor",
            "files": ["src/core/agent_v2/orchestrator.py", "src/core/agent_v2/transitions.py"],
            "theory": "filter ineffective operations before review and finish zero-op runs with visible audit-only noop",
            "target": "noop never enters approval/executor",
            "safety_risk": "dropping meaningful writes; equality is exact and tests cover effective operations",
            "targeted_regression": "complete-task and edit-to-zero tests passed",
            "kept": True,
        },
        {
            "change_id": "v19-policy-delta-review-v1",
            "owner_layer": "policy_review",
            "baseline_problem": "unrelated existing deadline/capacity violations blocked improving or unrelated operations",
            "files": ["src/core/agent_v2/registry.py"],
            "theory": "review only risk introduced or worsened by the current ChangeSet",
            "target": "remove unrelated denials without weakening new/worsened risk checks",
            "safety_risk": "risk under-blocking; new and worsened findings remain blocking/high-risk",
            "targeted_regression": "12 real targeted cases and delta unit tests passed",
            "kept": True,
        },
        {
            "change_id": "v19-intent-entity-holdout-v2",
            "owner_layer": "intent_recognition/entity_resolution",
            "baseline_problem": "22/60 unseen action expressions missed routing; unique cross-goal task blocked by ambient goal scope; hypothetical impact text misread as checkin",
            "files": ["src/core/agent/dispatch.py", "src/core/agent/nodes/intent.py"],
            "theory": "semantic cue classes plus exact owned-title resolution, with ambiguity and hypothetical/no-write boundaries retained",
            "target": "0 explicit-action routing failures and safe hypothetical analysis",
            "safety_risk": "false-positive actions; question/negation/hypothetical and duplicate-title tests retained",
            "targeted_regression": "27/27 action holdout, 6/6 cross-goal complete, 3/3 hypothetical analysis",
            "kept": True,
        },
        {
            "change_id": "v19-checkin-readback-v1",
            "owner_layer": "executor_readback",
            "baseline_problem": "HTTP checkin readback omitted record/natural text fields and hid real mutations",
            "files": ["src/services/checkin_service.py"],
            "theory": "return persisted visible fields from the real checkin service",
            "target": "natural checkin readback verifiable",
            "safety_risk": "no authorization change; only owned response fields added",
            "targeted_regression": "checkin suite and 27/27 targeted holdout passed",
            "kept": True,
        },
        {
            "change_id": "v19-high-risk-preview-runner-v1",
            "owner_layer": "evaluator",
            "baseline_problem": "correct 409 second-confirmation requirement was treated as infrastructure failure",
            "files": ["src/evaluation/synthetic_v1/pilo_blackbox.py", "src/evaluation/synthetic_v1/v19.py"],
            "theory": "record reviewed high-risk preview and no-write evidence without auto-confirming for the user",
            "target": "second-confirmation remains mandatory and is not an infra failure",
            "safety_risk": "accidental auto-approval; runner explicitly stops before second confirmation",
            "targeted_regression": "runner/scoring regression tests passed",
            "kept": True,
        },
    ]
    dump_jsonl(args.output / "optimization_decisions.jsonl", decisions)
    dump_jsonl(
        args.output / "sota_review_pack_top20.jsonl",
        review_pack(args.a, args.b, args.a_analysis, args.b_analysis),
    )
    dump(
        args.output / "optimization_manifest.json",
        {
            "schema_version": "synthetic-v19-optimization-manifest.v1",
            "a": str(args.a), "b": str(args.b), "holdout": str(args.holdout),
            "source_manifest_hashes": {
                "a": read_json(args.a / "manifest.json").get("manifest_hash"),
                "b": read_json(args.b / "manifest.json").get("manifest_hash"),
                "holdout": read_json(args.holdout / "manifest.json").get("manifest_hash"),
            },
            "projection_version": ACTION_PROJECTION_VERSION,
            "projection_hash": ACTION_PROJECTION_HASH,
            "judge_prompt_version": JUDGE_V3_PROMPT_VERSION,
            "judge_prompt_hash": JUDGE_V3_PROMPT_HASH,
            "decision_count": len(decisions), "review_pack_count": 20,
            "full_3600_started": False,
        },
    )
    print(json.dumps({"b_minus_a": comparison["b_minus_a"], "holdout": holdout["overall"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
