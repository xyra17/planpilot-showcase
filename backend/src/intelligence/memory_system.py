"""Three-layer Agent memory: computed short-term, episodic, and semantic."""

from __future__ import annotations

import math
from typing import Any

from sqlalchemy import and_, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.models import (
    CheckinRecord,
    DecisionProposal,
    IntelligenceCursor,
    LearnerPattern,
    LearningEvent,
    LearningMemory,
    Task,
    UserDataConsent,
)

MEMORY_CONSUMER = "memory_builder"
IMPORTANT_EVENT_TYPES = {
    "TaskSkipped",
    "TaskCompleted",
    "TaskRescheduled",
    "MasteryRecorded",
    "GoalStatusChanged",
    "ProposalAccepted",
    "ProposalRejected",
    "ProposalFeedbackRecorded",
}


class MemoryBuilder:
    @classmethod
    async def run_batch(cls, db: AsyncSession, *, batch_size: int = 200) -> int:
        cursor = (
            await db.execute(
                select(IntelligenceCursor).where(
                    IntelligenceCursor.consumer_name == MEMORY_CONSUMER
                )
            )
        ).scalar_one_or_none()
        cursor_filter = LearningEvent.created_at.isnot(None)
        if cursor and cursor.last_processed_at:
            cursor_filter = or_(
                LearningEvent.created_at > cursor.last_processed_at,
                and_(
                    LearningEvent.created_at == cursor.last_processed_at,
                    LearningEvent.id > (cursor.last_event_id or ""),
                ),
            )
        events = list(
            (
                await db.execute(
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
                    .order_by(LearningEvent.created_at, LearningEvent.id)
                    .limit(batch_size)
                )
            ).scalars()
        )
        if not events:
            return 0

        existing = set(
            (
                await db.execute(
                    select(LearningMemory.source_event_id).where(
                        LearningMemory.source_event_id.in_([event.id for event in events])
                    )
                )
            ).scalars()
        )
        for event in events:
            if event.id in existing or event.event_type not in IMPORTANT_EVENT_TYPES:
                continue
            memory = cls.from_event(event)
            if memory:
                db.add(memory)
        last = events[-1]
        if cursor is None:
            cursor = IntelligenceCursor(consumer_name=MEMORY_CONSUMER)
            db.add(cursor)
        cursor.last_processed_at = last.created_at
        cursor.last_event_id = last.id
        cursor.updated_at = utc_now()
        await db.commit()
        return len(events)

    @staticmethod
    def from_event(event: LearningEvent) -> LearningMemory | None:
        payload = event.payload or {}
        event_type = event.event_type
        title = str(payload.get("title") or payload.get("task_title") or "学习任务")[:120]
        memory_type = "milestone"
        importance = 0.55
        summary = ""
        if event_type == "TaskSkipped":
            memory_type, importance = "setback", 0.75
            summary = f"用户跳过了“{title}”，这是需要观察的执行中断。"
        elif event_type == "TaskRescheduled":
            memory_type, importance = "plan_adjustment", 0.65
            summary = f"用户将“{title}”从 {payload.get('from_date', '原日期')} 调整到 {payload.get('to_date', '新日期')}。"
        elif event_type == "TaskCompleted":
            overdue = int(payload.get("days_overdue") or 0)
            memory_type = "recovery" if overdue > 0 else "achievement"
            importance = 0.8 if overdue > 0 else 0.55
            summary = (
                f"用户在延期 {overdue} 天后完成了“{title}”，形成一次恢复行为。"
                if overdue > 0
                else f"用户完成了“{title}”。"
            )
        elif event_type == "MasteryRecorded":
            to_level = str(payload.get("to_level") or "unknown")
            memory_type = "breakthrough" if to_level in {"L3", "L4"} else "mastery_change"
            importance = 0.9 if memory_type == "breakthrough" else 0.6
            summary = f"“{title}”的掌握度提升到 {to_level}。"
        elif event_type == "GoalStatusChanged":
            status = str(payload.get("to_status") or payload.get("status") or "changed")
            memory_type = "interruption" if status in {"paused", "abandoned"} else "goal_transition"
            importance = 0.9 if memory_type == "interruption" else 0.65
            summary = f"学习目标状态变为 {status}。"
        elif event_type in {"ProposalAccepted", "ProposalRejected"}:
            accepted = event_type == "ProposalAccepted"
            memory_type, importance = "coach_preference", 0.7
            summary = f"用户{'接受' if accepted else '拒绝'}了 {payload.get('proposal_type', 'AI')} 建议。"
        elif event_type == "ProposalFeedbackRecorded":
            outcome = str(payload.get("outcome") or "neutral")
            memory_type, importance = "coach_outcome", 0.85
            summary = f"用户评价 {payload.get('proposal_type', 'AI')} 建议为 {outcome}。"
        if not summary:
            return None
        return LearningMemory(
            user_id=event.user_id,
            goal_id=event.goal_id,
            memory_type=memory_type,
            summary=summary,
            source_event_id=event.id,
            importance=importance,
            metadata_json={"event_type": event.event_type, "aggregate_id": event.aggregate_id},
            occurred_at=event.occurred_at,
        )


