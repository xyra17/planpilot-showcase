"""GoalService: 目标业务逻辑层

职责边界：
- Goal CRUD（DB write，single commit）
- 原子创建 Goal + KnowledgeBase
- 级联删除逻辑（6步骤）
- 进度计算（streak, avg_rate, trend）
- 计划详情聚合
- DTO 映射

不含：
- 路由参数解析
- 权限校验（goal归属由user_id校验）
- HTTP 异常处理（由router负责）
"""

from collections import defaultdict, deque
from datetime import date, timedelta

from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator
from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy import update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from src.domain.errors import DomainVersionConflict
from src.events.publisher import emit
from src.models import (
    CheckinRecord,
    Goal,
    GoalVersion,
    KnowledgeBase,
    KnowledgeItem,
    KnowledgeItemGoalLink,
    LearnerCognitiveProfile,
    LearnerProfile,
    Plan,
    Task,
)

# ── Constants ──────────────────────────────────────────────────────────────

_VALID_GOAL_TYPES = {"exam", "certification", "skill", "reading", "language", "habit"}
_VALID_STATUSES = {"active", "completed", "paused", "abandoned"}
_VALID_LEVELS = {"beginner", "intermediate", "advanced"}
_WORK_SCHEDULE_ALIASES = {
    "weekday": "weekday",
    "weekdays": "weekday",
    "weekend": "weekend",
    "weekends": "weekend",
    "all": "all",
}
_PRIVATE_KNOWLEDGE_TYPES = {"chat_note", "daily_log", "flash_card", "task_note", "quick_note"}


def _align_plan_tasks_to_baseline(tasks: list[Task], phases: list[dict]) -> list[Task]:
    """优先使用持久化顺序；旧计划则按基线标题恢复阶段归属。"""
    ordered = sorted(
        tasks,
        key=lambda task: (
            task.sequence_in_plan is None,
            task.sequence_in_plan if task.sequence_in_plan is not None else 0,
            task.scheduled_date or "",
            task.created_at.isoformat() if task.created_at else "",
            task.id,
        ),
    )
    if any(task.sequence_in_plan is not None for task in ordered):
        return ordered

    by_title: dict[str, deque[Task]] = defaultdict(deque)
    for task in ordered:
        by_title[task.title].append(task)

    aligned: list[Task] = []
    used_ids: set[str] = set()
    for phase in phases:
        for baseline_task in phase.get("tasks") or []:
            title = str(baseline_task.get("title") or "")
            while by_title[title] and by_title[title][0].id in used_ids:
                by_title[title].popleft()
            if by_title[title]:
                task = by_title[title].popleft()
                aligned.append(task)
                used_ids.add(task.id)

    aligned.extend(task for task in ordered if task.id not in used_ids)
    return aligned


class GoalPatchValidationError(ValueError):
    """A request is syntactically valid but invalid for the current Goal state."""

# ── API Schemas ────────────────────────────────────────────────────────────


class PendingKb(BaseModel):
    name: str
    description: str = ""


class GoalCreate(BaseModel):
    type: str
    title: str
    deadline: str
    daily_hours: float = 2.0
    current_level: str = "beginner"
    work_schedule: str = "all"  # weekday | weekend | all
    kb_id: str | None = None
    pending_kb: PendingKb | None = None
    meta: dict = {}

    @field_validator("type")
    @classmethod
    def type_valid(cls, v: str) -> str:
        if v not in _VALID_GOAL_TYPES:
            raise ValueError(
                "type 必须是 exam / certification / skill / reading / language / habit"
            )
        return v

    @field_validator("daily_hours")
    @classmethod
    def hours_valid(cls, v: float) -> float:
        return _validate_daily_hours(v)

    @field_validator("current_level")
    @classmethod
    def current_level_valid(cls, v: str) -> str:
        return _validate_current_level(v)

    @field_validator("work_schedule")
    @classmethod
    def work_schedule_valid(cls, v: str) -> str:
        return _validate_work_schedule(v)

    @field_validator("deadline")
    @classmethod
    def deadline_valid(cls, v: str, info: ValidationInfo) -> str:
        d = _parse_deadline(v)
        validation_today = date.today()
        if info.context and info.context.get("validation_today") is not None:
            validation_today = info.context["validation_today"]
        if d <= validation_today:
            raise ValueError("截止日期必须在今天之后")
        return v

    @classmethod
    def for_evaluation(cls, data: dict, *, validation_today: date) -> "GoalCreate":
        """Validate historical evaluation input against an explicit simulated date.

        Normal API construction still uses the real local date.  This opt-in entry
        point avoids process-wide clock monkeypatching and is intentionally not
        exposed by the HTTP schema.
        """
        return cls.model_validate(data, context={"validation_today": validation_today})


