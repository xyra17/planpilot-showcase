"""Generate per-case v19 root-cause evidence and optimization clusters."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.evaluation.synthetic_v1.artifacts import read_jsonl, utc_iso
from src.evaluation.synthetic_v1.v19 import score_v19_case, user_visible_action_projection

LAYERS = (
    "intent_recognition", "entity_resolution", "context_profile", "prompt_response",
    "planner_changeset", "policy_review", "executor_readback", "user_visible_feedback",
    "evaluator",
)


def dump(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def dump_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text("".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows), encoding="utf-8")


def analyze(case: dict[str, Any], judge: dict[str, Any] | None, judge_input: dict[str, Any]) -> dict[str, Any]:
    scoring = case.get("v19_scoring") or {}
    runs = [turn.get("run") or {} for turn in case.get("turns", []) if (turn.get("run") or {}).get("id")]
    run = runs[-1] if runs else {}
    events = [event for item in runs for event in (item.get("events") or [])]
    event_types = [str(event.get("type")) for event in events]
    denied = [event for event in events if event.get("type") == "policy.denied"]
    operations = [
        operation for item in runs for approval in (item.get("approvals") or [])
        for operation in ((approval.get("change_set") or {}).get("operations") or [])
    ]
    context = judge_input.get("pilo_observable_context") or {}
    profile = context.get("profile") or {}
    actual = scoring.get("outcome_type")
    allowed = list((case.get("outcome_contract") or {}).get("allowed_outcomes") or [])
    mismatch = actual not in allowed
    root = "correct_safe_behavior"
    owner = "none"
    fix = "无需产品修改；保留证据"
    secondary: list[str] = []
    confidence = 0.9
    if not scoring.get("hard_safety_pass"):
        root, owner, fix = "hard_safety_or_readback_failure", "executor_readback", "修复执行/回读/Undo并保持硬门禁"
    elif mismatch and actual == "rejected" and denied:
        codes = [code for event in denied for code in ((event.get("detail") or {}).get("review_finding_codes") or [])]
        if "deadline_exceeded" in codes:
            root, owner, fix = "unrelated_existing_risk_blocked_delta", "policy_review", "风险审查仅阻止本次新增或恶化的违规"
        else:
            root, owner, fix = "policy_rejection_contract_mismatch", "policy_review", "核对本次变更增量风险与 outcome contract"
    elif mismatch and actual == "noop" and "action.noop" in event_types:
        root, owner, fix = "idempotent_state_not_allowed_by_contract", "evaluator", "基于 pre-run 状态允许严格零操作 noop"
        secondary.append("data_fixture_already_in_target_state")
    elif mismatch and case.get("intent_id") == "cancel_action":
        root, owner, fix = "isolated_cancel_fixture_has_no_pending_action", "evaluator", "取消用例先建立同 session 待处理行动，或允许安全说明"
        secondary.append("entity_or_slot_clarification")
    elif not (scoring.get("product_quality_checks") or {}).get("visible_explanation_present", True):
        root, owner, fix = "missing_user_visible_feedback", "user_visible_feedback", "在 ActionRunCard 中显示安全原因或 noop 结果"
    elif judge and judge.get("status") == "completed" and min((judge.get("scores") or {}).values(), default=4) <= 1:
        if profile.get("available") and (judge.get("scores") or {}).get("profile_use", 4) <= 1:
            root, owner, fix = "available_profile_not_used", "context_profile", "提升相关画像/任务证据排序与上下文利用"
        else:
            root, owner, fix = "generic_or_unclear_visible_response", "prompt_response", "只针对该回答簇调整响应指令并做 holdout"
    projection = user_visible_action_projection(run)
    prompt = str(
        case.get("prompt")
        or ((case.get("turns") or [{}])[0].get("user_message"))
        or ""
    )
    speech_act = "question" if prompt.rstrip().endswith(("?", "？")) else "command"
    supporting = [str(event.get("id")) for event in events if event.get("id")]
    return {
        "case_id": case.get("case_id"),
        "user_id": case.get("user_id"),
        "intent_id": case.get("intent_id"),
        "difficulty": case.get("difficulty"),
        "user_core_need": prompt,
        "expected_outcome": allowed,
        "actual_outcome": actual,
        "outcome_difference": "none" if not mismatch else f"{actual} not in {allowed}",
        "intent_chain": {
            "conversation_or_action": "action" if runs else "conversation",
            "speech_act": speech_act,
            "core_need_expected": case.get("intent_id"),
            "action_objective": run.get("objective"),
            "goal_slot": case.get("goal_id"),
            "task_slot": case.get("target_task_title"),
            "pre_run_facts": case.get("pre_run_observable_facts"),
            "clarification_triggered": actual == "clarification" or (not runs and "确认" in str((case.get("turns") or [{}])[-1].get("run", {}).get("pilo_visible_text") or "")),
        },
        "context_chain": {
            "profile_authorized_and_available": profile.get("available"),
            "profile_scope": profile.get("scope"),
            "relevant_goals_in_context": len(context.get("goals") or []),
            "relevant_tasks_in_context": len(context.get("tasks") or []),
            "truncation": context.get("context_truncation"),
            "judge_profile_use_score": (judge or {}).get("scores", {}).get("profile_use"),
        },
        "decision_chain": {
            "run_id": run.get("id"), "run_status": run.get("status"),
            "planner": (run.get("plan_history") or [{}])[-1].get("planner") if run.get("plan_history") else None,
            "tools": [step.get("tool_name") for step in (run.get("steps") or [])],
            "operation_count": len(operations),
        },
        "safety_chain": {
            "policy_denied": bool(denied),
            "finding_codes": [code for event in denied for code in ((event.get("detail") or {}).get("review_finding_codes") or [])],
            "delta_assessment": "existing_or_unrelated" if root == "unrelated_existing_risk_blocked_delta" else "not_established",
        },
        "execution_chain": {
            "approval": "approval.approved" in event_types,
            "executor": "executor.completed" in event_types,
            "readback_verified": (scoring.get("hard_safety") or {}).get("readback_verified"),
            "undo": "run.rolled_back" in event_types,
        },
        "user_visible_result": {
            "pilo_text": (case.get("turns") or [{}])[-1].get("run", {}).get("pilo_visible_text"),
            "action_run_card": projection,
        },
        "classification": (
            "correct_safe_behavior"
            if root == "correct_safe_behavior"
            else "data_or_fixture_issue"
            if any(item.startswith("data_fixture") for item in secondary)
            else "evaluator_issue"
            if owner == "evaluator"
            else "product_issue"
        ),
        "primary_root_cause": root,
        "secondary_root_causes": secondary,
        "owner_layer": owner,
        "recommended_fix": fix,
        "confidence": confidence,
        "supporting_evidence_ids": supporting,
        "judge": judge,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    cases = read_jsonl(args.input / "cases.jsonl")
    # Analysis is a versioned derivative. Always apply the current calibrated
    # scorer in memory so historical raw JSONL stays immutable while evaluator
    # fixes (for example reviewed high-risk previews) are reflected explicitly.
    for case in cases:
        case["v19_scoring"] = score_v19_case(case)
    inputs = {str(row["case_id"]): row for row in read_jsonl(args.input / "judge_inputs.jsonl")}
    judges = {str(row["case_id"]): row for row in read_jsonl(args.input / "judge-v3.jsonl") if row.get("status") == "completed"}
    rows = [analyze(case, judges.get(str(case["case_id"])), inputs[str(case["case_id"])]) for case in cases]
    dump_jsonl(args.output / "root_cause_analysis.jsonl", rows)
    clusters: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row["owner_layer"] in LAYERS:
            clusters[row["owner_layer"]].append(row)
    cluster_summary = {
        layer: {
            "count": len(clusters.get(layer, [])),
            "intents": dict(Counter(row["intent_id"] for row in clusters.get(layer, []))),
            "difficulties": dict(Counter(row["difficulty"] for row in clusters.get(layer, []))),
            "profile_availability": dict(
                Counter(
                    "available"
                    if (row.get("context_chain") or {}).get("profile_authorized_and_available")
                    else "unavailable"
                    for row in clusters.get(layer, [])
                )
            ),
            "representative_cases": [row["case_id"] for row in clusters.get(layer, [])[:5]],
            "root_causes": dict(Counter(row["primary_root_cause"] for row in clusters.get(layer, []))),
            "priority": "P0" if layer in {"intent_recognition", "executor_readback"} else "P1" if clusters.get(layer) else "P2",
            "recommended_fix": clusters.get(layer, [{}])[0].get("recommended_fix") if clusters.get(layer) else None,
            "impact": "hard safety or explicit action correctness" if layer in {"intent_recognition", "executor_readback"} else "product quality and outcome contract",
            "expected_benefit": "remove the evidenced cluster without weakening safety; validate on frozen matrix and unseen holdout",
            "risk": "must preserve hard safety and holdout performance",
        }
        for layer in LAYERS
    }
    dump(args.output / "failure_clusters.json", {"generated_at": utc_iso(), "clusters": cluster_summary})
    severity = {"P0": 0, "P1": 1, "P2": 2}
    ranked = sorted(
        [row for row in rows if row["owner_layer"] != "none"],
        key=lambda row: (severity.get(cluster_summary.get(row["owner_layer"], {}).get("priority"), 3), row["case_id"]),
    )[:20]
    dump_jsonl(args.output / "sota_review_pack.jsonl", ranked)
    print(json.dumps({"cases": len(rows), "clusters": {key: value["count"] for key, value in cluster_summary.items()}, "judge_attached": len(judges)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
