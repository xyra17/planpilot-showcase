"""V20 product-quality contracts, safe context traces, and evidence-bound attribution."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from src.evaluation.synthetic_v1.v19 import user_visible_action_projection

DIMENSIONS = (
    "core_need_understanding",
    "profile_use",
    "advice_specificity",
    "plan_actionability",
    "explanation_clarity",
)

RUBRIC_VERSION = "synthetic-v20-product-rubric.v1"
RUBRIC = {
    "core_need_understanding": {
        "0": "答非所问或执行了相反/被否定的需求",
        "1": "仅识别主题，遗漏关键动作、对象或约束",
        "2": "主需求基本正确，但遗漏一个影响结果的重要槽位",
        "3": "动作、对象、约束和期望 outcome 均正确，仅有轻微遗漏",
        "4": "完整理解多意图、否定/假设、指代及澄清边界",
    },
    "profile_use": {
        "0": "已注入相关画像却作出冲突陈述或声称无法访问已有证据",
        "1": "已注入相关画像但回答完全泛化，未体现任何相关约束",
        "2": "使用一项画像事实，但未连接到建议或计划",
        "3": "使用相关画像证据调整建议，并说明证据或不确定性",
        "4": "综合多项相关画像证据形成一致、可追溯且不过度推断的个性化结果",
    },
    "advice_specificity": {
        "0": "没有建议或建议与需求冲突",
        "1": "只有泛化口号，无目标、任务、时间或容量依据",
        "2": "至少一条具体建议，但缺少关键证据或优先级",
        "3": "2–3 条针对当前事实的建议，含优先级或取舍",
        "4": "建议高度针对、解释取舍，并给出可验证的下一步",
    },
    "plan_actionability": {
        "0": "没有可执行步骤，或计划会违反明确约束",
        "1": "有方向但没有对象、时间、顺序或确认边界",
        "2": "步骤可执行但缺少一个关键约束、依赖或验收条件",
        "3": "步骤、顺序、时间/容量和确认边界清楚",
        "4": "计划可立即执行，含风险、替代方案和可验证完成条件",
    },
    "explanation_clarity": {
        "0": "空白、不可读或关键安全结果不可见",
        "1": "含糊、矛盾或让用户无法判断发生了什么",
        "2": "结论可理解，但证据、原因或下一步不清楚",
        "3": "结论、原因和下一步清楚，长度合适",
        "4": "结构清晰、术语准确、明确数据不足/置信度且无冗余",
    },
}
RUBRIC_HASH = hashlib.sha256(
    json.dumps(RUBRIC, ensure_ascii=False, sort_keys=True).encode()
).hexdigest()

PROFILE_INTENTS = {
    "targeted_advice",
    "replan_overdue",
    "reduce_load",
    "cross_goal_conflict",
    "profile_correction",
    "profile_explain",
    "batch_reschedule",
}
ADVICE_INTENTS = {
    "targeted_advice",
    "replan_overdue",
    "reduce_load",
    "cross_goal_conflict",
    "batch_reschedule",
}
PLAN_INTENTS = {
    "targeted_advice",
    "replan_overdue",
    "reduce_load",
    "cross_goal_conflict",
    "batch_reschedule",
    "edit_preview",
}

V20_JUDGE_PROMPT_VERSION = "synthetic-v20-product-judge.v1"
V20_JUDGE_SYSTEM_PROMPT = f"""你是独立产品评审器。只根据输入中的用户可见 transcript、参考公开事实、实际注入摘要和 outcome contract 评分。
必须输出单个 JSON：{{"scores":{{五个维度分别为0到4整数或null}},"reasons":{{五个维度分别为短理由或null}},"overall_reason":"短理由"}}。
dimension_applicability=false 的维度必须输出 null；true 的维度必须按 rubric 评分。参考公开事实只用于事后核对，不代表已注入回答；只有 actual_context_trace 的 injected 事实可用于判断模型是否忽略上下文。不可猜测未提供的系统状态。
rubric_version={RUBRIC_VERSION};rubric_hash={RUBRIC_HASH}。"""
V20_JUDGE_PROMPT_HASH = hashlib.sha256(V20_JUDGE_SYSTEM_PROMPT.encode()).hexdigest()


def dimension_applicability(intent_id: str) -> dict[str, bool]:
    return {
        "core_need_understanding": True,
        "profile_use": intent_id in PROFILE_INTENTS,
        "advice_specificity": intent_id in ADVICE_INTENTS,
        "plan_actionability": intent_id in PLAN_INTENTS,
        "explanation_clarity": True,
    }


def extract_actual_context_trace(case: dict[str, Any]) -> dict[str, Any]:
    traces = []
    for turn in case.get("turns", []):
        stream = (turn.get("run") or {}).get("pilo_stream") or []
        trace = next(
            (
                event.get("data")
                for event in stream
                if isinstance(event, dict)
                and event.get("event") == "context_trace"
                and isinstance(event.get("data"), dict)
            ),
            None,
        )
        traces.append(
            trace
            or {
                "capture_status": "unavailable_historical",
                "selected_keys": None,
                "profile": {"available_in_source": None, "injected": None, "scope": None},
                "counts": None,
                "content_hashes": None,
                "truncation": None,
                "quality": None,
            }
        )
    return {"turns": traces, "all_turns_captured": bool(traces) and all("schema_version" in row for row in traces)}


def visible_transcript(case: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "user": turn.get("user_message"),
            "pilo": (turn.get("run") or {}).get("pilo_visible_text"),
            "action_card": user_visible_action_projection(turn.get("run") or {}),
        }
        for turn in case.get("turns", [])
    ]


def build_v20_judge_input(
    case: dict[str, Any], reference_facts: dict[str, Any]
) -> dict[str, Any]:
    applicability = dimension_applicability(str(case.get("intent_id")))
    raw_contract = case.get("outcome_contract") or {}
    public_contract = {
        "allowed_outcomes": raw_contract.get("allowed_outcomes"),
        "write_expected": raw_contract.get("write_expected"),
        "undo_expected": raw_contract.get("undo_expected"),
        "clarification_allowed": raw_contract.get("clarification_allowed"),
        "safe_rejection_allowed": raw_contract.get("safe_rejection_allowed"),
        "noop_allowed": raw_contract.get("noop_allowed"),
        "action_run_required": raw_contract.get("explicit_action_intent"),
        "visible_explanation_required": raw_contract.get("visible_explanation_required"),
    }
    return {
        "schema_version": "synthetic-v20-judge-input.v1",
        "case_id": case.get("case_id"),
        "intent_id": case.get("intent_id"),
        "difficulty": case.get("difficulty"),
        "expected_outcome_contract": public_contract,
        "dimension_applicability": applicability,
        "rubric": {key: RUBRIC[key] if applicable else None for key, applicable in applicability.items()},
        "reference_observable_facts": reference_facts,
        "actual_context_trace": extract_actual_context_trace(case),
        "transcript": visible_transcript(case),
    }


def parse_v20_judge_payload(content: str, applicability: dict[str, bool]) -> dict[str, Any]:
    start, end = content.find("{"), content.rfind("}") + 1
    if start < 0 or end <= start:
        raise ValueError("judge response has no JSON object")
    payload = json.loads(content[start:end])
    scores = payload.get("scores") or {}
    reasons = payload.get("reasons") or {}
    if set(scores) != set(DIMENSIONS) or set(reasons) != set(DIMENSIONS):
        raise ValueError("judge dimensions differ from v20 schema")
    for name in DIMENSIONS:
        if applicability[name]:
            if not isinstance(scores[name], int) or not 0 <= scores[name] <= 4:
                raise ValueError(f"applicable score invalid: {name}")
            if not str(reasons[name] or "").strip():
                raise ValueError(f"applicable reason missing: {name}")
        elif scores[name] is not None or reasons[name] is not None:
            raise ValueError(f"not-applicable dimension must be null: {name}")
    if not str(payload.get("overall_reason") or "").strip():
        raise ValueError("overall reason missing")
    return payload


def privacy_findings(value: Any) -> list[str]:
    forbidden = ("needframe", "actionintent", "hiddenoracle", "internalprompt")
    findings: set[str] = set()

    def scan(item: Any, path: str) -> None:
        if isinstance(item, dict):
            for key, nested in item.items():
                normalized = re.sub(r"[^a-z]", "", str(key).lower())
                if any(term in normalized for term in forbidden):
                    findings.add(f"key:{path}.{key}")
                scan(nested, f"{path}.{key}")
        elif isinstance(item, list):
            for index, nested in enumerate(item):
                scan(nested, f"{path}[{index}]")
        elif isinstance(item, str):
            normalized = re.sub(r"[^a-z]", "", item.lower())
            if any(term in normalized for term in forbidden):
                findings.add(f"content:{path}")

    scan(value, "root")
    return sorted(findings)


def evidence_bound_root_cause(
    case: dict[str, Any], judge: dict[str, Any] | None, reference_facts: dict[str, Any]
) -> dict[str, Any]:
    trace = extract_actual_context_trace(case)
    traces = trace["turns"]
    captured = trace["all_turns_captured"]
    runs = [turn.get("run") or {} for turn in case.get("turns", []) if (turn.get("run") or {}).get("id")]
    scoring = case.get("v19_scoring") or {}
    root, owner, confidence, evidence_class = "unknown_or_mixed", "unknown", 0.35, "requires_human_review"
    reason = "现有证据不能唯一确定产品层"
    calibration = case.get("scoring_calibration") or {}
    if calibration.get("original_hard_safety_pass") is False and scoring.get("hard_safety_pass") is True:
        root, owner, confidence, evidence_class = "scorer_rejection_type_conflation", "evaluator", 1.0, "deterministic"
        reason = "原评分器混淆用户拒绝预览与 policy.denied；校准后无写入门禁通过"
    elif not scoring.get("hard_safety_pass", True):
        root, owner, confidence, evidence_class = "deterministic_safety_failure", "executor_readback", 1.0, "deterministic"
        reason = "确定性 hard safety 门禁失败"
    elif scoring.get("routing_failure"):
        root, owner, confidence, evidence_class = "explicit_action_routing_failure", "intent_routing", 1.0, "deterministic"
        reason = "明确可执行合同要求 Action Run 但没有真实 run"
    elif captured and any(
        row.get("profile", {}).get("available_in_source")
        and not row.get("profile", {}).get("injected")
        for row in traces
    ) and dimension_applicability(str(case.get("intent_id")))["profile_use"]:
        root, owner, confidence, evidence_class = "relevant_profile_not_injected", "context_selection", 0.95, "high_confidence_inference"
        reason = "画像在构建结果中可用，但实际选择摘要显示未注入"
    elif captured and any(row.get("profile", {}).get("injected") for row in traces):
        transcript = json.dumps(visible_transcript(case), ensure_ascii=False)
        if re.search(r"(?:无法|不能).{0,12}(?:访问|查看|读取).{0,12}(?:历史|后台|过往|数据)", transcript):
            root, owner, confidence, evidence_class = "injected_evidence_denied_in_response", "response_grounding", 0.95, "high_confidence_inference"
            reason = "实际摘要证明画像已注入，但用户可见回答否认可访问相关证据"
    return {
        "case_id": case.get("case_id"),
        "intent_id": case.get("intent_id"),
        "expected_contract": {
            "allowed_outcomes": (case.get("outcome_contract") or {}).get("allowed_outcomes"),
            "write_expected": (case.get("outcome_contract") or {}).get("write_expected"),
            "action_run_required": (case.get("outcome_contract") or {}).get("explicit_action_intent"),
        },
        "actual_outcome": scoring.get("outcome_type"),
        "route": {"has_action_run": bool(runs), "routing_failure": scoring.get("routing_failure")},
        "entity": {"pre_run_facts": case.get("pre_run_observable_facts")},
        "context_build_and_injection": trace,
        "reference_fact_counts": {
            "goals": len(reference_facts.get("goals") or []),
            "tasks": len(reference_facts.get("tasks") or []),
            "profile_available": (reference_facts.get("profile") or {}).get("available"),
        },
        "response_grounding": {"judge": judge},
        "primary_root_cause": root,
        "owner_layer": owner,
        "confidence": confidence,
        "evidence_class": evidence_class,
        "reason": reason,
    }


def classify_routing_failure(case: dict[str, Any]) -> dict[str, Any] | None:
    """Evidence-bound taxonomy for missing Action Runs.

    This deliberately permits evaluator/contract mismatch and safe clarification;
    a missing run is not automatically assigned to one product owner.
    """
    scoring = case.get("v19_scoring") or {}
    if not scoring.get("routing_failure"):
        return None
    intent = str(case.get("intent_id") or "")
    turns = case.get("turns") or []
    message = str((turns[0] if turns else {}).get("user_message") or "")
    visible = str((((turns[0] if turns else {}).get("run") or {}).get("pilo_visible_text")) or "")
    facts = case.get("pre_run_observable_facts") or {}
    match_count = facts.get("task_match_count")

    if intent == "edit_preview" and len(turns) == 1:
        category, reason = "expression_contract_mismatch", "独立 session 中没有可编辑的既存 preview 或具体变更对象"
    elif intent == "move_task" and re.search(r"(?:合适吗|可以吗|行不行)", message):
        category, reason = "expression_contract_mismatch", "问询式表达与冻结合同 explicit_action_intent=true 不一致"
    elif intent == "reduce_load" and re.search(r"(?:建议|别替我改|逐项列出)", message):
        category, reason = "expression_contract_mismatch", "表达要求建议/分析而非创建待审批写操作"
    elif intent == "create_task" and "周末" in message and not re.search(r"周[六日天]|星期[六日天]", message):
        category, reason = "legitimate_clarification", "周末未指定周六或周日，创建任务缺少唯一日期"
    elif match_count == 1 and (
        re.search(r"(?:大后天|周[一二三四五六日天]|星期[一二三四五六日天]|往后挪两天)", message)
        or re.search(r"不存在|记错了任务名称", visible)
    ):
        category, reason = "entity_or_date_resolution_failure", "可观察事实唯一匹配，但相对日期或实体未被正确解析/接地"
    elif re.search(r"(?:需要确认|请补充|请选择|请列出)", visible) and match_count in {0}:
        category, reason = "legitimate_clarification", "预运行可观察事实证明目标实体零匹配"
    else:
        category, reason = "explicit_action_swallowed_by_conversation", "明确预览/确认链请求返回普通文本且没有 Action Run"
    return {
        "case_id": case.get("case_id"),
        "intent_id": intent,
        "category": category,
        "reason": reason,
        "message": message,
        "visible_response": visible,
        "observable_task_match_count": match_count,
    }
