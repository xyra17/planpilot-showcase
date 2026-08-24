"""Build a versioned static development regression after holdout-v2 disclosure.

This is intentionally labelled development evidence.  It never rewrites or
replays holdout-v2 HTTP cases and must not be presented as unseen validation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.core.agent.dispatch import classify_agent_request
from src.core.agent.nodes.intent import _keyword_intent
from src.evaluation.synthetic_v1.artifacts import read_jsonl, utc_iso


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--analysis", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    rows = read_jsonl(args.analysis)
    results = []
    for row in rows:
        decision = classify_agent_request(str(row["message"]))
        expected_action = row["category"] in {
            "explicit_action_swallowed_by_conversation",
            "entity_or_date_resolution_failure",
        }
        if row["intent_id"] == "natural_checkin":
            passed = decision.mode == "conversation" and _keyword_intent(row["message"]) == "checkin"
            observed_path = "conversation_to_checkin_preview"
        elif expected_action:
            passed = decision.mode == "action"
            observed_path = f"{decision.mode}:{decision.capability}"
        else:
            passed = True
            observed_path = f"contract_calibration:{decision.mode}:{decision.capability}"
        results.append({**row, "current_observed_path": observed_path, "static_regression_pass": passed})
    (args.output / "cases.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in results),
        encoding="utf-8",
    )
    summary = {
        "schema_version": "synthetic-v20-development-regression.v1",
        "generated_at": utc_iso(),
        "development_set_contaminated_by_holdout_v2": True,
        "unseen_claim_allowed": False,
        "http_replayed": False,
        "cases": len(results),
        "static_regression_pass": sum(bool(row["static_regression_pass"]) for row in results),
        "baseline_categories": dict(Counter(row["category"] for row in results)),
        "source_analysis_sha256": sha(args.analysis),
        "production_hashes": {
            path: sha(Path(path))
            for path in (
                "src/core/agent/dispatch.py",
                "src/core/agent/nodes/intent.py",
                "src/evaluation/synthetic_v1/v19.py",
                "src/evaluation/synthetic_v1/v20.py",
            )
        },
    }
    (args.output / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
