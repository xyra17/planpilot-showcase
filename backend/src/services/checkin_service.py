"""CheckinService: 打卡业务逻辑层

职责边界：
- 纯计算函数（stats/feedback/metrics）
- Task mutations（DB write，但不 commit）
- LearningDebt 创建（DB write，但不 commit）
- CheckinRecord upsert（含 commit）
- Celery 派发（commit 之后）

不含：
- 路由参数解析
- 权限校验
- HTTP 异常处理（由 router 负责）
"""

from datetime import date
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.replan_policy import should_suggest_replan
from src.core.time import local_date_for_timezone
from src.events.publisher import emit
from src.models import CheckinRecord, Goal, LearningDebt, Task

# ── Constants ──────────────────────────────────────────────────────────────

_QUICK_RATES = {
    "all_done": 1.0,
    "mostly_done": 0.75,
    "half_done": 0.5,
    "barely_done": 0.1,
    "explain": 0.0,
}

_FEEDBACK_TEMPLATES = {
    "all_done": "太棒了！全部完成，保持这个势头！",
    "mostly_done": "完成得不错，明天继续加油！",
    "half_done": "完成了一半，注意调整节奏，明天争取更多。",
    "barely_done": "今天有点困难，没关系，明天重新出发。",
    "explain": "已记录你的情况，AI 会参考这些信息调整后续计划。",
}

_RATE_KEYWORDS: list[tuple[float, list[str]]] = [
    (1.0, ["全部完成", "都完成", "100%", "全完成", "完成所有", "全搞定"]),
    (0.75, ["大部分", "基本完成", "75%", "大多数", "差不多都完成", "快完成了"]),
    (0.5, ["一半", "50%", "部分完成", "有几个", "完成了一些"]),
    (0.25, ["一点点", "很少", "几乎没", "25%", "没做多少", "做了一点"]),
    (0.0, ["没完成", "没做", "0%", "完全没", "什么都没", "没有做"]),
]


# ── Input/Output Models ────────────────────────────────────────────────────


class TaskCheckinInput(BaseModel):
    """单个任务的打卡输入（与 API TaskCheckin 解耦）"""

    task_id: str
    status: str  # completed | partial | skipped
    mastery: str | None = None  # L1 | L2 | L3 | L4
    actual_mins: int | None = None
    note: str | None = None


class ComputeResult(BaseModel):
    """纯计算函数的输出"""

    completion_rate: float
    mastery_rate: float
    feedback: str
    stats_data: dict[str, Any]
    # 分解的计数器（用于构建 CheckinStats）
    total: int
    completed: int
    partial: int
    skipped: int
    estimated_mins: int
    actual_mins: int


# ── Pure Compute Functions ─────────────────────────────────────────────────