class GoalOut(BaseModel):
    id: str
    type: str
    title: str
    deadline: str
    daily_hours: float
    current_level: str
    status: str
    meta: dict
    created_at: str
    work_schedule: str = "all"
    kb_id: str | None = None
    knowledge_base_id: str | None = Field(default=None, exclude=True)
    version: int

    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def extract_meta_fields(self) -> "GoalOut":
        # Prefer direct columns; fall back to meta for legacy rows
        if self.knowledge_base_id is not None:
            self.kb_id = self.knowledge_base_id
        elif self.meta and "kb_id" in self.meta:
            self.kb_id = str(self.meta["kb_id"]) if self.meta["kb_id"] else None
        self.work_schedule = _normalize_work_schedule(self.work_schedule)
        if self.work_schedule == "all" and self.meta and "work_schedule" in self.meta:
            self.work_schedule = _normalize_work_schedule(str(self.meta["work_schedule"]))
        return self

    @field_validator("created_at", mode="before")
    @classmethod
    def fmt_dt(cls, v) -> str:
        return str(v) if v else ""


class GoalPatch(BaseModel):
    # ``type`` was historically ignored by Pydantic's default extra-field policy.
    # Accepting and validating it makes the existing edit payload effective without
    # rejecting older clients that send other harmless extra fields.
    type: str | None = None
    status: str | None = None
    title: str | None = None
    deadline: str | None = None
    daily_hours: float | None = None
    current_level: str | None = None
    work_schedule: str | None = None
    kb_id: str | None = None
    expected_version: int | None = None

    @field_validator("status")
    @classmethod
    def status_valid(cls, v: str | None) -> str | None:
        if v is not None and v not in _VALID_STATUSES:
            raise ValueError(f"status 必须是 {_VALID_STATUSES}")
        return v

    @field_validator("type")
    @classmethod
    def type_valid(cls, v: str | None) -> str | None:
        if v is not None and v not in _VALID_GOAL_TYPES:
            raise ValueError(
                "type 必须是 exam / certification / skill / reading / language / habit"
            )
        return v

    @field_validator("daily_hours")
    @classmethod
    def hours_valid(cls, v: float | None) -> float | None:
        return _validate_daily_hours(v) if v is not None else None

    @field_validator("current_level")
    @classmethod
    def current_level_valid(cls, v: str | None) -> str | None:
        return _validate_current_level(v) if v is not None else None

    @field_validator("work_schedule")
    @classmethod
    def work_schedule_valid(cls, v: str | None) -> str | None:
        return _validate_work_schedule(v) if v is not None else None

    @field_validator("deadline")
    @classmethod
    def deadline_valid(cls, v: str | None) -> str | None:
        # PATCH accepts an already-expired deadline at the schema layer because
        # the service must compare it with the stored Goal before deciding
        # whether it is unchanged or a forbidden past-date change.
        if v is not None:
            _parse_deadline(v)
        return v


class ProgressOut(BaseModel):
    goal_id: str
    title: str
    deadline: str
    total_tasks: int
    completed_tasks: int
    avg_completion_rate: float
    streak_days: int
    debt_count: int
    days_ahead_or_behind: int | None = None
    estimated_completion_date: str = ""


class TaskBriefOut(BaseModel):
    id: str
    title: str
    date: str
    status: str


