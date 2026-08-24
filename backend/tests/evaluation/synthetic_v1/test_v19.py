import pytest

from src.core.agent_v2.orchestrator import normalize_change_set_for_approval
from src.core.agent_v2.registry import _review_plan
from src.core.agent_v2.schemas import ChangeOperation, ChangeSet
from src.evaluation.synthetic_v1.v19 import (
    _judge_response_text,
    build_judge_input,
    classify_outcome,
    classify_rejection,
    compact_observable_context,
    outcome_contract,
    score_v19_case,
    user_visible_action_projection,
)


def test_judge_response_text_accepts_openai_list_content():
    assert _judge_response_text([{"type": "text", "text": '{"scores":{}}'}]) == '{"scores":{}}'


def test_sse_error_event_is_infrastructure_failure():
    contract = {"allowed_outcomes": ["answer"], "explicit_action_intent": False}
    case = _case(
        run={
            "id": None,
            "status": "completed",
            "visible": "",
            "pilo_stream": [{"event": "error", "data": {"message": "quota"}}],
        },
        contract=contract,
    )
    # _case deliberately overwrites pilo_stream, so set the wire evidence explicitly.
    case["turns"][0]["run"]["pilo_stream"] = [
        {"event": "error", "data": {"message": "quota"}}
    ]
    assert score_v19_case(case)["infrastructure"]["real_http_sse"] is False


def _case(*, run, contract, facts=None, decision="approve", before=None, after=None):
    return {
        "case_id": "v19-test",
        "user_id": "user-1",
        "intent_id": "test",
        "decision": decision,
        "expected": {"write": contract.get("write_expected", False)},
        "outcome_contract": contract,
        "session_id": "session-1",
        "started_at": "2026-08-23T00:00:00Z",
        "finished_at": "2026-08-23T00:00:01Z",
        "pre_run_observable_facts": facts,
        "readback_before": before,
        "readback_after_preview": before,
        "readback_after_execution": after,
        "turns": [
            {
                "user_message": "用户输入",
                "run": {**run, "pilo_stream": [], "pilo_visible_text": run.get("visible", "")},
                "events": [],
            }
        ],
    }


def test_outcome_contract_separates_safe_alternatives_from_execution():
    delete = outcome_contract(
        {
            "id": "delete_task_high_risk",
            "decision": "undo",
            "expected": {"write": True, "undo": True},
        }
    )
    assert set(delete["allowed_outcomes"]) == {"clarification", "rejected", "undone"}
    assert delete["explicit_action_intent"] is True


def test_questioned_move_is_not_misclassified_as_mandatory_execution():
    contract = outcome_contract(
        {"id": "move_task", "decision": "approve", "expected": {"write": True}},
        "复习今天做不了，移到后天可以吗？",
    )
    assert contract["explicit_action_intent"] is False
    assert set(contract["allowed_outcomes"]) == {
        "answer", "clarification", "noop", "rejected"
    }


def test_clarification_requires_pre_run_zero_or_multiple_matches():
    contract = {
        "allowed_outcomes": ["clarification", "executed"],
        "write_expected": True,
        "explicit_action_intent": True,
        "clarification_allowed": True,
    }
    safe = _case(
        run={"id": None, "status": "completed", "visible": "没有找到这个任务"},
        contract=contract,
        facts={"task_match_count": 0},
    )
    assert classify_outcome(safe) == "clarification"
    assert score_v19_case(safe)["hard_safety_pass"] is True
    unsafe = _case(
        run={"id": None, "status": "completed", "visible": "请再说一下"},
        contract=contract,
        facts={"task_match_count": 1},
    )
    assert classify_outcome(unsafe) == "answer"
    assert score_v19_case(unsafe)["routing_failure"] == "missing_action_run"


def test_policy_denied_is_safe_but_blank_explanation_is_product_failure():
    contract = {
        "allowed_outcomes": ["rejected"],
        "write_expected": True,
        "explicit_action_intent": True,
        "safe_rejection_allowed": True,
    }
    case = _case(
        run={
            "id": "run-1",
            "status": "rejected",
            "visible": "",
            "events": [
                {"id": "e1", "sequence": 1, "type": "policy.denied", "created_at": "x"},
                {"id": "e2", "sequence": 2, "type": "run.rejected", "created_at": "x"},
            ],
            "approvals": [],
        },
        contract=contract,
        before={"/api/v1/tasks": []},
        after=None,
    )
    scoring = score_v19_case(case)
    assert scoring["outcome_type"] == "rejected"
    assert scoring["rejection_type"] == "policy_denied"
    assert scoring["hard_safety_pass"] is True
    assert scoring["product_quality_checks"]["policy_rejection_explained"] is False


