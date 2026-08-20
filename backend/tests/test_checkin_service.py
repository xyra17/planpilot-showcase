"""CheckinService 纯计算函数单元测试

测试范围：
- _compute_daily_stats
- _compute_task_list_stats
- _compute_quick_stats
- _compute_natural_stats
- _estimate_rate_from_text

所有测试为同步测试（纯函数，无 DB 依赖）。
"""

from unittest.mock import MagicMock

import pytest

from src.services.checkin_service import (
    TaskCheckinInput,
    _compute_daily_stats,
    _compute_natural_stats,
    _compute_quick_stats,
    _compute_task_list_stats,
    _estimate_rate_from_text,
)

# ── Helpers ────────────────────────────────────────────────────────────────


def _mock_task(task_id: str, estimated_mins: int = 30) -> MagicMock:
    """创建最小化的 Task mock 对象"""
    task = MagicMock()
    task.id = task_id
    task.estimated_mins = estimated_mins
    return task


def _tasks_by_id(*pairs: tuple[str, int]) -> dict:
    """快速构建 tasks_by_id dict：(task_id, estimated_mins)"""
    return {tid: _mock_task(tid, mins) for tid, mins in pairs}


# ── _compute_daily_stats ───────────────────────────────────────────────────


class TestComputeDailyStats:
    def test_all_mastered_l3(self):
        tasks = [
            TaskCheckinInput(task_id="t1", status="completed", mastery="L3"),
            TaskCheckinInput(task_id="t2", status="completed", mastery="L3"),
        ]
        by_id = _tasks_by_id(("t1", 30), ("t2", 60))
        r = _compute_daily_stats(tasks, by_id)

        assert r.total == 2
        assert r.completion_rate == 1.0
        assert r.mastery_rate == 1.0
        assert r.completed == 2
        assert r.partial == 0
        assert r.skipped == 0
        assert r.estimated_mins == 90
        assert "100%" in r.feedback
        assert r.stats_data["total_tasks"] == 2

    def test_l4_counts_as_good(self):
        """L4 应与 L3 等价计入 good_count"""
        tasks = [TaskCheckinInput(task_id="t1", status="completed", mastery="L4")]
        by_id = _tasks_by_id(("t1", 30))
        r = _compute_daily_stats(tasks, by_id)

        assert r.completed == 1
        assert r.mastery_rate == 1.0

    def test_l2_counts_as_partial(self):
        tasks = [
            TaskCheckinInput(task_id="t1", status="completed", mastery="L3"),
            TaskCheckinInput(task_id="t2", status="partial", mastery="L2"),
        ]
        by_id = _tasks_by_id(("t1", 30), ("t2", 30))
        r = _compute_daily_stats(tasks, by_id)

        assert r.partial == 1
        assert r.mastery_rate == pytest.approx(0.75)

    def test_l1_counts_as_skipped(self):
        tasks = [
            TaskCheckinInput(task_id="t1", status="partial", mastery="L1"),
            TaskCheckinInput(task_id="t2", status="completed", mastery="L3"),
        ]
        by_id = _tasks_by_id(("t1", 30), ("t2", 30))
        r = _compute_daily_stats(tasks, by_id)

        assert r.skipped == 1
        assert r.mastery_rate == pytest.approx(0.5)

    def test_execution_rate_independent_of_mastery(self):
        """执行率基于 status，掌握率基于 mastery —— 两个独立维度"""
        tasks = [
            # 执行了但没掌握
            TaskCheckinInput(task_id="t1", status="completed", mastery="L1"),
            # 没执行但"掌握了"（异常场景，仍应正确计算）
            TaskCheckinInput(task_id="t2", status="skipped", mastery="L3"),
        ]
        by_id = _tasks_by_id(("t1", 30), ("t2", 30))
        r = _compute_daily_stats(tasks, by_id)

        # 执行率：1 completed + 0 partial = 1/2 = 0.5
        assert r.completion_rate == pytest.approx(0.5)
        # 掌握率：0 L3+ + 0 L2 = 1 good / 2 = 0.5
        assert r.mastery_rate == pytest.approx(0.5)

    def test_actual_mins_summed(self):
        tasks = [
            TaskCheckinInput(task_id="t1", status="completed", mastery="L3", actual_mins=25),
            TaskCheckinInput(task_id="t2", status="completed", mastery="L3", actual_mins=40),
        ]
        by_id = _tasks_by_id(("t1", 30), ("t2", 30))
        r = _compute_daily_stats(tasks, by_id)

        assert r.actual_mins == 65

    def test_empty_tasks(self):
        r = _compute_daily_stats([], {})
        assert r.total == 0
        assert r.completion_rate == 0.0
        assert r.mastery_rate == 0.0

    def test_stats_data_contains_tasks_list(self):
        tasks = [TaskCheckinInput(task_id="t1", status="completed", mastery="L3")]
        by_id = _tasks_by_id(("t1", 30))
        r = _compute_daily_stats(tasks, by_id)

        assert "tasks" in r.stats_data
        assert len(r.stats_data["tasks"]) == 1
        assert r.stats_data["tasks"][0]["task_id"] == "t1"

    def test_partial_status_counted_in_execution_rate(self):
        tasks = [
            TaskCheckinInput(task_id="t1", status="partial", mastery="L2"),
            TaskCheckinInput(task_id="t2", status="partial", mastery="L2"),
        ]
        by_id = _tasks_by_id(("t1", 30), ("t2", 30))
        r = _compute_daily_stats(tasks, by_id)

        # partial * 0.5 → 执行率 0.5
        assert r.completion_rate == pytest.approx(0.5)


