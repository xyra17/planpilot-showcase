"""GoalService 纯函数单元测试

测试范围：
- _calculate_streak
- _apply_goal_patch

_build_progress 因依赖较多 ORM 对象，暂不测试纯函数（集成测试覆盖）
"""

from datetime import date, timedelta
from unittest.mock import MagicMock

from src.services.goal_service import (
    GoalPatch,
    _apply_goal_patch,
    _calculate_streak,
)

# ── Helpers ────────────────────────────────────────────────────────────────


def _mock_goal(**kwargs) -> MagicMock:
    """创建最小化的 Goal mock 对象"""
    goal = MagicMock()
    goal.id = kwargs.get("id", "g1")
    goal.user_id = kwargs.get("user_id", "u1")
    goal.type = kwargs.get("type", "skill")
    goal.title = kwargs.get("title", "学习目标")
    goal.deadline = kwargs.get("deadline", "2027-01-01")
    goal.daily_hours = kwargs.get("daily_hours", 2.0)
    goal.current_level = kwargs.get("current_level", "beginner")
    goal.status = kwargs.get("status", "active")
    goal.work_schedule = kwargs.get("work_schedule", "all")
    goal.knowledge_base_id = kwargs.get("knowledge_base_id", None)
    goal.meta = kwargs.get("meta", {})
    return goal


# ── _calculate_streak ──────────────────────────────────────────────────────


class TestCalculateStreak:
    def test_empty_checkin_dates_returns_zero(self):
        result = _calculate_streak(set(), date(2026, 7, 29))
        assert result == 0

    def test_today_checked_counts_from_today(self):
        """今天已打卡，从今天起算连续天数"""
        today = date(2026, 7, 29)
        dates = {
            "2026-07-29",  # 今天
            "2026-07-28",
            "2026-07-27",
        }
        result = _calculate_streak(dates, today)
        assert result == 3

    def test_today_not_checked_counts_from_yesterday(self):
        """今天未打卡，从昨天起算（避免早上 streak 清零）"""
        today = date(2026, 7, 29)
        dates = {
            "2026-07-28",  # 昨天
            "2026-07-27",
            "2026-07-26",
        }
        result = _calculate_streak(dates, today)
        assert result == 3

    def test_streak_broken_returns_partial(self):
        """连续中断时返回连续部分长度"""
        today = date(2026, 7, 29)
        dates = {
            "2026-07-29",
            "2026-07-28",
            # 2026-07-27 缺失
            "2026-07-26",
            "2026-07-25",
        }
        result = _calculate_streak(dates, today)
        assert result == 2

    def test_only_today_returns_one(self):
        today = date(2026, 7, 29)
        dates = {"2026-07-29"}
        result = _calculate_streak(dates, today)
        assert result == 1

    def test_only_yesterday_returns_one(self):
        today = date(2026, 7, 29)
        dates = {"2026-07-28"}
        result = _calculate_streak(dates, today)
        assert result == 1

    def test_long_streak(self):
        """测试较长的连续天数（30天）"""
        today = date(2026, 7, 29)
        dates = {(today - timedelta(days=i)).isoformat() for i in range(30)}
        result = _calculate_streak(dates, today)
        assert result == 30


# ── _apply_goal_patch ──────────────────────────────────────────────────────


class TestApplyGoalPatch:
    def test_no_fields_returns_empty_set(self):
        goal = _mock_goal()
        body = GoalPatch()
        changed = _apply_goal_patch(goal, body)
        assert changed == set()

    def test_status_update(self):
        goal = _mock_goal(status="active")
        body = GoalPatch(status="paused")
        changed = _apply_goal_patch(goal, body)

        assert "status" in changed
        assert goal.status == "paused"

    def test_title_update(self):
        goal = _mock_goal(title="旧标题")
        body = GoalPatch(title="新标题")
        changed = _apply_goal_patch(goal, body)

        assert "title" in changed
        assert goal.title == "新标题"

    def test_work_schedule_update(self):
        """work_schedule 映射到直接列"""
        goal = _mock_goal(work_schedule="all")
        body = GoalPatch(work_schedule="weekday")
        changed = _apply_goal_patch(goal, body)

        assert "work_schedule" in changed
        assert goal.work_schedule == "weekday"

    def test_kb_id_maps_to_knowledge_base_id(self):
        """kb_id 映射到 knowledge_base_id 列"""
        goal = _mock_goal(knowledge_base_id=None)
        body = GoalPatch(kb_id="kb123")
        changed = _apply_goal_patch(goal, body)

        assert "knowledge_base_id" in changed
        assert goal.knowledge_base_id == "kb123"

    def test_multiple_fields_all_in_changed(self):
        goal = _mock_goal()
        body = GoalPatch(title="新标题", status="completed", daily_hours=3.0)
        changed = _apply_goal_patch(goal, body)

        assert {"title", "status", "daily_hours"}.issubset(changed)
        assert goal.title == "新标题"
        assert goal.status == "completed"
        assert goal.daily_hours == 3.0

    def test_none_fields_not_applied(self):
        """None 字段不应修改 goal 或出现在 changed 中"""
        goal = _mock_goal(title="原标题", status="active")
        body = GoalPatch(title=None, status="paused")
        changed = _apply_goal_patch(goal, body)

        assert "title" not in changed
        assert "status" in changed
        assert goal.title == "原标题"
        assert goal.status == "paused"