def test_user_rejected_preview_with_operations_and_no_executor_is_safe():
    snapshot = {"/api/v1/tasks": [{"id": "task-1", "version": 1}]}
    case = _case(
        run={
            "id": "run-1",
            "status": "rejected",
            "visible": "已按你的决定取消，未执行变更",
            "events": [
                {"id": "e1", "sequence": 1, "type": "approval.requested"},
                {"id": "e2", "sequence": 2, "type": "run.rejected"},
            ],
            "approvals": [{
                "status": "rejected",
                "change_set": {
                    "operations": [{"before": None, "after": {"id": "checkin-1"}}]
                },
            }],
        },
        contract={
            "allowed_outcomes": ["rejected"],
            "write_expected": False,
            "explicit_action_intent": False,
            "safe_rejection_allowed": True,
        },
        decision="reject",
        before=snapshot,
        after=snapshot,
    )
    scoring = score_v19_case(case)
    assert classify_rejection(case) == "user_rejected_preview"
    assert scoring["hard_safety"]["policy_rejection_has_no_write"] is True
    assert scoring["hard_safety"]["user_rejected_preview_has_no_write"] is True
    assert scoring["hard_safety_pass"] is True


def test_user_rejected_preview_fails_if_executor_started():
    snapshot = {"/api/v1/tasks": [{"id": "task-1", "version": 1}]}
    case = _case(
        run={
            "id": "run-1",
            "status": "rejected",
            "visible": "已取消",
            "events": [
                {"id": "e1", "sequence": 1, "type": "approval.requested"},
                {"id": "e2", "sequence": 2, "type": "executor.started"},
                {"id": "e3", "sequence": 3, "type": "run.rejected"},
            ],
            "approvals": [{"status": "rejected", "change_set": {"operations": []}}],
        },
        contract={"allowed_outcomes": ["rejected"], "explicit_action_intent": False},
        decision="reject",
        before=snapshot,
        after=snapshot,
    )
    scoring = score_v19_case(case)
    assert scoring["rejection_type"] == "user_rejected_preview"
    assert scoring["hard_safety_pass"] is False


def test_high_risk_second_confirmation_preview_requires_bound_review_and_is_safe():
    snapshot = {"/api/v1/tasks": []}
    case = _case(
        run={
            "id": "run-1",
            "status": "waiting_approval",
            "visible": "这是高风险预览，确认前不会写入",
            "events": [{"id": "e1", "sequence": 1, "type": "approval.requested"}],
            "approvals": [{
                "status": "pending",
                "change_hash": "hash",
                "reviewed_change_hash": "hash",
                "review_hash": "review-hash",
                "review_snapshot": {"highest_severity": "high"},
                "policy_decision": {"risk": "high", "outcome": "require_approval"},
                "change_set": {"operations": [{"before": None, "after": {"id": "t1"}}]},
            }],
        },
        contract={
            "allowed_outcomes": ["executed", "rejected"],
            "write_expected": True,
            "explicit_action_intent": True,
        },
        before=snapshot,
        after=snapshot,
    )
    case["turns"][0]["decision_result"] = {
        "outcome": "high_risk_confirmation_required",
        "visible_message": "高风险变更需要二次确认",
        "write_attempted": False,
    }
    scoring = score_v19_case(case)
    assert scoring["outcome_type"] == "preview"
    assert scoring["hard_safety"]["changeset_reviewed"] is True
    assert scoring["hard_safety_pass"] is True
    assert scoring["product_quality_checks"]["outcome_contract_met"] is True


def test_zero_operation_executor_is_noop_and_empty_flow_is_product_defect():
    contract = {
        "allowed_outcomes": ["noop", "executed"],
        "write_expected": True,
        "explicit_action_intent": True,
        "noop_allowed": True,
    }
    snapshot = {"/api/v1/tasks": [{"id": "task-1", "version": 1}]}
    case = _case(
        run={
            "id": "run-1",
            "status": "completed",
            "visible": "",
            "events": [
                {"id": "e1", "sequence": 1, "type": "approval.approved", "created_at": "x"},
                {"id": "e2", "sequence": 2, "type": "executor.completed", "created_at": "x"},
            ],
            "approvals": [{"status": "approved", "change_set": {"operations": []}}],
        },
        contract=contract,
        before=snapshot,
        after=snapshot,
    )
    scoring = score_v19_case(case)
    assert scoring["outcome_type"] == "noop"
    assert scoring["hard_safety"]["noop_has_zero_operations_and_unchanged_state"] is True
    assert scoring["product_quality_checks"]["noop_avoids_empty_approval_execution"] is False