def _compute_daily_stats(
    tasks_input: list[TaskCheckinInput],
    tasks_by_id: dict[str, Task],  # 用于读取 estimated_mins，不可变
) -> ComputeResult:
    """计算 daily 模式的统计数据

    Args:
        tasks_input: 用户提交的任务打卡数据
        tasks_by_id: Task ORM 对象字典（只读，用于获取 estimated_mins）

    Returns:
        ComputeResult: 包含 completion_rate, mastery_rate, feedback, stats_data

    逻辑：
    - 执行率 = (completed + partial * 0.5) / total
    - 掌握率 = (L3/L4 完全掌握 + L2 基本了解 * 0.5) / total
    - completed/partial/skipped 对应 mastery level (L3/L4 / L2 / L1)
    """
    total = len(tasks_input)
    if total == 0:
        return ComputeResult(
            completion_rate=0.0,
            mastery_rate=0.0,
            feedback="今日无任务打卡。",
            stats_data={"total_tasks": 0, "completion_rate": 0.0, "mastery_rate": 0.0},
            total=0,
            completed=0,
            partial=0,
            skipped=0,
            estimated_mins=0,
            actual_mins=0,
        )

    # 执行率：基于 status 字段
    execution_completed = sum(1 for t in tasks_input if t.status == "completed")
    execution_partial = sum(1 for t in tasks_input if t.status == "partial")
    completion_rate = (execution_completed + execution_partial * 0.5) / total

    # 掌握率：基于 mastery 字段
    good_count = sum(1 for t in tasks_input if t.mastery in ("L3", "L4"))
    basic_count = sum(1 for t in tasks_input if t.mastery == "L2")
    unknown_count = total - good_count - basic_count
    mastery_rate = (good_count + basic_count * 0.5) / total

    # 时间统计
    estimated_mins_total = sum(
        tasks_by_id[t.task_id].estimated_mins for t in tasks_input if t.task_id in tasks_by_id
    )
    actual_mins_total = sum(t.actual_mins or 0 for t in tasks_input)

    # Feedback 文案
    feedback = (
        f"今日任务执行率 {round(completion_rate * 100)}%，"
        f"掌握度 {round(mastery_rate * 100)}%；"
        f"完全掌握 {good_count} 项，基本了解 {basic_count} 项，待加强 {unknown_count} 项。"
    )

    # stats_data（存储到 CheckinRecord.stats JSON）
    stats_data = {
        "total_tasks": total,
        "completion_rate": completion_rate,
        "completed": good_count,
        "partial": basic_count,
        "skipped": unknown_count,
        "mastery_rate": mastery_rate,
        "estimated_mins": estimated_mins_total,
        "actual_mins": actual_mins_total,
        "tasks": [t.model_dump() for t in tasks_input],
    }

    return ComputeResult(
        completion_rate=completion_rate,
        mastery_rate=mastery_rate,
        feedback=feedback,
        stats_data=stats_data,
        total=total,
        completed=good_count,
        partial=basic_count,
        skipped=unknown_count,
        estimated_mins=estimated_mins_total,
        actual_mins=actual_mins_total,
    )


def _compute_task_list_stats(
    tasks_input: list[TaskCheckinInput],
    tasks_by_id: dict[str, Task],  # 用于读取 estimated_mins
) -> ComputeResult:
    """计算 task_list 模式的统计数据

    Args:
        tasks_input: 用户提交的任务打卡数据
        tasks_by_id: Task ORM 对象字典（只读）

    Returns:
        ComputeResult

    逻辑：
    - 执行率 = (completed + partial * 0.5) / total
    - mastery_rate = 0（task_list 模式不关注掌握度）
    - completed/partial/skipped 基于 status 字段
    """
    total = len(tasks_input)
    if total == 0:
        return ComputeResult(
            completion_rate=0.0,
            mastery_rate=0.0,
            feedback="今日无任务打卡。",
            stats_data={"total_tasks": 0, "completion_rate": 0.0},
            total=0,
            completed=0,
            partial=0,
            skipped=0,
            estimated_mins=0,
            actual_mins=0,
        )

    completed = sum(1 for t in tasks_input if t.status == "completed")
    partial = sum(1 for t in tasks_input if t.status == "partial")
    skipped = sum(1 for t in tasks_input if t.status == "skipped")
    completion_rate = (completed + partial * 0.5) / total

    # Feedback 文案（带鼓励语）
    feedback = f"今日完成 {completed}/{total} 项任务，完成率 {round(completion_rate * 100)}%。"
    if completion_rate >= 0.8:
        feedback += " 很棒，继续保持！"
    elif completion_rate >= 0.5:
        feedback += " 明天加把劲！"
    else:
        feedback += " 不要气馁，明天继续努力。"

    # 时间统计
    estimated_mins_total = sum(
        tasks_by_id[t.task_id].estimated_mins for t in tasks_input if t.task_id in tasks_by_id
    )
    actual_mins_total = sum(t.actual_mins or 0 for t in tasks_input)

    stats_data = {
        "total_tasks": total,
        "completion_rate": completion_rate,
        "mastery_rate": 0.0,
        "completed": completed,
        "partial": partial,
        "skipped": skipped,
        "estimated_mins": estimated_mins_total,
    }

    return ComputeResult(
        completion_rate=completion_rate,
        mastery_rate=0.0,
        feedback=feedback,
        stats_data=stats_data,
        total=total,
        completed=completed,
        partial=partial,
        skipped=skipped,
        estimated_mins=estimated_mins_total,
        actual_mins=actual_mins_total,
    )


