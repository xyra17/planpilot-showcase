"""Event Processor — Phase 2C-3

职责：
- 轮询 learning_events（游标：LearningEvent.created_at）
- 按 event_type 分发到 ExtractionRule 列表
- 调用 PatternUpdateEngine.process() 更新 Pattern
- 持久化游标到 intelligence_cursors 表

设计约束（来自 Phase_2C-3_Pattern_Analyzer_Design.md D-5）：
- 不引入 Celery / APScheduler / 消息队列
- 同步调用入口：process_event(db, event)
- 批处理入口：run_batch(db)
- 调用方负责 db.commit()（保证 domain change + pattern update 原子落库）

调用示例（在 Domain Service 写入事件后立即处理）：
    await publisher.emit(db, ...)
    await process_event(db, event)
    await db.commit()

或批量处理（定期扫描未处理事件）：
    processed = await run_batch(db)
    # run_batch 内部会 commit
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import and_, not_, or_, select

from src.core.time import utc_now
from src.intelligence.extraction_rules import RuleRegistry, run_extractor
from src.intelligence.pattern_update_engine import PatternUpdateEngine
from src.models import IntelligenceCursor, LearningEvent, UserDataConsent

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

CONSUMER_NAME = "pattern_analyzer"
BATCH_SIZE = 100  # 每批最多处理的事件数


# ── 主接口 ──────────────────────────────────────────────────────────────────


async def process_event(db: "AsyncSession", event: LearningEvent) -> None:
    """处理单个 LearningEvent，同步调用（不 commit，由调用方 commit）。

    调用时机：Domain Service 写入 LearningEvent 后，在同一事务内调用。
    若 Rule 匹配失败或特征提取失败，记录日志后继续（不抛出）。
    """
    rules = RuleRegistry.get_rules(event.event_type)
    if not rules:
        return  # 快速路径：无 Rule 的事件类型直接跳过

    for rule in rules:
        if not rule.condition_check(event):
            continue
        try:
            features = await run_extractor(rule.rule_id, event, db)
            await PatternUpdateEngine.process(db, event, rule, features)
        except NotImplementedError:
            logger.warning(
                "No extractor for rule_id=%s (event_type=%s), skipping",
                rule.rule_id,
                event.event_type,
            )
        except Exception as exc:
            logger.error(
                "Error processing rule=%s for event=%s: %s",
                rule.rule_id,
                event.id,
                exc,
                exc_info=True,
            )
            # 单 Rule 失败不阻断其他 Rule


async def run_batch(db: "AsyncSession", batch_size: int = BATCH_SIZE) -> int:
    """批量处理游标之后的新 LearningEvent。

    游标持久化在 intelligence_cursors 表（consumer_name='pattern_analyzer'）。
    使用 LearningEvent.created_at 作为游标字段（单调递增，补录安全）。

    Returns:
        本批实际处理的事件数。
    """
    cursor = await _get_cursor(db)

    # 查询游标之后的新事件
    cursor_filter = LearningEvent.created_at.isnot(None)
    if cursor is not None and cursor.last_processed_at is not None:
        cursor_filter = or_(
            LearningEvent.created_at > cursor.last_processed_at,
            and_(
                LearningEvent.created_at == cursor.last_processed_at,
                LearningEvent.id > (cursor.last_event_id or ""),
            ),
        )
    stmt = (
        select(LearningEvent)
        .where(
            cursor_filter,
            not_(
                LearningEvent.user_id.in_(
                    select(UserDataConsent.user_id).where(
                        UserDataConsent.personalization_enabled.is_(False)
                    )
                )
            ),
        )
        .order_by(LearningEvent.created_at.asc(), LearningEvent.id.asc())
        .limit(batch_size)
    )
    result = await db.execute(stmt)
    events = result.scalars().all()

    if not events:
        return 0

    processed = 0
    new_cursor_at: datetime | None = None
    new_cursor_event_id: str | None = None

    for event in events:
        try:
            await process_event(db, event)
            new_cursor_at = event.created_at
            new_cursor_event_id = event.id
            processed += 1
        except Exception as exc:
            logger.error(
                "Unhandled error processing event=%s in batch: %s",
                event.id,
                exc,
                exc_info=True,
            )
            # 单事件失败不停止整批；游标停在失败事件前（下次重试）
            break

    # 推进游标（批次级，原子 commit）
    if new_cursor_at is not None:
        await _update_cursor(db, new_cursor_at, new_cursor_event_id)

    await db.commit()
    return processed


# ── 游标管理 ─────────────────────────────────────────────────────────────────


async def _get_cursor(db: "AsyncSession") -> IntelligenceCursor | None:
    """读取复合游标。首次运行时返回 None（处理所有历史事件）。"""
    result = await db.execute(
        select(IntelligenceCursor).where(IntelligenceCursor.consumer_name == CONSUMER_NAME)
    )
    cursor_row = result.scalar_one_or_none()
    return cursor_row


async def _update_cursor(
    db: "AsyncSession",
    last_processed_at: datetime,
    last_event_id: str | None,
) -> None:
    """更新或创建游标记录（upsert）。"""
    result = await db.execute(
        select(IntelligenceCursor).where(IntelligenceCursor.consumer_name == CONSUMER_NAME)
    )
    cursor_row = result.scalar_one_or_none()

    if cursor_row is None:
        db.add(
            IntelligenceCursor(
                consumer_name=CONSUMER_NAME,
                last_processed_at=last_processed_at,
                last_event_id=last_event_id,
            )
        )
    else:
        cursor_row.last_processed_at = last_processed_at
        cursor_row.last_event_id = last_event_id
        cursor_row.updated_at = utc_now()
