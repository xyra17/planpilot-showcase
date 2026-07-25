from src.core.agent.nodes.intent import _keyword_intent
from src.core.llm_quality import compact_text, enforce_chinese_only


def test_verification_intent_covers_natural_question_requests():
    assert _keyword_intent("出一道题考考我") == "verification"
    assert _keyword_intent("给我来个小测") == "verification"


def test_failed_task_report_is_checkin_not_replan():
    assert _keyword_intent("我没完成今天的任务") == "checkin"
    assert _keyword_intent("今天没有完成学习") == "checkin"


def test_compact_text_prefers_complete_first_sentence():
    text = "制定计划前应先明确目标。然后评估时间、资源和当前基础。"
    assert compact_text(text, 20) == "制定计划前应先明确目标。"


def test_compact_text_hard_limits_long_unbroken_output():
    result = compact_text("这是一个没有句号而且明显超过限制的模型输出内容", 12)
    assert result.endswith("…")
    assert len(result) == 12


def test_compact_text_removes_markdown_noise():
    assert compact_text("**明确目标**", 20) == "明确目标"


def test_enforce_chinese_only_removes_latin_abbreviations():
    assert enforce_chinese_only("先确认 SMART 目标和 Python 基础。") == "先确认 目标和 基础。"