def _compute_quick_stats(quick_status: str) -> ComputeResult:
    """计算 quick 模式的统计数据

    Args:
        quick_status: all_done | mostly_done | half_done | barely_done | explain

    Returns:
        ComputeResult（total/completed/partial/skipped 均为 0）

    逻辑：
    - 从 _QUICK_RATES 查表得到 completion_rate
    - 从 _FEEDBACK_TEMPLATES 查表得到 feedback
    """
    completion_rate = _QUICK_RATES.get(quick_status, 0.0)
    feedback = _FEEDBACK_TEMPLATES.get(quick_status, "已记录今日打卡。")

    stats_data = {"total_tasks": 0, "completion_rate": completion_rate}

    return ComputeResult(
        completion_rate=completion_rate,
        mastery_rate=0.0,
        feedback=feedback,
        stats_data=stats_data,
        total=0,
        completed=0,
        partial=0,
        skipped=0,
        estimated_mins=0,
        actual_mins=0,
    )


def _estimate_rate_from_text(text: str) -> float:
    """从自然语言文本估算完成率（关键词匹配）"""
    for rate, keywords in _RATE_KEYWORDS:
        if any(kw in text for kw in keywords):
            return rate
    return 0.5


def _compute_natural_stats(text: str) -> ComputeResult:
    """计算 natural 模式的统计数据

    Args:
        text: 用户自然语言输入

    Returns:
        ComputeResult（total/completed/partial/skipped 均为 0）

    逻辑：
    - 对 text 做关键词匹配估算 completion_rate
    - 固定 feedback 文案
    """
    completion_rate = _estimate_rate_from_text(text)
    feedback = "已记录你的学习情况，AI 会在后续会话中结合这些信息为你优化计划。"

    stats_data = {"total_tasks": 0, "completion_rate": completion_rate}

    return ComputeResult(
        completion_rate=completion_rate,
        mastery_rate=0.0,
        feedback=feedback,
        stats_data=stats_data,
        total=0,
        completed=0,
        partial=0,
        skipped=0,
        estimated_mins=0,
        actual_mins=0,
    )


# ── API Schemas (moved from checkin.py) ────────────────────────────────────


class TaskCheckin(BaseModel):
    """单个任务打卡数据（API 输入）"""

    task_id: str
    status: str = "completed"  # completed | partial | skipped
    mastery: str | None = None  # L1 | L2 | L3 | L4
    actual_mins: int | None = None
    note: str | None = None


class CheckinBody(BaseModel):
    """打卡请求体"""

    mode: str  # task_list | quick | natural | daily
    tasks: list[TaskCheckin] = []
    quick_status: str | None = None  # all_done | mostly_done | half_done | barely_done | explain
    text: str | None = None
    completion_rate: float | None = None  # direct value for daily mode (0.0–1.0)


class CheckinStats(BaseModel):
    """打卡统计数据（API 输出）"""

    total: int
    completed: int
    partial: int
    skipped: int
    completion_rate: float
    mastery_rate: float = 0.0
    estimated_mins: int = 0
    actual_mins: int = 0


class CheckinResult(BaseModel):
    """打卡结果（API 输出）"""

    stats: CheckinStats
    feedback: str
    debt_added: int = 0
    replan_triggered: bool = False
    tasks: list[TaskCheckin] = Field(default_factory=list)


# ── DB Write Operations (no commit allowed) ────────────────────────────────