class MemoryService:
    @classmethod
    async def get_relevant_memories(
        cls,
        db: AsyncSession,
        user_id: str,
        *,
        goal_id: str | None = None,
        query: str | None = None,
        limit: int = 12,
    ) -> dict[str, list[dict[str, Any]]]:
        return {
            "short_term": await cls._short_term(db, user_id, goal_id, min(limit, 10)),
            "episodic": await cls._episodic(db, user_id, goal_id, query, limit),
            "semantic": await cls._semantic(db, user_id, goal_id, min(limit, 10)),
        }

    @staticmethod
    async def _short_term(
        db: AsyncSession, user_id: str, goal_id: str | None, limit: int
    ) -> list[dict[str, Any]]:
        # Explicit ownership query avoids relying on client-provided goal ids.
        from src.models import Goal

        task_stmt = select(Task).join(Goal, Task.goal_id == Goal.id).where(Goal.user_id == user_id)
        checkin_stmt = select(CheckinRecord).where(CheckinRecord.user_id == user_id)
        proposal_stmt = select(DecisionProposal).where(DecisionProposal.user_id == user_id)
        if goal_id:
            task_stmt = task_stmt.where(Task.goal_id == goal_id)
            checkin_stmt = checkin_stmt.where(CheckinRecord.goal_id == goal_id)
            proposal_stmt = proposal_stmt.where(DecisionProposal.goal_id == goal_id)
        tasks = list(
            (await db.execute(task_stmt.order_by(Task.updated_at.desc()).limit(limit))).scalars()
        )
        checkins = list(
            (
                await db.execute(checkin_stmt.order_by(CheckinRecord.created_at.desc()).limit(3))
            ).scalars()
        )
        proposals = list(
            (
                await db.execute(
                    proposal_stmt.order_by(DecisionProposal.created_at.desc()).limit(3)
                )
            ).scalars()
        )
        rows = [
            {
                "kind": "task",
                "id": row.id,
                "summary": f"{row.title} · {row.status}",
                "occurred_at": row.updated_at.isoformat() if row.updated_at else None,
            }
            for row in tasks
        ]
        rows.extend(
            {
                "kind": "checkin",
                "id": row.id,
                "summary": f"打卡完成率 {row.completion_rate:.0%}",
                "occurred_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in checkins
        )
        rows.extend(
            {
                "kind": "proposal",
                "id": row.id,
                "summary": f"{row.title} · {row.status}",
                "occurred_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in proposals
        )
        return sorted(rows, key=lambda row: row["occurred_at"] or "", reverse=True)[:limit]

    @staticmethod
    async def _episodic(
        db: AsyncSession,
        user_id: str,
        goal_id: str | None,
        query: str | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        stmt = select(LearningMemory).where(LearningMemory.user_id == user_id)
        if goal_id:
            stmt = stmt.where(
                or_(LearningMemory.goal_id == goal_id, LearningMemory.goal_id.is_(None))
            )
        rows = list(
            (
                await db.execute(stmt.order_by(LearningMemory.occurred_at.desc()).limit(100))
            ).scalars()
        )
        now = utc_now()
        query_parts = [part.lower() for part in (query or "").split() if part]
        scored: list[tuple[float, LearningMemory]] = []
        for row in rows:
            age_days = max(0.0, (now - row.occurred_at).total_seconds() / 86400)
            recency = math.exp(-age_days / 60)
            lexical = sum(part in row.summary.lower() for part in query_parts) / max(
                1, len(query_parts)
            )
            score = row.importance * 0.65 + recency * 0.25 + lexical * 0.1
            scored.append((score, row))
        return [
            {
                "id": row.id,
                "memory_type": row.memory_type,
                "summary": row.summary,
                "importance": row.importance,
                "relevance": round(score, 4),
                "source_event_id": row.source_event_id,
                "occurred_at": row.occurred_at.isoformat(),
            }
            for score, row in sorted(scored, key=lambda item: item[0], reverse=True)[:limit]
        ]

    @staticmethod
    async def _semantic(
        db: AsyncSession, user_id: str, goal_id: str | None, limit: int
    ) -> list[dict[str, Any]]:
        stmt = select(LearnerPattern).where(
            LearnerPattern.user_id == user_id,
            LearnerPattern.status == "active",
        )
        if goal_id:
            stmt = stmt.where(
                or_(LearnerPattern.goal_id == goal_id, LearnerPattern.goal_id.is_(None))
            )
        rows = list(
            (
                await db.execute(stmt.order_by(LearnerPattern.confidence.desc()).limit(limit))
            ).scalars()
        )
        return [
            {
                "id": row.id,
                "memory_type": "semantic_pattern",
                "summary": row.pattern_type,
                "value": row.pattern_value or {},
                "confidence": row.confidence,
                "scope": row.scope,
            }
            for row in rows
        ]
