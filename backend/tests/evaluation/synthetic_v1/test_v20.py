import json

import pytest

from src.evaluation.synthetic_v1.v20 import (
    DIMENSIONS,
    build_v20_judge_input,
    classify_routing_failure,
    dimension_applicability,
    evidence_bound_root_cause,
    parse_v20_judge_payload,
    privacy_findings,
)


def _case(*, intent="targeted_advice", trace=None, text="建议先复习。"):
    stream = [] if trace is None else [{"event": "context_trace", "data": trace}]
    return {
        "case_id": "c1",
        "intent_id": intent,
        "difficulty": "natural",
        "outcome_contract": {"allowed_outcomes": ["answer"]},
        "v19_scoring": {
            "hard_safety_pass": True,
            "routing_failure": None,
            "outcome_type": "answer",
        },
        "turns": [
            {
                "user_message": "根据我的情况给建议",
                "run": {"id": None, "pilo_visible_text": text, "pilo_stream": stream},
            }
        ],
    }


def test_atomic_task_operation_does_not_require_profile_or_advice_scores():
    mask = dimension_applicability("complete_task")
    assert mask == {
        "core_need_understanding": True,
        "profile_use": False,
        "advice_specificity": False,
        "plan_actionability": False,
        "explanation_clarity": True,
    }


def test_v20_parser_requires_null_for_not_applicable_dimensions():
    applicability = dimension_applicability("complete_task")
    payload = {
        "scores": {name: (3 if applicability[name] else None) for name in DIMENSIONS},
        "reasons": {name: ("符合合同" if applicability[name] else None) for name in DIMENSIONS},
        "overall_reason": "完成任务表达清楚",
    }
    assert parse_v20_judge_payload(json.dumps(payload, ensure_ascii=False), applicability) == payload
    payload["scores"]["profile_use"] = 4
    with pytest.raises(ValueError, match="not-applicable"):
        parse_v20_judge_payload(json.dumps(payload, ensure_ascii=False), applicability)


def test_public_reference_facts_are_separate_from_missing_historical_trace():
    judge_input = build_v20_judge_input(
        _case(),
        {"profile": {"available": True}, "goals": [{"id": "g1"}], "tasks": []},
    )
    assert judge_input["reference_observable_facts"]["profile"]["available"] is True
    assert (
        judge_input["actual_context_trace"]["turns"][0]["capture_status"]
        == "unavailable_historical"
    )
    root = evidence_bound_root_cause(_case(), None, judge_input["reference_observable_facts"])
    assert root["primary_root_cause"] == "unknown_or_mixed"
    assert root["evidence_class"] == "requires_human_review"


def test_attribution_uses_captured_injection_evidence_not_public_availability():
    trace = {
        "schema_version": "planpilot-chat-context-trace.v1",
        "selected_keys": ["goal"],
        "profile": {"available_in_source": True, "injected": False, "scope": "user"},
        "counts": {"source": {}, "injected": {}},
        "content_hashes": {},
    }
    case = _case(trace=trace)
    root = evidence_bound_root_cause(case, None, {"profile": {"available": True}})
    assert root["primary_root_cause"] == "relevant_profile_not_injected"
    assert root["owner_layer"] == "context_selection"


def test_injected_history_denial_is_response_grounding_failure():
    trace = {
        "schema_version": "planpilot-chat-context-trace.v1",
        "selected_keys": ["profile", "recent_events"],
        "profile": {"available_in_source": True, "injected": True, "scope": "user"},
        "counts": {"source": {}, "injected": {}},
        "content_hashes": {"profile": "abc"},
    }
    case = _case(trace=trace, text="我无法访问过往历史，只能给通用建议。")
    root = evidence_bound_root_cause(case, None, {"profile": {"available": True}})
    assert root["primary_root_cause"] == "injected_evidence_denied_in_response"
    assert root["owner_layer"] == "response_grounding"


def test_privacy_scanner_checks_keys_and_string_content():
    assert privacy_findings({"transcript": [{"user": "正常消息"}]}) == []
    assert privacy_findings({"safe": "hidden oracle"}) == ["content:root.safe"]


@pytest.mark.parametrize(
    ("intent", "message", "visible", "facts", "expected"),
    [
        ("create_task", "给目标记一条明早复习，先审", "已加入待办", {}, "explicit_action_swallowed_by_conversation"),
        ("move_task", "任务A往后挪两天", "请补充日期", {"task_match_count": 1}, "entity_or_date_resolution_failure"),
        ("edit_preview", "预览后我要改两项", "请列出任务", {}, "expression_contract_mismatch"),
        ("create_task", "想添一项周末口语练习", "请确认具体日期", {}, "legitimate_clarification"),
    ],
)
def test_routing_failure_taxonomy_is_evidence_bound(intent, message, visible, facts, expected):
    case = _case(intent=intent, text=visible)
    case["turns"][0]["user_message"] = message
    case["pre_run_observable_facts"] = facts
    case["v19_scoring"]["routing_failure"] = "missing_action_run"
    assert classify_routing_failure(case)["category"] == expected