async def _validate_and_load_daily_tasks(
    tasks_input: list[TaskCheckin],
    goal_id: str,
    db: AsyncSession,
) -> dict[str, Task]:
    """验证 daily 模式任务并加载 ORM 对象

    Raises:
        HTTPException(400): 任务重复或不属于当前目标
    """
    task_ids = [item.task_id for item in tasks_input]
    if len(task_ids) != len(set(task_ids)):
        raise HTTPException(status_code=400, detail="打卡任务不能重复")

    owned_tasks = (
        (
            await db.execute(
                select(Task).where(
                    Task.goal_id == goal_id,
                    Task.id.in_(task_ids),
                )
            )
        )
        .scalars()
        .all()
        if task_ids
        else []
    )

    tasks_by_id = {task.id: task for task in owned_tasks}
    if len(tasks_by_id) != len(task_ids):
        raise HTTPException(status_code=400, detail="存在不属于当前目标的任务")

    return tasks_by_id


async def _apply_daily_mutations(
    tasks_input: list[TaskCheckin],
    tasks_by_id: dict[str, Task],
) -> None:
    """应用 daily 模式的 Task mutations（不 commit）

    副作用：修改 tasks_by_id 中的 Task 对象（mastery_level / status / actual_mins）

    ``actual_mins`` is independent from mastery: a completed task can have
    no mastery answer, and an explicit ``0`` is a valid recorded investment.
    Missing values leave an existing record unchanged.
    """
    for t in tasks_input:
        task_obj = tasks_by_id[t.task_id]
        if t.mastery:
            task_obj.mastery_level = t.mastery
            if t.mastery in ("L3", "L4"):
                task_obj.status = "completed"
            # L2: 基本了解，不改变 status，保持 pending 直到完全掌握
        if t.actual_mins is not None:
            task_obj.actual_mins = t.actual_mins


async def _apply_task_list_mutations_and_create_debts(
    tasks_input: list[TaskCheckin],
    goal_id: str,
    db: AsyncSession,
) -> int:
    """应用 task_list 模式的 Task mutations + 创建 LearningDebt（不 commit）

    Returns:
        debt_added: 新增学习债务数量
    """
    debt_added = 0
    for t in tasks_input:
        task_obj = (await db.execute(select(Task).where(Task.id == t.task_id))).scalar_one_or_none()
        if task_obj:
            task_obj.status = t.status
            if t.mastery:
                task_obj.mastery_level = t.mastery
            if t.actual_mins is not None:
                task_obj.actual_mins = t.actual_mins

            if t.status == "skipped":
                debt = LearningDebt(
                    goal_id=goal_id,
                    task_id=t.task_id,
                    content=task_obj.title,
                    estimated_hours=round(task_obj.estimated_mins / 60, 2),
                    skip_reason=t.note,
                    impact="medium",
                    status="open",
                )
                db.add(debt)
                debt_added += 1

    return debt_added


async def _compute_replan(
    goal_id: str,
    user_id: str,
    today: str,
    completion_rate: float,
    total: int,
    work_schedule: str,
    db: AsyncSession,
) -> bool:
    """计算是否需要触发重排（连续 3 个计划日执行率 < 60%）"""
    recent = (
        (
            await db.execute(
                select(CheckinRecord)
                .where(
                    CheckinRecord.goal_id == goal_id,
                    CheckinRecord.user_id == user_id,
                    CheckinRecord.mode != "natural",
                    CheckinRecord.date < today,
                )
                .order_by(CheckinRecord.date.desc())
                .limit(10)
            )
        )
        .scalars()
        .all()
    )

    rates_by_date = {r.date: r.completion_rate for r in recent}
    rates_by_date[today] = completion_rate

    return total > 0 and should_suggest_replan(
        rates_by_date=rates_by_date,
        end_date=date.fromisoformat(today),
        work_schedule=work_schedule,
    )