# ── _compute_task_list_stats ───────────────────────────────────────────────


class TestComputeTaskListStats:
    def test_all_completed(self):
        tasks = [
            TaskCheckinInput(task_id="t1", status="completed"),
            TaskCheckinInput(task_id="t2", status="completed"),
        ]
        by_id = _tasks_by_id(("t1", 30), ("t2", 30))
        r = _compute_task_list_stats(tasks, by_id)

        assert r.completion_rate == 1.0
        assert r.completed == 2
        assert r.partial == 0
        assert r.skipped == 0
        assert r.mastery_rate == 0.0
        assert "很棒" in r.feedback

    def test_mixed_status(self):
        tasks = [
            TaskCheckinInput(task_id="t1", status="completed"),
            TaskCheckinInput(task_id="t2", status="partial"),
            TaskCheckinInput(task_id="t3", status="skipped"),
            TaskCheckinInput(task_id="t4", status="skipped"),
        ]
        by_id = _tasks_by_id(("t1", 30), ("t2", 30), ("t3", 30), ("t4", 30))
        r = _compute_task_list_stats(tasks, by_id)

        # (1 completed + 1 partial * 0.5) / 4 = 1.5 / 4 = 0.375
        assert r.completion_rate == pytest.approx(1.5 / 4)
        assert r.completed == 1
        assert r.partial == 1
        assert r.skipped == 2
        assert "不要气馁" in r.feedback

    def test_half_done_feedback(self):
        tasks = [
            TaskCheckinInput(task_id="t1", status="completed"),
            TaskCheckinInput(task_id="t2", status="skipped"),
        ]
        by_id = _tasks_by_id(("t1", 30), ("t2", 30))
        r = _compute_task_list_stats(tasks, by_id)

        # 0.5 >= 0.5 → "明天加把劲"
        assert r.completion_rate == pytest.approx(0.5)
        assert "明天加把劲" in r.feedback

    def test_mastery_rate_always_zero(self):
        tasks = [TaskCheckinInput(task_id="t1", status="completed", mastery="L3")]
        by_id = _tasks_by_id(("t1", 30))
        r = _compute_task_list_stats(tasks, by_id)

        assert r.mastery_rate == 0.0

    def test_estimated_mins_from_tasks_by_id(self):
        tasks = [
            TaskCheckinInput(task_id="t1", status="completed"),
            TaskCheckinInput(task_id="t2", status="completed"),
        ]
        by_id = _tasks_by_id(("t1", 45), ("t2", 20))
        r = _compute_task_list_stats(tasks, by_id)

        assert r.estimated_mins == 65

    def test_empty_tasks(self):
        r = _compute_task_list_stats([], {})
        assert r.total == 0
        assert r.completion_rate == 0.0


# ── _compute_quick_stats ───────────────────────────────────────────────────


