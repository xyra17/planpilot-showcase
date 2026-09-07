"""One retrieval contract for UI search, RAG evaluation and Agent tools."""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass

from pgvector.sqlalchemy import Vector
from sqlalchemy import cast, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.embedding import EmbeddingUnavailableError, embed_text
from src.models import KnowledgeChunk, KnowledgeItem, KnowledgeItemGoalLink

logger = logging.getLogger(__name__)

MIN_VECTOR_SCORE = 0.3
MAX_QUERY_LENGTH = 500
MAX_RESULTS = 20
CANDIDATE_MULTIPLIER = 3


@dataclass(frozen=True)
class RetrievalResult:
    id: str
    title: str
    snippet: str
    score: float
    goal_id: str | None
    kb_id: str | None
    source_type: str
    source_role: str
    source_metadata: dict[str, object]
    source_url: str | None
    citation: str
    chunk_index: int | None = None
    start_char: int | None = None
    end_char: int | None = None
    retrieval_method: str = "keyword_item"

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _goal_scope(goal_id: str):
    return or_(
        KnowledgeItem.goal_id == goal_id,
        KnowledgeItem.goal_links.any(KnowledgeItemGoalLink.goal_id == goal_id),
    )


def _keyword_score(title: str, content: str, query: str) -> float:
    tokens = _query_terms(query)
    haystack = f"{title} {content}".casefold()
    if not tokens:
        return 0.0
    token_recall = sum(token in haystack for token in tokens) / len(tokens)
    phrase_bonus = 0.2 if query.casefold() in haystack else 0.0
    title_bonus = 0.15 if any(token in title.casefold() for token in tokens) else 0.0
    return min(1.0, token_recall * 0.65 + phrase_bonus + title_bonus)


def _query_terms(query: str) -> list[str]:
    return list(dict.fromkeys(token for token in query.casefold().split() if token))


def _ilike_pattern(term: str) -> str:
    escaped = term.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
    return f"%{escaped}%"


def _matched_snippet(content: str, query: str, length: int = 300) -> str:
    folded = content.casefold()
    positions = [folded.find(term) for term in _query_terms(query)]
    positions = [position for position in positions if position >= 0]
    start = max(0, min(positions) - 60) if positions else 0
    return content[start : start + length].strip()


def _source_url(item: KnowledgeItem) -> str | None:
    return item.source_url or (item.source_metadata or {}).get("source_url")


def _base_item_filters(user_id: str, source_types: set[str] | None = None):
    filters = [
        KnowledgeItem.user_id == user_id,
        KnowledgeItem.note_id.is_(None),
        KnowledgeItem.processing_status == "ready",
    ]
    if source_types:
        filters.append(KnowledgeItem.source_type.in_(source_types))
    return tuple(filters)