async def _upsert_checkin_record(
    goal_id: str,
    user_id: str,
    today: str,
    body: CheckinBody,
    completion_rate: float,
    stats_data: dict[str, Any],
    db: AsyncSession,
) -> None:
    """Upsert CheckinRecord（不 commit）

    更新今日最新记录（若存在）并删除重复，否则创建新记录。
    feedback / replan_triggered 已废弃，不再写入。
    """
    today_records = (
        (
            await db.execute(
                select(CheckinRecord)
                .where(
                    CheckinRecord.goal_id == goal_id,
                    CheckinRecord.user_id == user_id,
                    CheckinRecord.date == today,
                )
                .order_by(CheckinRecord.created_at.desc())
            )
        )
        .scalars()
        .all()
    )

    if today_records:
        record = today_records[0]
        record.mode = body.mode
        record.quick_status = body.quick_status
        record.natural_text = body.text
        record.completion_rate = completion_rate
        record.stats = stats_data
        # feedback / replan_triggered: deprecated columns, not writing new data
        for duplicate in today_records[1:]:
            await db.delete(duplicate)
    else:
        db.add(
            CheckinRecord(
                goal_id=goal_id,
                user_id=user_id,
                date=today,
                mode=body.mode,
                quick_status=body.quick_status,
                natural_text=body.text,
                completion_rate=completion_rate,
                stats=stats_data,
                # feedback / replan_triggered: deprecated, not written to new records
            )
        )


def _dispatch_deviation_check(user_id: str) -> None:
    """异步派发偏差检测 Celery 任务（fire-and-forget）

    注意：必须在 db.commit() 之后调用，确保数据已落库。
    """
    from src.tasks.deviation import check_all_deviations

    check_all_deviations.apply_async(args=[user_id], countdown=5)


# ── Public Service Methods ─────────────────────────────────────────────────


async def get_today(
    goal_id: str,
    user_id: str,
    db: AsyncSession,
    timezone_name: str = "Asia/Shanghai",
) -> CheckinResult | None:
    """查询今日已提交的打卡记录（只读）

    Returns:
        CheckinResult | None: 今日最新打卡结果，否则 None

    注意：
        Phase 2A 后新记录 feedback 字段为空（已停止写入 DB）。
        这是预期行为，不是 bug。
    """
    today = local_date_for_timezone(timezone_name).isoformat()
    records = (
        (
            await db.execute(
                select(CheckinRecord)
                .where(
                    CheckinRecord.goal_id == goal_id,
                    CheckinRecord.user_id == user_id,
                    CheckinRecord.date == today,
                )
                .order_by(CheckinRecord.created_at.desc())
            )
        )
        .scalars()
        .all()
    )

    if not records:
        return None

    record = records[0]
    s = record.stats or {}
    return CheckinResult(
        stats=CheckinStats(
            total=s.get("total_tasks", 0),
            completed=s.get("completed", 0),
            partial=s.get("partial", 0),
            skipped=s.get("skipped", 0),
            completion_rate=record.completion_rate,
            mastery_rate=s.get("mastery_rate", 0.0),
            estimated_mins=s.get("estimated_mins", 0),
            actual_mins=s.get("actual_mins", 0),
        ),
        feedback=record.feedback,  # Phase 2A 后新记录为空（历史记录保留）
        replan_triggered=record.replan_triggered,
        tasks=[TaskCheckin.model_validate(item) for item in s.get("tasks", [])],
    )


