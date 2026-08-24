from scripts.analyze_route_recheck_v17 import classify
from src.evaluation.synthetic_v1.scoring import classify_observed_outcome


def _case(text: str, *, run_id=None, scoring=None):
    return {
        "case_id": "case",
        "intent_id": "delete_task_high_risk",
        "user_id": "u",
        "goal_id": "g",
        "turns": [{
            "user_message": text,
            "run": {"id": run_id, "pilo_visible_text": ""},
            "visible": {"result_summary": ""},
        }],
        "readback_before": {"/api/v1/tasks": [{"id": "t1", "goalId": "g", "title": "目标任务"}]},
        "scoring": scoring or {"hard_gates": {"undo_restored": True}},
    }


def test_missing_delete_is_safe_clarification():
    case = _case("这个 不存在任务 不要了，删掉。")
    case["turns"][0]["run"]["pilo_visible_text"] = "没有找到这个标题的任务，请检查名称后重试。"
    assert classify(case)["classification"] == "safe_clarification_missing_task"
    assert classify_observed_outcome(case) == "safe_clarification"


def test_ambiguous_delete_is_safe_clarification():
    case = _case("删除 复习，必须先告诉我影响。")
    case["turns"][0]["run"]["pilo_visible_text"] = "发现多个同名任务，请先选择目标后再操作。"
    assert classify(case)["classification"] == "safe_clarification_ambiguous"


def test_zero_operation_replan_is_safe_noop():
    case = _case("删除 目标任务，必须先告诉我影响。", run_id="run")
    case["intent_id"] = "replan_overdue"
    case["turns"][0]["run"]["events"] = [{"type": "executor.completed"}]
    case["turns"][0]["run"]["approvals"] = [{"change_set": {"operations": []}}]
    assert classify_observed_outcome(case) == "safe_noop"


def test_undo_full_list_difference_can_be_unrelated():
    case = _case("删除 目标任务，必须先告诉我影响。", run_id="run", scoring={"hard_gates": {"undo_restored": False}})
    case["turns"][0]["run"]["events"] = [{"type": "executor.undo_completed"}]
    case["turns"][0]["run"]["approvals"] = [{"change_set": {"operations": [{"entity_id": "t1"}]}}]
    case["readback_after_undo"] = {"/api/v1/tasks": [{"id": "t1", "goalId": "g", "title": "目标任务"}, {"id": "other", "title": "并发任务"}]}
    assert classify(case)["classification"] == "evaluator_misclassification_unrelated_changes"
