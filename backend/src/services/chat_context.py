"""Prepare compact, evidence-only context for the interactive coach chat."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from sqlalchemy import select

from src.database import AsyncSessionLocal
from src.intelligence.decision_context import DecisionContextBuilder
from src.services.retrieval_service import retrieval_service

logger = logging.getLogger(__name__)

KNOWLEDGE_QUERY_CUES = (
    "资料",
    "知识库",
    "文档",
    "笔记",
    "网页",
    "文件",
    "引用",
    "原文",
    "我上传",
)
NOTE_SOURCE_TYPES = {"chat_note", "daily_log", "flash_card", "task_note", "quick_note"}
PROFILE_FIELDS = (
    "consistency_score",
    "weekly_active_days",
    "avg_session_duration_mins",
    "avg_daily_investment_mins",
    "completion_rate_30d",
    "mastery_rate_30d",
    "mastery_velocity",
    "preferred_hour_start",
    "preferred_hour_end",
    "preferred_weekdays",
    "estimation_accuracy",
    "debt_tendency",
    "reschedule_rate",
)
COGNITIVE_FIELDS = (
    "learning_speed",
    "retention_rate",
    "forgetting_rate",
    "transfer_score",
    "persistence_score",
    "procrastination_score",
    "recovery_score",
    "difficulty_preference",
    "challenge_tolerance",
    "feedback_acceptance",
    "confidence",
    "sample_count",
)
GOAL_FIELDS = (
    "title",
    "type",
    "daily_hours",
    "deadline",
    "status",
    "description",
    "contract",
    "intent_version",
)
TASK_FIELDS = (
    "title",
    "scheduled_date",
    "estimated_mins",
    "status",
    "objective",
    "execution_guide",
)


def _present_fields(value: Any, fields: tuple[str, ...]) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    result = {field: value[field] for field in fields if value.get(field) is not None}
    return result or None


def _memory_summaries(memories: Any, limit: int = 8) -> list[dict[str, Any]]:
    if not isinstance(memories, dict):
        return []
    rows: list[dict[str, Any]] = []
    for category in ("short_term", "episodic", "semantic"):
        items = memories.get(category)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict) or not item.get("summary"):
                continue
            rows.append(
                {
                    "category": category,
                    "kind": item.get("kind") or item.get("memory_type"),
                    "summary": str(item["summary"])[:240],
                    "relevance": item.get("relevance") or item.get("confidence"),
                }
            )
            if len(rows) >= limit:
                return rows
    return rows


def _bounded_rows(value: Any, fields: tuple[str, ...], limit: int) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [
        {field: item[field] for field in fields if item.get(field) is not None}
        for item in value[:limit]
        if isinstance(item, dict)
    ]


def compact_decision_context(context: dict[str, Any]) -> dict[str, Any]:
    goal_context = context.get("goal_context")
    if not isinstance(goal_context, dict):
        goal_context = {}
    patterns = context.get("active_patterns")
    gaps = context.get("knowledge_gaps")
    events = context.get("recent_events")
    return {
        "data_quality": context.get("data_quality") or {},
        "user_timezone": context.get("user_timezone"),
        "goal": _present_fields(goal_context.get("goal"), GOAL_FIELDS),
        "task_summary": goal_context.get("task_summary"),
        "overdue_tasks": _bounded_rows(goal_context.get("overdue_tasks"), TASK_FIELDS, 5),
        "upcoming_tasks": _bounded_rows(goal_context.get("upcoming_tasks"), TASK_FIELDS, 7),
        "profile": _present_fields(context.get("profile"), PROFILE_FIELDS),
        "cognitive_profile": _present_fields(context.get("cognitive_profile"), COGNITIVE_FIELDS),
        "patterns": [
            {
                "type": item.get("pattern_type"),
                "explanation": str(item.get("explanation") or "")[:240],
                "confidence": item.get("confidence"),
            }
            for item in (patterns if isinstance(patterns, list) else [])[:5]
            if isinstance(item, dict)
        ],
        "memories": _memory_summaries(context.get("memories")),
        "knowledge_gaps": [
            {
                "concept": item.get("name") or item.get("label") or item.get("concept"),
                "gap_score": item.get("gap_score"),
            }
            for item in (gaps if isinstance(gaps, list) else [])[:5]
            if isinstance(item, dict)
        ],
        "recent_events": [
            {
                "type": item.get("event_type"),
                "occurred_at": item.get("occurred_at_local") or item.get("occurred_at"),
                "payload": item.get("payload") or {},
            }
            for item in (events if isinstance(events, list) else [])[-8:]
            if isinstance(item, dict)
        ],
    }


def should_retrieve_knowledge(message: str) -> bool:
    return any(cue in message for cue in KNOWLEDGE_QUERY_CUES)


async def _load_decision_context(user_id: str, goal_id: str | None) -> dict[str, Any]:
    async with AsyncSessionLocal() as session:
        return await DecisionContextBuilder.build(session, user_id, goal_id=goal_id)


async def _load_knowledge(
    user_id: str,
    goal_id: str | None,
    message: str,
    source_id: str | None = None,
    source_version: int | None = None,
) -> list[dict[str, Any]]:
    explicit_resource_query = should_retrieve_knowledge(message)
    if not explicit_resource_query and not source_id and not goal_id:
        return []
    async with AsyncSessionLocal() as session:
        if source_id:
            from src.models import KnowledgeItem, KnowledgeItemContentVersion

            item = await session.scalar(
                select(KnowledgeItem).where(
                    KnowledgeItem.id == source_id,
                    KnowledgeItem.user_id == user_id,
                    KnowledgeItem.source_type.in_(NOTE_SOURCE_TYPES),
                )
            )
            rows = []
            if item:
                rows = [item]
            version_row = None
            if rows and source_version is not None:
                version_row = await session.scalar(
                    select(KnowledgeItemContentVersion).where(
                        KnowledgeItemContentVersion.item_id == item.id,
                        KnowledgeItemContentVersion.version == source_version,
                    )
                )
                if version_row is None and source_version != item.content_version:
                    rows = []
        else:
            rows = await retrieval_service.search(
                session,
                user_id=user_id,
                query=message,
                goal_id=goal_id,
                limit=5,
                source_types=None if explicit_resource_query else NOTE_SOURCE_TYPES,
            )
        if source_id:
            return (
                [
                    {
                        "id": rows[0].id,
                        "title": version_row.title_snapshot if version_row else rows[0].title,
                        "snippet": (
                            (version_row.normalized_content_snapshot if version_row else None)
                            or rows[0].normalized_content
                            or rows[0].content
                        )[:800],
                        "citation": version_row.title_snapshot if version_row else rows[0].title,
                        "source_url": None,
                        "score": 1.0,
                        "source_type": "note",
                        "source_role": "user_note_evidence",
                        "content_version": version_row.version
                        if version_row
                        else rows[0].content_version,
                    }
                ]
                if rows
                else []
            )
    return [
        {
            "title": row.title,
            "snippet": row.snippet[:400],
            "citation": row.citation,
            "source_url": row.source_url,
            "score": row.score,
            "id": row.id,
            "source_type": row.source_type,
            "source_role": (
                "user_note_evidence"
                if row.source_type in NOTE_SOURCE_TYPES or row.source_role in {"note", "evidence"}
                else "scope_material"
                if row.source_role == "scope"
                else "reference_material"
            ),
            "source_metadata": row.source_metadata,
            "chunk_index": row.chunk_index,
        }
        for row in rows
        if not row.source_metadata
        or "answer_question" in (row.source_metadata.get("learning_use") or [])
        or row.source_role in {"note", "evidence"}
    ]


async def build_chat_context(
    *,
    user_id: str,
    goal_id: str | None,
    message: str,
    source_id: str | None = None,
    source_version: int | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build context in independent sessions so retrieval and profile reads can overlap."""

    started = time.monotonic()
    decision_result, knowledge_result = await asyncio.gather(
        _load_decision_context(user_id, goal_id),
        _load_knowledge(user_id, goal_id, message, source_id, source_version),
        return_exceptions=True,
    )
    if isinstance(decision_result, Exception):
        logger.warning("chat_context_decision_failed error_type=%s", type(decision_result).__name__)
        decision_context: dict[str, Any] = {}
    else:
        decision_context = compact_decision_context(decision_result)
    if isinstance(knowledge_result, Exception):
        logger.warning(
            "chat_context_retrieval_failed error_type=%s", type(knowledge_result).__name__
        )
        knowledge: list[dict[str, Any]] = []
    else:
        knowledge = knowledge_result
    context = {**decision_context, "knowledge_sources": knowledge}
    meta = {
        "latency_ms": round((time.monotonic() - started) * 1000, 1),
        "quality": (context.get("data_quality") or {}).get("level", "low"),
        "memory_count": len(context.get("memories") or []),
        "knowledge_count": len(knowledge),
    }
    logger.info("chat_context_ready meta=%s", meta)
    return context, meta
