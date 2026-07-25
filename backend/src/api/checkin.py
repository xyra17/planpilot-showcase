from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import CheckinRecord, Goal, LearningDebt, Task, User

router = APIRouter(prefix="/api/v1/checkin", tags=["checkin"])


class TaskCheckin(BaseModel):
    task_id: str
    status: str = "completed"  # completed | partial | skipped
    mastery: str | None = None  # L1 | L2 | L3 | L4
    actual_mins: int | None = None
    note: str | None = None


class CheckinBody(BaseModel):
    mode: str  # task_list | quick | natural | daily
    tasks: list[TaskCheckin] = []
    quick_status: str | None = None  # all_done | mostly_done | half_done | barely_done | explain
    text: str | None = None
    completion_rate: float | None = None  # direct value for daily mode (0.0–1.0)


class CheckinStats(BaseModel):
    total: int
    completed: int
    partial: int
    skipped: int
    completion_rate: float
    estimated_mins: int = 0
    actual_mins: int = 0


class CheckinResult(BaseModel):
    stats: CheckinStats
    feedback: str
    debt_added: int = 0
    replan_triggered: bool = False


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
    (1.0,  ["全部完成", "都完成", "100%", "全完成", "完成所有", "全搞定"]),
    (0.75, ["大部分", "基本完成", "75%", "大多数", "差不多都完成", "快完成了"]),
    (0.5,  ["一半", "50%", "部分完成", "有几个", "完成了一些"]),
    (0.25, ["一点点", "很少", "几乎没", "25%", "没做多少", "做了一点"]),
    (0.0,  ["没完成", "没做", "0%", "完全没", "什么都没", "没有做"]),
]


def _estimate_rate_from_text(text: str) -> float:
    for rate, keywords in _RATE_KEYWORDS:
        if any(kw in text for kw in keywords):
            return rate
    return 0.5


@router.post("/{goal_id}", response_model=CheckinResult)
async def checkin(
    goal_id: str,
    body: CheckinBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="目标不存在")

    today = date.today().isoformat()
    debt_added = 0
    estimated_mins_total = 0
    actual_mins_total = 0

    if body.mode == "daily":
        completion_rate = max(0.0, min(1.0, body.completion_rate if body.completion_rate is not None else 0.0))
        total = len(body.tasks)
        good_count = sum(1 for t in body.tasks if t.mastery in ("L3", "L4"))
        basic_count = sum(1 for t in body.tasks if t.mastery == "L2")
        unknown_count = total - good_count - basic_count
        completed, partial, skipped = good_count, basic_count, unknown_count
        feedback = (
            f"今日完成率 {round(completion_rate * 100)}%，"
            f"完全掌握 {good_count} 项，基本了解 {basic_count} 项，待加强 {unknown_count} 项。"
        )
        for t in body.tasks:
            if t.mastery:
                task_obj = (await db.execute(
                    select(Task).join(Goal, Task.goal_id == Goal.id)
                    .where(Task.id == t.task_id, Goal.user_id == current_user.id)
                )).scalar_one_or_none()
                if task_obj:
                    task_obj.mastery_level = t.mastery
                    if t.mastery in ("L3", "L4"):
                        task_obj.status = "completed"
                    # L2: 基本了解，不改变 status，保持 pending 直到完全掌握
                    if t.actual_mins:
                        task_obj.actual_mins = t.actual_mins
                        actual_mins_total += t.actual_mins
                    estimated_mins_total += task_obj.estimated_mins
        stats_data = {
            "total_tasks": total,
            "completion_rate": completion_rate,
            "tasks": [{"task_id": t.task_id, "mastery": t.mastery, "note": t.note} for t in body.tasks],
        }

    elif body.mode == "task_list" and body.tasks:
        total = len(body.tasks)
        completed = sum(1 for t in body.tasks if t.status == "completed")
        partial = sum(1 for t in body.tasks if t.status == "partial")
        skipped = sum(1 for t in body.tasks if t.status == "skipped")
        completion_rate = (completed + partial * 0.5) / total if total > 0 else 0.0
        feedback = f"今日完成 {completed}/{total} 项任务，完成率 {round(completion_rate * 100)}%。"
        if completion_rate >= 0.8:
            feedback += " 很棒，继续保持！"
        elif completion_rate >= 0.5:
            feedback += " 明天加把劲！"
        else:
            feedback += " 不要气馁，明天继续努力。"

        for t in body.tasks:
            task_obj = (await db.execute(select(Task).where(Task.id == t.task_id))).scalar_one_or_none()
            if task_obj:
                task_obj.status = t.status
                if t.mastery:
                    task_obj.mastery_level = t.mastery
                if t.actual_mins:
                    task_obj.actual_mins = t.actual_mins
                    actual_mins_total += t.actual_mins
                estimated_mins_total += task_obj.estimated_mins

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

        stats_data = {"total_tasks": total, "completion_rate": completion_rate}

    elif body.mode == "quick" and body.quick_status:
        qs = body.quick_status
        completion_rate = _QUICK_RATES.get(qs, 0.0)
        total = completed = partial = skipped = 0
        feedback = _FEEDBACK_TEMPLATES.get(qs, "已记录今日打卡。")
        stats_data = {"total_tasks": 0, "completion_rate": completion_rate}

    else:
        text = body.text or ""
        completion_rate = _estimate_rate_from_text(text)
        total = completed = partial = skipped = 0
        feedback = "已记录你的学习情况，AI 会在后续会话中结合这些信息为你优化计划。"
        stats_data = {"total_tasks": 0, "completion_rate": completion_rate}

    recent = (await db.execute(
        select(CheckinRecord)
        .where(
            CheckinRecord.goal_id == goal_id,
            CheckinRecord.user_id == current_user.id,
            CheckinRecord.mode != "natural",
        )
        .order_by(CheckinRecord.date.desc())
        .limit(2)
    )).scalars().all()
    replan = completion_rate < 0.6 and len(recent) >= 2 and all(r.completion_rate < 0.6 for r in recent)

    record = CheckinRecord(
        goal_id=goal_id,
        user_id=current_user.id,
        date=today,
        mode=body.mode,
        quick_status=body.quick_status,
        natural_text=body.text,
        completion_rate=completion_rate,
        stats=stats_data,
        feedback=feedback,
        replan_triggered=replan,
    )
    db.add(record)
    await db.commit()

    # 异步派发偏差检测（仅针对当前用户）
    from src.tasks.deviation import check_all_deviations
    check_all_deviations.apply_async(args=[current_user.id], countdown=5)

    return CheckinResult(
        stats=CheckinStats(
            total=total,
            completed=completed,
            partial=partial,
            skipped=skipped,
            completion_rate=completion_rate,
            estimated_mins=estimated_mins_total,
            actual_mins=actual_mins_total,
        ),
        feedback=feedback,
        debt_added=debt_added,
        replan_triggered=replan,
    )