def _parse_deadline(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValueError("deadline 格式应为 YYYY-MM-DD") from None


def _validate_daily_hours(value: float | None) -> float | None:
    if value is not None and not (0.5 <= value <= 12):
        raise ValueError("每日学习时间应在 0.5-12 小时之间")
    return value


def _validate_current_level(value: str) -> str:
    if value not in _VALID_LEVELS:
        raise ValueError("current_level 必须是 beginner / intermediate / advanced")
    return value


def _validate_work_schedule(value: str) -> str:
    normalized = _WORK_SCHEDULE_ALIASES.get(value)
    if normalized is None:
        raise ValueError("work_schedule 必须是 weekday / weekend / all")
    return normalized


def _normalize_work_schedule(value: str) -> str:
    """Normalize known legacy values while leaving unknown old data readable."""
    return _WORK_SCHEDULE_ALIASES.get(value, value)


# ── Internal Domain Helpers ────────────────────────────────────────────────


def _apply_goal_patch(goal: Goal, body: GoalPatch) -> set[str]:
    """将 GoalPatch 字段写入 goal ORM（不 commit）

    Returns:
        changed_fields: 发生变更的字段名集合
    """
    changed: set[str] = set()
    patch_data = body.model_dump(exclude_none=True)
    patch_data.pop("expected_version", None)

    # 直接列映射（不通过 setattr 的通用路径）
    if "work_schedule" in patch_data:
        value = patch_data.pop("work_schedule")
        if goal.work_schedule != value:
            goal.work_schedule = value
            changed.add("work_schedule")
    if "kb_id" in patch_data:
        value = patch_data.pop("kb_id")
        if goal.knowledge_base_id != value:
            goal.knowledge_base_id = value
            changed.add("knowledge_base_id")

    for field, value in patch_data.items():
        if getattr(goal, field) != value:
            setattr(goal, field, value)
            changed.add(field)

    return changed


def _calculate_streak(checkin_dates: set[str], today: date) -> int:
    """计算连续打卡天数（纯函数）

    今天已打卡从今天起算，否则从昨天起算（避免每天早上streak清零）
    """
    streak_days = 0
    check_date = today
    if check_date.isoformat() not in checkin_dates:
        check_date = check_date - timedelta(days=1)
    while check_date.isoformat() in checkin_dates:
        streak_days += 1
        check_date = check_date - timedelta(days=1)
    return streak_days


def _build_progress(
    goal: Goal,
    all_tasks: list,
    checkin_dates: set[str],
    today: date,
) -> ProgressOut:
    """纯计算：从已加载数据构建 ProgressOut

    Args:
        goal: Goal ORM 对象（只读）
        all_tasks: 该目标所有 Task ORM 对象
        checkin_dates: 正式打卡日期 | 任务完成日期的并集
        today: 当前日期
    """
    today_str = today.isoformat()
    total_tasks = len(all_tasks)
    completed_tasks = sum(1 for t in all_tasks if t.status == "completed")

    # 近7日完成率（基于任务实际状态）
    seven_days_ago = (today - timedelta(days=7)).isoformat()
    seven_days_tasks = [
        t for t in all_tasks if t.scheduled_date and seven_days_ago <= t.scheduled_date <= today_str
    ]
    avg_completion_rate = (
        sum(1 for t in seven_days_tasks if t.status == "completed") / len(seven_days_tasks)
        if seven_days_tasks
        else 0.0
    )

    streak_days = _calculate_streak(checkin_dates, today)

    # 趋势预测
    created_date = goal.created_at.date()
    deadline_date = date.fromisoformat(goal.deadline)
    total_project_days = max(1, (deadline_date - created_date).days)
    elapsed_days = max(1, (today - created_date).days)

    days_ahead_or_behind = None
    estimated_completion_date = goal.deadline

    min_tasks_for_trend = max(3, int(total_tasks * 0.1))
    if total_tasks > 0 and completed_tasks >= min_tasks_for_trend:
        expected_ratio = min(elapsed_days / total_project_days, 1.0)
        actual_ratio = completed_tasks / total_tasks
        days_ahead_or_behind = round((actual_ratio - expected_ratio) * total_project_days)
        remaining_tasks = total_tasks - completed_tasks
        daily_rate = completed_tasks / elapsed_days
        extra_days = int(remaining_tasks / daily_rate) if daily_rate > 0 else total_project_days
        estimated_completion_date = (today + timedelta(days=extra_days)).isoformat()

    debt_count = sum(
        1
        for t in all_tasks
        if t.status != "completed" and t.scheduled_date is not None and t.scheduled_date < today_str
    )

    return ProgressOut(
        goal_id=goal.id,
        title=goal.title,
        deadline=goal.deadline,
        total_tasks=total_tasks,
        completed_tasks=completed_tasks,
        avg_completion_rate=avg_completion_rate,
        streak_days=streak_days,
        debt_count=debt_count,
        days_ahead_or_behind=days_ahead_or_behind,
        estimated_completion_date=estimated_completion_date,
    )


# ── Public Service Methods ─────────────────────────────────────────────────


async def list_goals(user_id: str, db: AsyncSession) -> list[Goal]:
    """查询用户所有目标（按创建时间倒序）"""
    result = await db.execute(
        select(Goal).where(Goal.user_id == user_id).order_by(Goal.created_at.desc())
    )
    return list(result.scalars().all())


async def create_goal(user_id: str, body: GoalCreate, db: AsyncSession) -> Goal:
    """创建目标，支持原子创建关联 KnowledgeBase

    Args:
        user_id: 用户 ID
        body: 目标创建请求体
        db: 数据库会话

    Returns:
        新创建的 Goal ORM 对象
    """
    meta = dict(body.meta)

    # 原子创建 pending_kb：与 goal 在同一事务，任一失败全部回滚
    kb_id_to_use = body.kb_id
    if body.pending_kb:
        kb = KnowledgeBase(
            user_id=user_id,
            name=body.pending_kb.name,
            description=body.pending_kb.description,
        )
        db.add(kb)
        await db.flush()
        kb_id_to_use = kb.id

    goal = Goal(
        user_id=user_id,
        type=body.type,
        title=body.title,
        deadline=body.deadline,
        daily_hours=body.daily_hours,
        current_level=body.current_level,
        knowledge_base_id=kb_id_to_use,
        work_schedule=body.work_schedule,
        meta=meta,
    )
    db.add(goal)
    await db.flush()  # 让 SQLAlchemy 执行 INSERT 并触发 default=new_uuid，使 goal.id 可用
    await emit(
        db,
        user_id=user_id,
        goal_id=goal.id,
        aggregate_type="goal",
        aggregate_id=goal.id,
        event_type="GoalCreated",
        payload={
            "title": body.title,
            "type": body.type,
            "deadline": body.deadline,
            "daily_hours": body.daily_hours,
            "current_level": body.current_level,
            "work_schedule": body.work_schedule,
            "knowledge_base_id": kb_id_to_use,
            "aggregate_version": 1,
        },
    )
    db.add(
        GoalVersion(
            goal_id=goal.id,
            version=1,
            title_snapshot=goal.title,
            objective_snapshot=goal.description,
            constraints_snapshot={
                "deadline": goal.deadline,
                "daily_hours": goal.daily_hours,
                "work_schedule": goal.work_schedule,
            },
            change_reason="created",
            created_by="user",
        )
    )
    await db.commit()
    await db.refresh(goal)
    return goal


async def get_goal(user_id: str, goal_id: str, db: AsyncSession) -> Goal | None:
    """查询单个目标

    Returns:
        Goal ORM 对象，或 None（目标不存在/无权限）
    """
    result = await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
    return result.scalar_one_or_none()


async def update_goal(
    user_id: str,
    goal_id: str,
    body: GoalPatch,
    db: AsyncSession,
) -> Goal | None:
    """更新目标字段

    Args:
        user_id: 用户 ID
        goal_id: 目标 ID
        body: 目标 patch 请求体
        db: 数据库会话

    Returns:
        更新后的 Goal ORM 对象，或 None（目标不存在/无权限）
    """
    result = await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
    goal = result.scalar_one_or_none()
    if not goal:
        return None
    if body.expected_version is not None and body.expected_version != goal.version:
        raise DomainVersionConflict("goal", goal.id, body.expected_version, goal.version)

    if body.deadline is not None:
        requested_deadline = _parse_deadline(body.deadline)
        current_deadline = _parse_deadline(goal.deadline)
        if requested_deadline != current_deadline and requested_deadline <= date.today():
            raise GoalPatchValidationError("变更后的截止日期必须在今天之后")

    # 捕获旧值（用于 event payload）
    patch_data = body.model_dump(exclude_none=True)
    old_values = {}
    for field in patch_data.keys():
        if field == "kb_id":
            old_values["kb_id"] = goal.knowledge_base_id
        elif field == "work_schedule":
            old_values["work_schedule"] = goal.work_schedule
        else:
            old_values[field] = getattr(goal, field, None)

    changed_fields = _apply_goal_patch(goal, body)
    changed_fields.discard("expected_version")
    next_version = goal.version + 1 if changed_fields else goal.version

    # emit events（在 commit 前）
    if changed_fields:
        if "status" in changed_fields:
            await emit(
                db,
                user_id=user_id,
                goal_id=goal_id,
                aggregate_type="goal",
                aggregate_id=goal_id,
                event_type="GoalStatusChanged",
                payload={
                    "from_status": old_values.get("status"),
                    "to_status": goal.status,
                    "aggregate_version": next_version,
                },
            )

        other_fields = changed_fields - {"status"}
        if other_fields:
            before = {k: old_values.get(k) for k in other_fields if k in old_values}
            after = {}
            for field in other_fields:
                if field == "kb_id" or field == "knowledge_base_id":
                    after["kb_id"] = goal.knowledge_base_id
                elif field == "work_schedule":
                    after["work_schedule"] = goal.work_schedule
                else:
                    after[field] = getattr(goal, field, None)

            await emit(
                db,
                user_id=user_id,
                goal_id=goal_id,
                aggregate_type="goal",
                aggregate_id=goal_id,
                event_type="GoalUpdated",
                payload={
                    "changed_fields": list(other_fields),
                    "before": before,
                    "after": after,
                    "aggregate_version": next_version,
                },
            )

    if changed_fields:
        await db.flush()
        db.add(
            GoalVersion(
                goal_id=goal.id,
                version=goal.version,
                title_snapshot=goal.title,
                objective_snapshot=goal.description,
                constraints_snapshot={
                    "deadline": goal.deadline,
                    "daily_hours": goal.daily_hours,
                    "work_schedule": goal.work_schedule,
                    "status": goal.status,
                },
                change_reason=",".join(sorted(changed_fields)),
                created_by="user",
            )
        )

    await db.commit()
    await db.refresh(goal)
    return goal


async def delete_goal(
    user_id: str,
    goal_id: str,
    delete_kb: bool,
    db: AsyncSession,
    *,
    expected_version: int | None = None,
) -> bool:
    """删除目标及级联关联数据

    Args:
        user_id: 用户 ID
        goal_id: 目标 ID
        delete_kb: 是否同时删除关联知识库
        db: 数据库会话

    Returns:
        True 删除成功，False 目标不存在/无权限
    """
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
    ).scalar_one_or_none()
    if not goal:
        return False
    if expected_version is not None and expected_version != goal.version:
        raise DomainVersionConflict("goal", goal.id, expected_version, goal.version)

    await emit(
        db,
        user_id=user_id,
        goal_id=goal.id,
        aggregate_type="goal",
        aggregate_id=goal.id,
        event_type="GoalDeleted",
        payload={"title": goal.title, "aggregate_version": goal.version},
    )

    kb_id: str | None = goal.knowledge_base_id or (goal.meta or {}).get("kb_id")

    # 1. 获取该目标所有 task id
    task_ids = (await db.execute(select(Task.id).where(Task.goal_id == goal_id))).scalars().all()

    # 2. 删除任务专属资料及其关联。它们随任务一起失效，不参与资料复用。
    if task_ids:
        task_item_ids = select(KnowledgeItem.id).where(KnowledgeItem.task_id.in_(task_ids))
        await db.execute(
            sql_delete(KnowledgeItemGoalLink).where(
                KnowledgeItemGoalLink.item_id.in_(task_item_ids)
            )
        )
        await db.execute(sql_delete(KnowledgeItem).where(KnowledgeItem.task_id.in_(task_ids)))

    # 3. 私有笔记随目标删除；可复用资料只解除当前目标的关联。
    private_item_ids = select(KnowledgeItem.id).where(
        KnowledgeItem.goal_id == goal_id,
        KnowledgeItem.task_id.is_(None),
        KnowledgeItem.source_type.in_(_PRIVATE_KNOWLEDGE_TYPES),
    )
    await db.execute(
        sql_delete(KnowledgeItemGoalLink).where(KnowledgeItemGoalLink.item_id.in_(private_item_ids))
    )
    await db.execute(
        sql_delete(KnowledgeItem).where(
            KnowledgeItem.goal_id == goal_id,
            KnowledgeItem.task_id.is_(None),
            KnowledgeItem.source_type.in_(_PRIVATE_KNOWLEDGE_TYPES),
        )
    )

    shared_items = (
        (
            await db.execute(
                select(KnowledgeItem).where(
                    KnowledgeItem.goal_id == goal_id,
                    KnowledgeItem.task_id.is_(None),
                    KnowledgeItem.source_type.not_in(_PRIVATE_KNOWLEDGE_TYPES),
                )
            )
        )
        .scalars()
        .all()
    )
    await db.execute(
        sql_delete(KnowledgeItemGoalLink).where(KnowledgeItemGoalLink.goal_id == goal_id)
    )
    for item in shared_items:
        next_goal_id = (
            await db.execute(
                select(KnowledgeItemGoalLink.goal_id)
                .where(KnowledgeItemGoalLink.item_id == item.id)
                .order_by(KnowledgeItemGoalLink.goal_id)
                .limit(1)
            )
        ).scalar_one_or_none()
        # Keep the legacy scalar in sync for callers that have not adopted the link table yet.
        item.goal_id = next_goal_id

    # 4. 如果用户要求同时删除关联知识库
    if delete_kb and kb_id:
        # A knowledge base is only an archive location. Its resources can still serve other goals.
        await db.execute(
            sql_update(KnowledgeItem).where(KnowledgeItem.kb_id == kb_id).values(kb_id=None)
        )
        kb = (
            await db.execute(
                select(KnowledgeBase).where(
                    KnowledgeBase.id == kb_id,
                    KnowledgeBase.user_id == user_id,
                )
            )
        ).scalar_one_or_none()
        if kb:
            await db.delete(kb)

    # 5. 目标级学习画像是可重建快照。目标删除后不能降级为用户级
    # 画像，否则会与现有的用户级唯一记录冲突，也会混淆画像范围。
    await db.execute(sql_delete(LearnerProfile).where(LearnerProfile.goal_id == goal_id))
    await db.execute(
        sql_delete(LearnerCognitiveProfile).where(
            LearnerCognitiveProfile.goal_id == goal_id
        )
    )

    # 6. 按依赖顺序批量删除子表
    await db.execute(sql_delete(Task).where(Task.goal_id == goal_id))
    await db.execute(sql_delete(CheckinRecord).where(CheckinRecord.goal_id == goal_id))
    await db.execute(sql_delete(Plan).where(Plan.goal_id == goal_id))

    # 7. 最后删除目标本身
    await db.execute(sql_delete(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
    await db.commit()
    return True


async def get_progress(
    user_id: str,
    goal_id: str,
    db: AsyncSession,
) -> ProgressOut | None:
    """计算目标进度统计

    Returns:
        ProgressOut，或 None（目标不存在/无权限）
    """
    result = await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
    goal = result.scalar_one_or_none()
    if not goal:
        return None

    # 加载该目标所有任务
    all_tasks = (await db.execute(select(Task).where(Task.goal_id == goal_id))).scalars().all()

    # 构建打卡日期集合：正式打卡 + 任务完成日期
    today = date.today()
    today_str = today.isoformat()

    formal_checkin_dates = {
        c.date
        for c in (
            await db.execute(
                select(CheckinRecord).where(
                    CheckinRecord.goal_id == goal_id,
                    CheckinRecord.mode != "natural",
                )
            )
        )
        .scalars()
        .all()
    }

    task_done_dates = {
        t.scheduled_date
        for t in all_tasks
        if t.status == "completed"
        and t.scheduled_date is not None
        and t.scheduled_date <= today_str
    }

    checkin_dates = formal_checkin_dates | task_done_dates

    return _build_progress(goal, list(all_tasks), checkin_dates, today)


async def get_progress_summaries(user_id: str, db: AsyncSession) -> list[ProgressOut]:
    """批量计算用户目标进度，固定为目标/任务/打卡三次查询。

    The single-goal endpoint remains unchanged for existing clients. This
    batch service gives list screens a stable way to replace one progress
    request per goal without changing the meaning of any progress field.
    """
    goals = list(
        (
            await db.execute(
                select(Goal).where(Goal.user_id == user_id).order_by(Goal.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    if not goals:
        return []

    goal_ids = [goal.id for goal in goals]
    tasks = list(
        (
            await db.execute(select(Task).where(Task.goal_id.in_(goal_ids)))
        )
        .scalars()
        .all()
    )
    checkins = list(
        (
            await db.execute(
                select(CheckinRecord).where(
                    CheckinRecord.goal_id.in_(goal_ids),
                    CheckinRecord.mode != "natural",
                )
            )
        )
        .scalars()
        .all()
    )

    tasks_by_goal: dict[str, list[Task]] = defaultdict(list)
    for task in tasks:
        tasks_by_goal[task.goal_id].append(task)

    checkin_dates_by_goal: dict[str, set[str]] = defaultdict(set)
    for checkin in checkins:
        checkin_dates_by_goal[checkin.goal_id].add(checkin.date)

    today = date.today()
    today_str = today.isoformat()
    for task in tasks:
        if (
            task.status == "completed"
            and task.scheduled_date is not None
            and task.scheduled_date <= today_str
        ):
            checkin_dates_by_goal[task.goal_id].add(task.scheduled_date)

    return [
        _build_progress(
            goal,
            tasks_by_goal[goal.id],
            checkin_dates_by_goal[goal.id],
            today,
        )
        for goal in goals
    ]


async def list_goal_tasks(
    user_id: str,
    goal_id: str,
    db: AsyncSession,
) -> list[TaskBriefOut] | None:
    """查询目标任务列表

    Returns:
        任务简要信息列表，或 None（目标不存在/无权限）
    """
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
    ).scalar_one_or_none()
    if not goal:
        return None

    tasks = (
        (
            await db.execute(
                select(Task)
                .where(Task.goal_id == goal_id)
                .order_by(Task.scheduled_date, Task.created_at)
            )
        )
        .scalars()
        .all()
    )

    return [
        TaskBriefOut(id=t.id, title=t.title, date=t.scheduled_date, status=t.status) for t in tasks
    ]


async def get_goal_plan(
    user_id: str,
    goal_id: str,
    db: AsyncSession,
) -> dict | None:
    """查询目标当前计划详情（含阶段分解）

    Returns:
        计划详情字典，或 None（目标不存在/无权限）
    """
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
    ).scalar_one_or_none()
    if not goal:
        return None

    plan = (
        await db.execute(
            select(Plan)
            .where(Plan.goal_id == goal_id, Plan.is_current.is_(True))
            .order_by(Plan.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    if not plan:
        return {"plan": None}

    baseline = plan.baseline or {}
    phases = baseline.get("phases") or []

    # 当前 plan 下的任务（用于阶段明细）
    plan_tasks = (
        (
            await db.execute(
                select(Task)
                .where(Task.goal_id == goal_id, Task.plan_id == plan.id)
                .order_by(
                    Task.sequence_in_plan.is_(None),
                    Task.sequence_in_plan.asc(),
                    Task.scheduled_date.asc(),
                    Task.created_at.asc(),
                )
            )
        )
        .scalars()
        .all()
    )
    plan_tasks = _align_plan_tasks_to_baseline(plan_tasks, phases)

    # 目标下全部任务（用于整体进度）
    all_goal_tasks = (await db.execute(select(Task).where(Task.goal_id == goal_id))).scalars().all()

    tasks_by_phase: list[dict] = []
    task_idx = 0
    for phase in phases:
        phase_task_count = len(phase.get("tasks") or [])
        phase_tasks = plan_tasks[task_idx : task_idx + phase_task_count]
        phase_dates = [t.scheduled_date for t in phase_tasks if t.scheduled_date]
        done = sum(1 for t in phase_tasks if t.status == "completed")
        tasks_by_phase.append(
            {
                "name": phase.get("name", ""),
                "focus": phase.get("focus", ""),
                "days": phase.get("days", phase.get("weeks", 0)),
                "start_date": min(phase_dates) if phase_dates else "",
                "end_date": max(phase_dates) if phase_dates else "",
                "total": phase_task_count,
                "done": done,
                "tasks": [
                    {
                        "id": t.id,
                        "title": t.title,
                        "estimated_mins": t.estimated_mins,
                        "status": t.status,
                        "mastery_level": t.mastery_level,
                        "scheduled_date": t.scheduled_date,
                    }
                    for t in phase_tasks
                ],
            }
        )
        task_idx += phase_task_count

    return {
        "plan": {
            "id": plan.id,
            "version": plan.version,
            "created_at": plan.created_at.isoformat() if plan.created_at else "",
            "phases": tasks_by_phase,
            "total_tasks": len(all_goal_tasks),
            "completed_tasks": sum(1 for t in all_goal_tasks if t.status == "completed"),
        }
    }