async def submit(
    goal: Goal,
    user_id: str,
    body: CheckinBody,
    db: AsyncSession,
    timezone_name: str = "Asia/Shanghai",
) -> CheckinResult:
    """提交打卡（主入口）

    Args:
        goal: 目标对象（已由 router 验证归属）
        user_id: 用户 ID
        body: 打卡请求体
        db: 数据库会话

    流程：
        1. Mode dispatch → 计算 stats + 验证/加载 tasks
        2. 应用 Task mutations（不 commit）
        3. 创建 LearningDebts（不 commit）
        4. 计算 replan policy
        5. Upsert CheckinRecord（不 commit）
        6. 单次 db.commit()
        7. 派发 Celery（commit 后）
    """
    today = local_date_for_timezone(timezone_name).isoformat()
    debt_added = 0

    # ── Mode dispatch ──────────────────────────────────────────────────────

    if body.mode == "daily":
        tasks_by_id = await _validate_and_load_daily_tasks(body.tasks, goal.id, db)
        tasks_input = [TaskCheckinInput.model_validate(t.model_dump()) for t in body.tasks]
        result = _compute_daily_stats(tasks_input, tasks_by_id)
        await _apply_daily_mutations(body.tasks, tasks_by_id)

    elif body.mode == "task_list" and body.tasks:
        # 先加载 tasks 用于 estimated_mins 计算
        tasks_by_id_for_compute: dict[str, Task] = {}
        for t in body.tasks:
            task_obj = (
                await db.execute(select(Task).where(Task.id == t.task_id))
            ).scalar_one_or_none()
            if task_obj:
                tasks_by_id_for_compute[t.task_id] = task_obj

        tasks_input = [TaskCheckinInput.model_validate(t.model_dump()) for t in body.tasks]
        result = _compute_task_list_stats(tasks_input, tasks_by_id_for_compute)
        debt_added = await _apply_task_list_mutations_and_create_debts(body.tasks, goal.id, db)

    elif body.mode == "quick" and body.quick_status:
        result = _compute_quick_stats(body.quick_status)

    else:  # natural / fallback
        result = _compute_natural_stats(body.text or "")

    # ── Replan policy ──────────────────────────────────────────────────────

    replan_triggered = await _compute_replan(
        goal.id,
        user_id,
        today,
        result.completion_rate,
        result.total,
        goal.work_schedule or "all",
        db,
    )

    # ── Upsert record（不 commit）─────────────────────────────────────────

    await _upsert_checkin_record(
        goal.id,
        user_id,
        today,
        body,
        result.completion_rate,
        result.stats_data,
        db,
    )

    # ── Emit events（不 commit）────────────────────────────────────────────

    # CheckinSubmitted
    await emit(
        db,
        user_id=user_id,
        goal_id=goal.id,
        aggregate_type="checkin",
        aggregate_id=f"{goal.id}:{today}",
        event_type="CheckinSubmitted",
        payload={
            "date": today,
            "mode": body.mode,
            "completion_rate": result.completion_rate,
            "mastery_rate": result.mastery_rate,
            "total_tasks": result.total,
            "completed": result.completed,
            "completed_count": result.completed,
            "partial": result.partial,
            "skipped": result.skipped,
            "replan_triggered": replan_triggered,
            "debt_added": debt_added,
            "estimated_mins": result.estimated_mins,
            "actual_mins": result.actual_mins,
            "time_investment_mins": result.actual_mins,
        },
    )

    # TaskSkipped events (task_list mode)
    if body.mode == "task_list":
        for t in body.tasks:
            if t.status == "skipped":
                task_obj = (
                    await db.execute(select(Task).where(Task.id == t.task_id))
                ).scalar_one_or_none()
                if task_obj:
                    await emit(
                        db,
                        user_id=user_id,
                        goal_id=goal.id,
                        aggregate_type="task",
                        aggregate_id=t.task_id,
                        event_type="TaskSkipped",
                        payload={
                            "title": task_obj.title,
                            "scheduled_date": task_obj.scheduled_date,
                            "skip_reason": t.note or "",
                            "debt_created": True,
                            "estimated_mins": task_obj.estimated_mins,
                        },
                    )

    # ── 单次 commit ────────────────────────────────────────────────────────

    await db.commit()

    # ── 派发 Celery（commit 后）────────────────────────────────────────────

    _dispatch_deviation_check(user_id)

    return CheckinResult(
        stats=CheckinStats(
            total=result.total,
            completed=result.completed,
            partial=result.partial,
            skipped=result.skipped,
            completion_rate=result.completion_rate,
            mastery_rate=result.mastery_rate,
            estimated_mins=result.estimated_mins,
            actual_mins=result.actual_mins,
        ),
        feedback=result.feedback,
        debt_added=debt_added,
        replan_triggered=replan_triggered,
        tasks=body.tasks,
    )