class TestComputeQuickStats:
    @pytest.mark.parametrize(
        "qs,expected_rate",
        [
            ("all_done", 1.0),
            ("mostly_done", 0.75),
            ("half_done", 0.5),
            ("barely_done", 0.1),
            ("explain", 0.0),
        ],
    )
    def test_known_quick_statuses(self, qs, expected_rate):
        r = _compute_quick_stats(qs)
        assert r.completion_rate == pytest.approx(expected_rate)
        assert r.total == 0
        assert r.mastery_rate == 0.0

    def test_unknown_status_defaults_to_zero(self):
        r = _compute_quick_stats("invalid_status")
        assert r.completion_rate == 0.0
        assert r.feedback == "已记录今日打卡。"

    def test_all_done_feedback(self):
        r = _compute_quick_stats("all_done")
        assert "太棒了" in r.feedback

    def test_barely_done_feedback(self):
        r = _compute_quick_stats("barely_done")
        assert "困难" in r.feedback

    def test_stats_data_contains_completion_rate(self):
        r = _compute_quick_stats("half_done")
        assert r.stats_data["completion_rate"] == pytest.approx(0.5)
        assert r.stats_data["total_tasks"] == 0


# ── _compute_natural_stats ─────────────────────────────────────────────────


class TestComputeNaturalStats:
    def test_all_done_keywords(self):
        for kw in ["全部完成", "都完成", "100%", "全完成", "完成所有", "全搞定"]:
            r = _compute_natural_stats(kw)
            assert r.completion_rate == pytest.approx(1.0), f"failed for: {kw!r}"

    def test_most_done_keywords(self):
        # "差不多都完成" 含子串 "都完成"，被 1.0 关键词表先匹配（已知行为，见 test_first_match_wins）
        for kw in ["大部分", "基本完成", "75%", "大多数", "快完成了"]:
            r = _compute_natural_stats(kw)
            assert r.completion_rate == pytest.approx(0.75), f"failed for: {kw!r}"

    def test_half_done_keywords(self):
        for kw in ["一半", "50%", "部分完成", "有几个", "完成了一些"]:
            r = _compute_natural_stats(kw)
            assert r.completion_rate == pytest.approx(0.5), f"failed for: {kw!r}"

    def test_barely_done_keywords(self):
        for kw in ["一点点", "很少", "几乎没", "25%", "没做多少", "做了一点"]:
            r = _compute_natural_stats(kw)
            assert r.completion_rate == pytest.approx(0.25), f"failed for: {kw!r}"

    def test_nothing_done_keywords(self):
        for kw in ["没完成", "没做", "0%", "完全没", "什么都没", "没有做"]:
            r = _compute_natural_stats(kw)
            assert r.completion_rate == pytest.approx(0.0), f"failed for: {kw!r}"

    def test_no_match_defaults_to_half(self):
        r = _compute_natural_stats("今天学了很多新内容")
        assert r.completion_rate == pytest.approx(0.5)

    def test_empty_text_defaults_to_half(self):
        r = _compute_natural_stats("")
        assert r.completion_rate == pytest.approx(0.5)

    def test_feedback_is_fixed(self):
        r1 = _compute_natural_stats("全部完成")
        r2 = _compute_natural_stats("没做")
        # natural 模式统一使用固定 feedback，与完成率无关
        assert r1.feedback == r2.feedback
        assert "AI" in r1.feedback

    def test_total_always_zero(self):
        r = _compute_natural_stats("完成所有")
        assert r.total == 0
        assert r.completed == 0
        assert r.skipped == 0


# ── _estimate_rate_from_text ───────────────────────────────────────────────


class TestEstimateRateFromText:
    def test_first_match_wins(self):
        """包含多个关键词时，第一个匹配的优先"""
        # "全部完成" (1.0) 和 "一半" (0.5) 同时出现
        # _RATE_KEYWORDS 按降序排列，1.0 先匹配
        text = "今天全部完成了，就是有一半比较模糊"
        assert _estimate_rate_from_text(text) == 1.0

    def test_substring_match(self):
        """关键词可以是句子的子串"""
        assert _estimate_rate_from_text("我今天大部分任务都做完了") == pytest.approx(0.75)

    def test_default_fallback(self):
        assert _estimate_rate_from_text("random text") == pytest.approx(0.5)
