"""主产品路线的偏差恢复事件关联。

该模块只连接已经发生的领域事实：偏差、恢复方案选择和后续真实行动。
不根据页面浏览或模型推断伪造“已恢复”。
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.events.publisher import emit
from src.models import LearningEvent

RECOVERY_WINDOW_HOURS = 72


async def emit_task_started_if_missing(
    db: AsyncSession,
    *,
    user_id: str,
    goal_id: str,
    task_id: str,
    trigger: str,
    from_status: str,
    scheduled_date: str | None,
    estimated_mins: int | None,
    source: str = "user_action",
    correlation_id: str | None = None,
    causation_id: str | None = None,
    extra_payload: dict | None = None,
) -> LearningEvent:
    """幂等补记任务的首次可观察开始事实。

    ``TaskStarted`` 只表示系统观察到首次执行信号，不由“任务已排入日程”
    单独推导。信号可以来自进入已确认时段时的前台活动、部分完成、实际
    投入或完成动作；同一任务生命周期只保留一个首次开始事件。
    """
    existing = await db.scalar(
        select(LearningEvent)
        .where(
            LearningEvent.user_id == user_id,
            LearningEvent.aggregate_id == task_id,
            LearningEvent.event_type == "TaskStarted",
        )
        .order_by(LearningEvent.occurred_at)
    )
    if existing is not None:
        return existing

    event = await emit(
        db,
        user_id=user_id,
        goal_id=goal_id,
        aggregate_type="task",
        aggregate_id=task_id,
        event_type="TaskStarted",
        source=source,
        correlation_id=correlation_id,
        causation_id=causation_id,
        idempotency_key=f"task-first-started:{task_id}",
        payload={
            "task_id": task_id,
            "trigger": trigger,
            "from_status": from_status,
            "scheduled_date": scheduled_date,
            "estimated_mins": estimated_mins,
            **(extra_payload or {}),
        },
    )
    await db.flush()
    await emit_recovery_completed_if_applicable(
        db,
        user_id=user_id,
        goal_id=goal_id,
        task_id=task_id,
        action_event=event,
    )
    return event


async def emit_deviation_detected(
    db: AsyncSession,
    *,
    user_id: str,
    goal_id: str,
    aggregate_id: str,
    deviation_type: str,
    payload: dict,
    source: str = "system",
    idempotency_key: str,
) -> LearningEvent:
    """记录一项可进入 72 小时恢复窗口的明确偏差。"""
    event = await emit(
        db,
        user_id=user_id,
        goal_id=goal_id,
        aggregate_type="deviation",
        aggregate_id=aggregate_id,
        event_type="DeviationDetected",
        source=source,
        idempotency_key=idempotency_key,
        payload={
            "deviation_type": deviation_type,
            "recovery_window_hours": RECOVERY_WINDOW_HOURS,
            **payload,
        },
    )
    # RecoverySelected/Completed 以该事件 ID 建立可审计因果关系；flush 只
    # 分配 ID，不提交事务，仍与调用方的领域变更保持原子性。
    await db.flush()
    return event


async def emit_recovery_selected(
    db: AsyncSession,
    *,
    user_id: str,
    goal_id: str,
    task_id: str,
    deviation_event: LearningEvent,
    strategy: str,
    trigger: str,
    from_date: str,
    to_date: str,
    source: str = "user_action",
) -> LearningEvent:
    """记录用户确认的恢复方案；预览或推荐本身不算选择。"""
    return await emit(
        db,
        user_id=user_id,
        goal_id=goal_id,
        aggregate_type="recovery",
        aggregate_id=deviation_event.id,
        event_type="RecoverySelected",
        source=source,
        causation_id=deviation_event.id,
        idempotency_key=f"recovery-selected:{deviation_event.id}",
        payload={
            "deviation_event_id": deviation_event.id,
            "task_id": task_id,
            "strategy": strategy,
            "trigger": trigger,
            "from_date": from_date,
            "to_date": to_date,
        },
    )


async def emit_recovery_completed_if_applicable(
    db: AsyncSession,
    *,
    user_id: str,
    goal_id: str,
    task_id: str,
    action_event: LearningEvent,
) -> LearningEvent | None:
    """把偏差后的首次任务开始/完成连接为一次恢复完成。

    同一偏差最多产生一个 ``RecoveryCompleted``。只有偏差发生之后、72
    小时窗口内的真实任务动作才算恢复；同一事务里刚创建的偏差不会被
    立即算作已恢复。
    """
    if action_event.id is None:
        await db.flush()
    window_start = action_event.occurred_at - timedelta(hours=RECOVERY_WINDOW_HOURS)
    deviations = list(
        (
            await db.execute(
                select(LearningEvent)
                .where(
                    LearningEvent.user_id == user_id,
                    LearningEvent.goal_id == goal_id,
                    LearningEvent.event_type == "DeviationDetected",
                    LearningEvent.occurred_at >= window_start,
                    LearningEvent.occurred_at < action_event.occurred_at,
                )
                .order_by(LearningEvent.occurred_at.desc())
            )
        ).scalars()
    )
    if not deviations:
        return None

    deviation_ids = {row.id for row in deviations}
    completed_rows = list(
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.user_id == user_id,
                    LearningEvent.goal_id == goal_id,
                    LearningEvent.event_type == "RecoveryCompleted",
                    LearningEvent.occurred_at >= window_start,
                )
            )
        ).scalars()
    )
    completed_deviation_ids = {
        str((row.payload or {}).get("deviation_event_id"))
        for row in completed_rows
        if (row.payload or {}).get("deviation_event_id")
    }
    deviation = next(
        (row for row in deviations if row.id in deviation_ids - completed_deviation_ids),
        None,
    )
    if deviation is None:
        return None

    latency_hours = round(
        (action_event.occurred_at - deviation.occurred_at).total_seconds() / 3600,
        2,
    )
    return await emit(
        db,
        user_id=user_id,
        goal_id=goal_id,
        aggregate_type="recovery",
        aggregate_id=deviation.id,
        event_type="RecoveryCompleted",
        source=action_event.source,
        correlation_id=action_event.correlation_id,
        causation_id=deviation.id,
        idempotency_key=f"recovery-completed:{deviation.id}",
        payload={
            "deviation_event_id": deviation.id,
            "action_event_id": action_event.id,
            "task_id": task_id,
            "action_type": action_event.event_type,
            "latency_hours": latency_hours,
            "within_72h": True,
        },
    )