class RetrievalService:
    async def search(
        self,
        db: AsyncSession,
        *,
        user_id: str,
        query: str,
        goal_id: str | None = None,
        limit: int = 5,
        source_types: set[str] | None = None,
    ) -> list[RetrievalResult]:
        normalized_query = " ".join(query.strip().split())[:MAX_QUERY_LENGTH]
        if not normalized_query:
            return []
        bounded_limit = max(1, min(limit, MAX_RESULTS))

        query_vector = None
        if db.get_bind().dialect.name == "postgresql":
            try:
                query_vector = await embed_text(normalized_query[:2000])
            except EmbeddingUnavailableError:
                pass
            except Exception as exc:
                logger.warning("retrieval_embedding_failed error_type=%s", type(exc).__name__)

        vector_results: list[RetrievalResult] = []
        if query_vector is not None:
            vector_results = await self._vector_search(
                db,
                user_id=user_id,
                query=normalized_query,
                query_vector=query_vector,
                goal_id=goal_id,
                limit=bounded_limit,
                source_types=source_types,
            )
        keyword_results = await self._keyword_search(
            db,
            user_id=user_id,
            query=normalized_query,
            goal_id=goal_id,
            limit=bounded_limit,
            source_types=source_types,
        )
        # Hybrid retrieval prevents a semantically similar chunk from hiding an
        # exact phrase match. Deduplicate by source/chunk and retain the stronger
        # score while preserving stable citations.
        merged: dict[tuple[str, int | None], RetrievalResult] = {}
        for result in [*vector_results, *keyword_results]:
            key = (result.id, result.chunk_index)
            current = merged.get(key)
            if current is None or result.score > current.score:
                merged[key] = result
        results = sorted(merged.values(), key=lambda result: (-result.score, result.id))[
            :bounded_limit
        ]
        logger.info(
            "retrieval_completed method=hybrid user_id=%s result_count=%d",
            user_id,
            len(results),
        )
        return results

    async def _vector_search(
        self,
        db: AsyncSession,
        *,
        user_id: str,
        query: str,
        query_vector: list[float],
        goal_id: str | None,
        limit: int,
        source_types: set[str] | None,
    ) -> list[RetrievalResult]:
        score = (
            1 - KnowledgeChunk.embedding.cosine_distance(cast(query_vector, Vector(1024)))
        ).label("score")
        statement = (
            select(KnowledgeChunk, KnowledgeItem, score)
            .join(KnowledgeItem, KnowledgeItem.id == KnowledgeChunk.item_id)
            .where(
                *_base_item_filters(user_id, source_types),
                KnowledgeChunk.embedding.is_not(None),
            )
        )
        if goal_id:
            statement = statement.where(_goal_scope(goal_id))
        rows = (
            await db.execute(statement.order_by(score.desc()).limit(limit * CANDIDATE_MULTIPLIER))
        ).all()
        results = [
            RetrievalResult(
                id=item.id,
                title=item.title,
                snippet=chunk.content[:300].strip(),
                score=round(float(row_score), 3),
                goal_id=item.goal_id,
                kb_id=item.kb_id,
                source_type=item.source_type,
                source_role=item.source_role or "reference",
                source_metadata=item.source_metadata or {},
                source_url=_source_url(item),
                chunk_index=chunk.chunk_index,
                start_char=chunk.start_char,
                end_char=chunk.end_char,
                citation=f"{item.title} · 第 {chunk.chunk_index + 1} 段",
                retrieval_method="vector_chunk",
            )
            for chunk, item, row_score in rows
            if float(row_score) >= MIN_VECTOR_SCORE
        ]
        if results:
            return results[:limit]

        legacy_score = (
            1 - KnowledgeItem.embedding.cosine_distance(cast(query_vector, Vector(1024)))
        ).label("score")
        legacy = select(KnowledgeItem, legacy_score).where(
            *_base_item_filters(user_id, source_types),
            KnowledgeItem.embedding.is_not(None),
        )
        if goal_id:
            legacy = legacy.where(_goal_scope(goal_id))
        legacy_rows = (await db.execute(legacy.order_by(legacy_score.desc()).limit(limit))).all()
        return [
            self._item_result(item, query, float(row_score), "vector_item")
            for item, row_score in legacy_rows
            if float(row_score) >= MIN_VECTOR_SCORE
        ]

    async def _keyword_search(
        self,
        db: AsyncSession,
        *,
        user_id: str,
        query: str,
        goal_id: str | None,
        limit: int,
        source_types: set[str] | None,
    ) -> list[RetrievalResult]:
        terms = _query_terms(query)
        patterns = [_ilike_pattern(term) for term in terms]
        chunk_matches = [KnowledgeChunk.content.ilike(pattern, escape="\\") for pattern in patterns]
        chunk_statement = (
            select(KnowledgeChunk, KnowledgeItem)
            .join(KnowledgeItem, KnowledgeItem.id == KnowledgeChunk.item_id)
            .where(
                *_base_item_filters(user_id, source_types),
                or_(*chunk_matches),
            )
        )
        if goal_id:
            chunk_statement = chunk_statement.where(_goal_scope(goal_id))
        chunk_rows = (await db.execute(chunk_statement.limit(limit * CANDIDATE_MULTIPLIER))).all()
        chunk_results = [
            RetrievalResult(
                id=item.id,
                title=item.title,
                snippet=_matched_snippet(chunk.content, query),
                score=round(_keyword_score(item.title, chunk.content, query), 3),
                goal_id=item.goal_id,
                kb_id=item.kb_id,
                source_type=item.source_type,
                source_role=item.source_role or "reference",
                source_metadata=item.source_metadata or {},
                source_url=_source_url(item),
                chunk_index=chunk.chunk_index,
                start_char=chunk.start_char,
                end_char=chunk.end_char,
                citation=f"{item.title} · 第 {chunk.chunk_index + 1} 段",
                retrieval_method="keyword_chunk",
            )
            for chunk, item in chunk_rows
        ]
        if chunk_results:
            return sorted(chunk_results, key=lambda result: (-result.score, result.id))[:limit]

        item_matches = []
        for pattern in patterns:
            item_matches.extend(
                [
                    KnowledgeItem.title.ilike(pattern, escape="\\"),
                    KnowledgeItem.content.ilike(pattern, escape="\\"),
                ]
            )
        item_statement = select(KnowledgeItem).where(
            *_base_item_filters(user_id, source_types),
            or_(*item_matches),
        )
        if goal_id:
            item_statement = item_statement.where(_goal_scope(goal_id))
        items = (
            (await db.execute(item_statement.limit(limit * CANDIDATE_MULTIPLIER))).scalars().all()
        )
        results = [
            self._item_result(
                item,
                query,
                _keyword_score(item.title, item.content[:2000], query),
                "keyword_item",
            )
            for item in items
        ]
        return sorted(results, key=lambda result: (-result.score, result.id))[:limit]

    @staticmethod
    def _item_result(item: KnowledgeItem, query: str, score: float, method: str) -> RetrievalResult:
        return RetrievalResult(
            id=item.id,
            title=item.title,
            snippet=_matched_snippet(item.content, query, length=200),
            score=round(score, 3),
            goal_id=item.goal_id,
            kb_id=item.kb_id,
            source_type=item.source_type,
            source_role=item.source_role or "reference",
            source_metadata=item.source_metadata or {},
            source_url=_source_url(item),
            citation=item.title,
            retrieval_method=method,
        )


retrieval_service = RetrievalService()
