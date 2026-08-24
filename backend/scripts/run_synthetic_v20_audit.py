"""Create a read-only v20 derivative from immutable evaluation evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.evaluation.synthetic_v1.artifacts import read_jsonl, utc_iso
from src.evaluation.synthetic_v1.v19 import score_v19_case
from src.evaluation.synthetic_v1.v20 import (
    RUBRIC_HASH,
    RUBRIC_VERSION,
    V20_JUDGE_PROMPT_HASH,
    V20_JUDGE_PROMPT_VERSION,
    build_v20_judge_input,
    classify_routing_failure,
    evidence_bound_root_cause,
    privacy_findings,
)


def dump(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def dump_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def redact_user_visible_internal_terms(value: Any) -> Any:
    """Create a judge-safe derivative while leaving immutable raw evidence untouched."""
    if isinstance(value, dict):
        return {key: redact_user_visible_internal_terms(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_user_visible_internal_terms(item) for item in value]
    if isinstance(value, str):
        result = value
        for pattern in (
            r"Need[\s_`-]*Frame(?:[\s_`-]*Resolved)?",
            r"Action[\s_`-]*Intent",
            r"Hidden[\s_`-]*Oracle",
            r"Internal[\s_`-]*Prompt",
        ):
            result = re.sub(pattern, "[用户可见内部术语已脱敏]", result, flags=re.IGNORECASE)
        return result
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--quarantine-privacy-findings",
        action="store_true",
        help="record raw user-visible leaks and redact only the derived judge input",
    )
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    cases = read_jsonl(args.source / "cases.jsonl")
    references = {
        str(row["case_id"]): dict(row.get("pilo_observable_context") or {})
        for row in read_jsonl(args.source / "judge_inputs.jsonl")
    }
    judges = {
        str(row["case_id"]): row
        for row in read_jsonl(args.output / "judge-v20.jsonl")
        if row.get("status") == "completed"
    }
    rescored, inputs, roots = [], [], []
    findings: list[dict[str, Any]] = []
    for original in cases:
        case = json.loads(json.dumps(original))
        original_scoring = dict(case.get("v19_scoring") or {})
        case["v19_scoring"] = score_v19_case(case)
        case["scoring_calibration"] = {
            "original_hard_safety_pass": original_scoring.get("hard_safety_pass"),
            "calibrated_hard_safety_pass": case["v19_scoring"].get("hard_safety_pass"),
            "original_rejection_type": original_scoring.get("rejection_type"),
            "calibrated_rejection_type": case["v19_scoring"].get("rejection_type"),
        }
        reference = references[str(case["case_id"])]
        judge_input = build_v20_judge_input(case, reference)
        case_findings = privacy_findings(judge_input)
        if case_findings:
            findings.append({"case_id": case["case_id"], "findings": case_findings})
            if args.quarantine_privacy_findings:
                judge_input = redact_user_visible_internal_terms(judge_input)
                judge_input["privacy_redaction"] = {
                    "applied": True,
                    "reason": "raw user-visible internal-term leak quarantined for independent judge",
                    "finding_paths": case_findings,
                }
                if privacy_findings(judge_input):
                    raise RuntimeError("v20 privacy redaction did not remove all forbidden content")
        rescored.append(case)
        inputs.append(judge_input)
        roots.append(
            evidence_bound_root_cause(case, judges.get(str(case["case_id"])), reference)
        )
    if findings and not args.quarantine_privacy_findings:
        raise RuntimeError(f"v20 privacy scan failed: {findings[:3]}")
    dump_jsonl(args.output / "cases.rescored.jsonl", rescored)
    dump_jsonl(args.output / "judge_inputs.v20.jsonl", inputs)
    dump_jsonl(args.output / "root_cause_analysis.v20.jsonl", roots)
    routing_analysis = [item for case in rescored if (item := classify_routing_failure(case))]
    dump_jsonl(args.output / "routing_failure_analysis.v20.jsonl", routing_analysis)
    classes = Counter(row["evidence_class"] for row in roots)
    owners = Counter(row["owner_layer"] for row in roots)
    routing_categories = Counter(row["category"] for row in routing_analysis)
    dump(
        args.output / "root_cause_summary.v20.json",
        {
            "cases": len(roots),
            "judge_attached": len(judges),
            "evidence_classes": dict(classes),
            "owner_layers": dict(owners),
            "routing_failure_categories": dict(routing_categories),
            "original_hard_safety_pass": sum(
                bool((row.get("scoring_calibration") or {}).get("original_hard_safety_pass"))
                for row in rescored
            ),
            "calibrated_hard_safety_pass": sum(
                bool((row.get("v19_scoring") or {}).get("hard_safety_pass"))
                for row in rescored
            ),
            "historical_trace_unavailable": sum(
                not row["context_build_and_injection"]["all_turns_captured"] for row in roots
            ),
        },
    )
    judge_by_id = judges
    severity = {"deterministic": 0, "high_confidence_inference": 1, "requires_human_review": 2}
    ranked = sorted(
        roots,
        key=lambda row: (
            severity[row["evidence_class"]],
            min(
                (
                    score
                    for score in (judge_by_id.get(str(row["case_id"]), {}).get("scores") or {}).values()
                    if score is not None
                ),
                default=4,
            ),
            str(row["case_id"]),
        ),
    )[:20]
    input_by_id = {str(row["case_id"]): row for row in inputs}
    pack = []
    case_by_id = {str(row["case_id"]): row for row in rescored}
    for root in ranked:
        case_id = str(root["case_id"])
        judge_input = input_by_id[case_id]
        pack.append(
            {
                "review_id": hashlib.sha256(f"v20:{case_id}".encode()).hexdigest()[:16],
                "case_id": case_id,
                "intent_id": root["intent_id"],
                "difficulty": case_by_id[case_id].get("difficulty"),
                "transcript": judge_input["transcript"],
                "reference_observable_facts": judge_input["reference_observable_facts"],
                "actual_context_trace": judge_input["actual_context_trace"],
                "expected_outcome_contract": judge_input["expected_outcome_contract"],
                "dimension_applicability": judge_input["dimension_applicability"],
                "deterministic_and_attribution_chain": root,
                "judge": judge_by_id.get(case_id),
            }
        )
    pack_findings = privacy_findings(pack)
    if pack_findings:
        raise RuntimeError(f"v20 review pack privacy scan failed: {pack_findings[:3]}")
    dump_jsonl(args.output / "sota_review_pack_top20.v20.jsonl", pack)
    dump(
        args.output / "privacy_scan.v20.json",
        {
            "key_and_content_scan_pass": not findings,
            "raw_evidence_findings": findings,
            "affected_cases": len(findings),
            "judge_derivative_redacted": bool(findings and args.quarantine_privacy_findings),
            "raw_evidence_untouched": True,
            "input_count": len(inputs),
            "pack_count": len(pack),
        },
    )
    source_hash = hashlib.sha256((args.source / "cases.jsonl").read_bytes()).hexdigest()
    dump(
        args.output / "manifest.v20.json",
        {
            "schema_version": "synthetic-v20-audit-manifest.v1",
            "generated_at": utc_iso(),
            "source": str(args.source),
            "source_cases_sha256": source_hash,
            "source_immutable": True,
            "rubric_version": RUBRIC_VERSION,
            "rubric_hash": RUBRIC_HASH,
            "judge_prompt_version": V20_JUDGE_PROMPT_VERSION,
            "judge_prompt_hash": V20_JUDGE_PROMPT_HASH,
            "case_count": len(cases),
            "privacy_quarantine_enabled": args.quarantine_privacy_findings,
            "privacy_affected_cases": len(findings),
        },
    )
    print(json.dumps({"cases": len(cases), "judges": len(judges), "classes": dict(classes), "owners": dict(owners)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
