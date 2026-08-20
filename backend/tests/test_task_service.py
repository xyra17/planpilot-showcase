"""TaskService 纯函数单元测试

测试范围：
- _to_out
- _apply_completion_status
- _apply_patch_fields

所有测试为同步测试（纯函数，无 DB 依赖）。
"""

from datetime import datetime
from unittest.mock import MagicMock

from src.services.task_service import (
    TaskPatch,
    _apply_completion_status,
    _apply_patch_fields,
    _to_out,
)

# ── Helpers ────────────────────────────────────────────────────────────────


def _mock_task(**kwargs) -> MagicMock:
    """创建最小化的 Task mock 对象"""
    task = MagicMock()
    task.id = kwargs.get("id", "t1")
    task.title = kwargs.get("title", "任务标题")
    task.description = kwargs.get("description", None)
    task.goal_id = kwargs.get("goal_id", "g1")
    task.status = kwargs.get("status", "pending")
    task.estimated_mins = kwargs.get("estimated_mins", 30)
    task.scheduled_date = kwargs.get("scheduled_date", "2026-07-29")
    task.priority = kwargs.get("priority", "medium")
    task.mastery_level = kwargs.get("mastery_level", "L1")
    task.completed_at = kwargs.get("completed_at", None)
    task.actual_mins = kwargs.get("actual_mins", None)
    task.version = kwargs.get("version", 1)
    return task


# ── _to_out ────────────────────────────────────────────────────────────────


class TestToOut:
    def test_completed_task(self):
        task = _mock_task(status="completed", estimated_mins=45)
        out = _to_out(task, "Python 进阶")

        assert out.id == "t1"
        assert out.done is True
        assert out.estimatedMinutes == 45
        assert out.goalTitle == "Python 进阶"

    def test_pending_task(self):
        task = _mock_task(status="pending")
        out = _to_out(task, "目标")
        assert out.done is False

    def test_all_fields_mapped(self):
        task = _mock_task(
            id="abc",
            title="测试任务",
            description="描述",
            goal_id="g99",
            status="pending",
            estimated_mins=60,
            scheduled_date="2026-08-01",
            priority="high",
            mastery_level="L3",
        )
        out = _to_out(task, "目标标题")

        assert out.id == "abc"
        assert out.title == "测试任务"
        assert out.description == "描述"
        assert out.goalId == "g99"
        assert out.goalTitle == "目标标题"
        assert out.done is False
        assert out.estimatedMinutes == 60
        assert out.date == "2026-08-01"
        assert out.priority == "high"
        assert out.masteryLevel == "L3"


# ── _apply_completion_status ───────────────────────────────────────────────


class TestApplyCompletionStatus:
    def test_done_true_sets_completed(self):
        task = _mock_task(status="pending", completed_at=None)
        _apply_completion_status(task, True)

        assert task.status == "completed"
        assert task.completed_at is not None

    def test_done_false_sets_pending(self):
        task = _mock_task(status="completed", completed_at=datetime.now())
        _apply_completion_status(task, False)

        assert task.status == "pending"
        assert task.completed_at is None

    def test_completed_at_is_naive_utc(self):
        """completed_at 应为无时区信息的 UTC 时间（MySQL 兼容）"""
        task = _mock_task()
        _apply_completion_status(task, True)

        assert task.completed_at.tzinfo is None

    def test_idempotent_done_true(self):
        """重复设为 done=True 不应出错，completed_at 刷新"""
        task = _mock_task(status="completed")
        _apply_completion_status(task, True)
        assert task.status == "completed"


# ── _apply_patch_fields ────────────────────────────────────────────────────


class TestApplyPatchFields:
    def test_no_fields_returns_empty_set(self):
        task = _mock_task()
        body = TaskPatch()
        changed = _apply_patch_fields(task, body)
        assert changed == set()

    def test_done_true_returns_done_in_changed(self):
        task = _mock_task(status="pending")
        body = TaskPatch(done=True)
        changed = _apply_patch_fields(task, body)

        assert "done" in changed
        assert task.status == "completed"

    def test_done_false_returns_done_in_changed(self):
        task = _mock_task(status="completed")
        body = TaskPatch(done=False)
        changed = _apply_patch_fields(task, body)

        assert "done" in changed
        assert task.status == "pending"

    def test_title_update(self):
        task = _mock_task(title="旧标题")
        body = TaskPatch(title="新标题")
        changed = _apply_patch_fields(task, body)

        assert "title" in changed
        assert task.title == "新标题"

    def test_description_update(self):
        task = _mock_task(description=None)
        body = TaskPatch(description="新描述")
        changed = _apply_patch_fields(task, body)

        assert "description" in changed
        assert task.description == "新描述"

    def test_estimated_minutes_update(self):
        task = _mock_task(estimated_mins=30)
        body = TaskPatch(estimatedMinutes=60)
        changed = _apply_patch_fields(task, body)

        assert "estimatedMinutes" in changed
        assert task.estimated_mins == 60

    def test_priority_update(self):
        task = _mock_task(priority="medium")
        body = TaskPatch(priority="high")
        changed = _apply_patch_fields(task, body)

        assert "priority" in changed
        assert task.priority == "high"

    def test_mastery_level_update(self):
        task = _mock_task(mastery_level="L1")
        body = TaskPatch(mastery_level="L3")
        changed = _apply_patch_fields(task, body)

        assert "mastery_level" in changed
        assert task.mastery_level == "L3"

    def test_date_update(self):
        task = _mock_task(scheduled_date="2026-07-29")
        body = TaskPatch(date="2026-08-05")
        changed = _apply_patch_fields(task, body)

        assert "date" in changed
        assert task.scheduled_date == "2026-08-05"

    def test_multiple_fields_all_in_changed(self):
        task = _mock_task()
        body = TaskPatch(title="新标题", done=True, priority="low")
        changed = _apply_patch_fields(task, body)

        assert {"title", "done", "priority"}.issubset(changed)

    def test_none_fields_not_in_changed(self):
        """None 字段不应出现在 changed_fields 中，也不应修改 task"""
        task = _mock_task(title="原标题", priority="medium")
        body = TaskPatch(title=None, done=True, priority=None)
        changed = _apply_patch_fields(task, body)

        assert "title" not in changed
        assert "priority" not in changed
        assert task.title == "原标题"
        assert task.priority == "medium"