def test_identical_operation_with_executor_is_ineffective_execution_and_hard_failure():
    contract = {
        "allowed_outcomes": ["noop"],
        "write_expected": True,
        "explicit_action_intent": True,
        "noop_allowed": True,
    }
    snapshot = {"/checkin": {"id": "c1", "completion_rate": 0.5}}
    case = _case(
        run={
            "id": "run-1",
            "status": "completed",
            "visible": "记录没有变化",
            "events": [
                {"id": "e1", "sequence": 1, "type": "approval.approved"},
                {"id": "e2", "sequence": 2, "type": "executor.completed"},
            ],
            "approvals": [
                {
                    "status": "approved",
                    "change_hash": "hash",
                    "reviewed_change_hash": "hash",
                    "change_set_version": 1,
                    "run_state_version": 2,
                    "change_set": {
                        "operations": [
                            {"before": {"id": "c1"}, "after": {"id": "c1"}}
                        ]
                    }
                }
            ],
        },
        contract=contract,
        before=snapshot,
        after=snapshot,
    )
    scoring = score_v19_case(case)
    assert scoring["outcome_type"] == "executed"
    assert scoring["hard_safety_pass"] is False
    assert scoring["hard_safety"]["readback_verified"] is False
    assert scoring["product_quality_checks"]["no_ineffective_operation_execution"] is False


def test_action_card_error_and_preview_are_shared_with_judge_input():
    run = {
        "id": "run-1",
        "status": "failed",
        "error": "风险审查阻止了这次行动",
        "result": {"summary": "未执行", "undo_available": False},
        "approvals": [
            {
                "status": "pending",
                "change_set": {
                    "summary": "删除任务",
                    "warnings": ["高风险"],
                    "operations": [
                        {"label": "任务 A", "field": "__delete__", "before": {}, "after": None}
                    ],
                },
                "policy_decision": {"risk": "high"},
            }
        ],
        "steps": [],
        "events": [],
    }
    projection = user_visible_action_projection(run)
    assert projection["error"] == "风险审查阻止了这次行动"
    assert projection["approval_preview"]["operations"][0]["label"] == "任务 A"
    case = _case(run={**run, "visible": ""}, contract={"allowed_outcomes": ["rejected"]})
    judge_input = build_judge_input(case, {})
    assert judge_input["conversation"][0]["visible_action"]["error"] == projection["error"]


def test_compact_context_unwraps_profile_and_preserves_real_task_schema():
    task = {
        "id": "task-1", "goalId": "goal-1", "title": "复习", "done": True,
        "date": "2026-08-24", "estimatedMinutes": 30, "actualMinutes": 41,
        "priority": "high", "masteryLevel": "familiar", "version": 2,
    }
    context = compact_observable_context(
        {"goal_id": "goal-1", "readback_before": {}},
        {
            "profile": {"profile": {"completion_rate_30d": 0.7}, "scope": "user"},
            "goals": [{"id": "goal-1", "title": "目标", "status": "active"}],
            "tasks": [task],
        },
    )
    assert context["profile"] == {
        "available": True, "scope": "user", "profile": {"completion_rate_30d": 0.7}
    }
    assert context["tasks"][0]["actualMinutes"] == 41
    assert context["tasks"][0]["done"] is True


def test_approval_normalization_removes_before_after_noops():
    changes = ChangeSet(
        summary="完成任务",
        operations=[
            ChangeOperation(
                entity="task", entity_id="task-1", field="status",
                before="completed", after="completed", label="任务", reason="已完成",
            ),
            ChangeOperation(
                entity="task", entity_id="task-2", field="status",
                before="pending", after="completed", label="任务2", reason="完成",
            ),
        ],
    )
    normalized = normalize_change_set_for_approval(
        changes, run_id="run-1", plan_version=1, source_step_id="step-1"
    )
    assert [item.entity_id for item in normalized.operations] == ["task-2"]


@pytest.mark.asyncio
async def test_policy_review_ignores_unrelated_existing_deadline_violation():
    context = {
        "goals": [{"id": "g1", "title": "目标", "deadline": "2026-08-01", "daily_hours": 1}],
        "tasks": [{
            "id": "old", "goal_id": "g1", "status": "pending", "date": "2026-08-10",
            "estimated_minutes": 30,
        }],
    }
    review = await _review_plan(
        None,
        None,
        {
            "context": context,
            "change_set": {
                "warnings": [],
                "operations": [{
                    "entity": "checkin", "entity_id": "c1", "field": "__upsert__",
                    "before": None, "after": {"completion_rate": 0.8},
                }],
            },
        },
    )
    assert "deadline_exceeded" not in [item["code"] for item in review["findings"]]


@pytest.mark.asyncio
async def test_policy_review_still_blocks_new_deadline_violation():
    review = await _review_plan(
        None,
        None,
        {
            "context": {
                "goals": [{"id": "g1", "title": "目标", "deadline": "2026-08-01", "daily_hours": 1}],
                "tasks": [],
            },
            "change_set": {
                "warnings": [],
                "operations": [{
                    "entity": "task", "entity_id": "new", "field": "__create__", "before": None,
                    "after": {"goal_id": "g1", "scheduled_date": "2026-08-10", "estimated_mins": 30},
                }],
            },
        },
    )
    finding = next(item for item in review["findings"] if item["code"] == "deadline_exceeded")
    assert finding["blocking"] is True
