"""Learner-owned knowledge graph and gap detection."""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.intelligence.cognitive_model import knowledge_retention
from src.models import Goal, KnowledgeEdge, KnowledgeItem, LearningConcept

ALLOWED_RELATIONS = {"prerequisite", "part_of", "related", "reinforces", "explained_by"}


class ConceptCreate(BaseModel):
    goal_id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    mastery_score: float = Field(default=0.0, ge=0.0, le=1.0)
    forgetting_rate: float = Field(default=0.05, ge=0.001, le=0.5)


class ConceptUpdate(BaseModel):
    description: str | None = Field(default=None, max_length=2000)
    mastery_score: float | None = Field(default=None, ge=0.0, le=1.0)
    forgetting_rate: float | None = Field(default=None, ge=0.001, le=0.5)
    reviewed: bool = False


class EdgeCreate(BaseModel):
    source_concept_id: str
    target_concept_id: str | None = None
    resource_item_id: str | None = None
    relation_type: str
    weight: float = Field(default=1.0, ge=0.0, le=5.0)
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)


def normalize_concept(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


class KnowledgeGraphService:
    @classmethod
    async def create_concept(
        cls, db: AsyncSession, user_id: str, body: ConceptCreate
    ) -> dict[str, Any]:
        if body.goal_id:
            owned = await db.scalar(
                select(Goal.id).where(Goal.id == body.goal_id, Goal.user_id == user_id)
            )
            if owned is None:
                raise LookupError("goal does not exist")
        normalized = normalize_concept(body.name)
        existing = (
            await db.execute(
                select(LearningConcept).where(
                    LearningConcept.user_id == user_id,
                    LearningConcept.normalized_name == normalized,
                    LearningConcept.goal_id == body.goal_id
                    if body.goal_id
                    else LearningConcept.goal_id.is_(None),
                )
            )
        ).scalar_one_or_none()
        if existing:
            return cls.concept_to_dict(existing)
        now = utc_now()
        row = LearningConcept(
            user_id=user_id,
            goal_id=body.goal_id,
            name=body.name.strip(),
            normalized_name=normalized,
            description=body.description,
            mastery_score=body.mastery_score,
            initial_strength=max(0.1, body.mastery_score),
            forgetting_rate=body.forgetting_rate,
            evidence_count=1 if body.mastery_score > 0 else 0,
            status="mastered" if body.mastery_score >= 0.8 else "learning",
            last_reviewed_at=now if body.mastery_score > 0 else None,
            next_review_at=cls._next_review(now, body.mastery_score, body.forgetting_rate)
            if body.mastery_score > 0
            else None,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return cls.concept_to_dict(row)

    @classmethod
    async def update_concept(
        cls, db: AsyncSession, user_id: str, concept_id: str, body: ConceptUpdate
    ) -> dict[str, Any]:
        row = await cls._owned_concept(db, user_id, concept_id)
        if body.description is not None:
            row.description = body.description
        if body.mastery_score is not None:
            row.mastery_score = body.mastery_score
            row.initial_strength = max(0.1, body.mastery_score)
            row.evidence_count += 1
            row.status = "mastered" if body.mastery_score >= 0.8 else "learning"
        if body.forgetting_rate is not None:
            row.forgetting_rate = body.forgetting_rate
        if body.reviewed or body.mastery_score is not None:
            row.last_reviewed_at = utc_now()
            row.next_review_at = cls._next_review(
                row.last_reviewed_at, row.initial_strength, row.forgetting_rate
            )
        row.updated_at = utc_now()
        await db.commit()
        return cls.concept_to_dict(row)

    @classmethod
    async def create_edge(cls, db: AsyncSession, user_id: str, body: EdgeCreate) -> dict[str, Any]:
        if body.relation_type not in ALLOWED_RELATIONS:
            raise ValueError("unsupported relation type")
        if bool(body.target_concept_id) == bool(body.resource_item_id):
            raise ValueError("edge must target exactly one concept or resource")
        await cls._owned_concept(db, user_id, body.source_concept_id)
        if body.target_concept_id:
            await cls._owned_concept(db, user_id, body.target_concept_id)
        if body.resource_item_id:
            owned_resource = await db.scalar(
                select(KnowledgeItem.id).where(
                    KnowledgeItem.id == body.resource_item_id,
                    KnowledgeItem.user_id == user_id,
                )
            )
            if owned_resource is None:
                raise LookupError("resource does not exist")
        existing = (
            await db.execute(
                select(KnowledgeEdge).where(
                    KnowledgeEdge.source_concept_id == body.source_concept_id,
                    KnowledgeEdge.target_concept_id == body.target_concept_id
                    if body.target_concept_id
                    else KnowledgeEdge.target_concept_id.is_(None),
                    KnowledgeEdge.resource_item_id == body.resource_item_id
                    if body.resource_item_id
                    else KnowledgeEdge.resource_item_id.is_(None),
                    KnowledgeEdge.relation_type == body.relation_type,
                )
            )
        ).scalar_one_or_none()
        if existing:
            existing.weight = body.weight
            existing.confidence = body.confidence
            existing.evidence_count += 1
            existing.updated_at = utc_now()
            row = existing
        else:
            row = KnowledgeEdge(user_id=user_id, **body.model_dump())
            db.add(row)
        await db.commit()
        await db.refresh(row)
        return cls.edge_to_dict(row)

    @classmethod
    async def get_graph(
        cls, db: AsyncSession, user_id: str, *, goal_id: str | None = None
    ) -> dict[str, Any]:
        concept_stmt = select(LearningConcept).where(LearningConcept.user_id == user_id)
        if goal_id:
            concept_stmt = concept_stmt.where(
                or_(LearningConcept.goal_id == goal_id, LearningConcept.goal_id.is_(None))
            )
        concepts = list((await db.execute(concept_stmt.order_by(LearningConcept.name))).scalars())
        ids = [row.id for row in concepts]
        edges = (
            list(
                (
                    await db.execute(
                        select(KnowledgeEdge).where(KnowledgeEdge.source_concept_id.in_(ids))
                    )
                ).scalars()
            )
            if ids
            else []
        )
        resources = []
        resource_ids = [row.resource_item_id for row in edges if row.resource_item_id]
        if resource_ids:
            resources = list(
                (
                    await db.execute(
                        select(KnowledgeItem).where(
                            KnowledgeItem.id.in_(resource_ids), KnowledgeItem.user_id == user_id
                        )
                    )
                ).scalars()
            )
        return {
            "concepts": [cls.concept_to_dict(row) for row in concepts],
            "resources": [
                {"id": row.id, "title": row.title, "source_type": row.source_type}
                for row in resources
            ],
            "edges": [cls.edge_to_dict(row) for row in edges],
        }

    @classmethod
    async def detect_gaps(
        cls,
        db: AsyncSession,
        user_id: str,
        *,
        goal_id: str | None = None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        graph = await cls.get_graph(db, user_id, goal_id=goal_id)
        prerequisites: dict[str, list[str]] = {}
        for edge in graph["edges"]:
            if edge["relation_type"] == "prerequisite" and edge["target_concept_id"]:
                prerequisites.setdefault(edge["target_concept_id"], []).append(
                    edge["source_concept_id"]
                )
        concepts = {row["id"]: row for row in graph["concepts"]}
        gaps = []
        for row in graph["concepts"]:
            prereq_scores = [
                concepts[item]["retention"]
                for item in prerequisites.get(row["id"], [])
                if item in concepts
            ]
            prereq_gap = 1.0 - min(prereq_scores) if prereq_scores else 0.0
            retention_gap = 1.0 - row["retention"] if row["evidence_count"] else 0.5
            gap_score = max(prereq_gap, retention_gap)
            if gap_score < 0.35:
                continue
            gaps.append(
                {
                    **row,
                    "gap_score": round(gap_score, 4),
                    "missing_prerequisites": prerequisites.get(row["id"], []),
                }
            )
        return sorted(gaps, key=lambda row: row["gap_score"], reverse=True)[:limit]

    @classmethod
    async def explain_gap(cls, db: AsyncSession, user_id: str, concept_id: str) -> dict[str, Any]:
        concept = await cls._owned_concept(db, user_id, concept_id)
        graph = await cls.get_graph(db, user_id, goal_id=concept.goal_id)
        by_id = {row["id"]: row for row in graph["concepts"]}
        prerequisite_ids = [
            row["source_concept_id"]
            for row in graph["edges"]
            if row["relation_type"] == "prerequisite" and row["target_concept_id"] == concept_id
        ]
        resources = [
            row["resource_item_id"]
            for row in graph["edges"]
            if row["source_concept_id"] == concept_id and row["resource_item_id"]
        ]
        current = cls.concept_to_dict(concept)
        weak = [
            by_id[item]
            for item in prerequisite_ids
            if item in by_id and by_id[item]["retention"] < 0.65
        ]
        return {
            "concept": current,
            "reason": "prerequisite_gap"
            if weak
            else "retention_decay"
            if current["retention"] < 0.65
            else "insufficient_evidence",
            "weak_prerequisites": weak,
            "resource_ids": resources,
            "recommendation": "先复习薄弱前置概念" if weak else "安排一次间隔复习并重新验证掌握度",
        }

    @classmethod
    async def next_concepts(
        cls, db: AsyncSession, user_id: str, *, goal_id: str | None = None, limit: int = 5
    ) -> list[dict[str, Any]]:
        graph = await cls.get_graph(db, user_id, goal_id=goal_id)
        concepts = {row["id"]: row for row in graph["concepts"]}
        prereqs: dict[str, list[str]] = {}
        for edge in graph["edges"]:
            if edge["relation_type"] == "prerequisite" and edge["target_concept_id"]:
                prereqs.setdefault(edge["target_concept_id"], []).append(edge["source_concept_id"])
        candidates = []
        for row in graph["concepts"]:
            if row["mastery_score"] >= 0.8:
                continue
            required = prereqs.get(row["id"], [])
            readiness = min(
                (concepts[item]["retention"] for item in required if item in concepts), default=1.0
            )
            if readiness >= 0.65:
                candidates.append({**row, "readiness": round(readiness, 4)})
        return sorted(candidates, key=lambda row: (-row["readiness"], row["mastery_score"]))[:limit]

    @staticmethod
    async def _owned_concept(db: AsyncSession, user_id: str, concept_id: str) -> LearningConcept:
        row = (
            await db.execute(
                select(LearningConcept).where(
                    LearningConcept.id == concept_id, LearningConcept.user_id == user_id
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise LookupError("concept does not exist")
        return row

    @staticmethod
    def _next_review(now: datetime, strength: float, forgetting_rate: float) -> datetime:
        days = max(1, min(30, round(max(0.1, strength) / max(0.001, forgetting_rate) * 0.35)))
        return now + timedelta(days=days)

    @staticmethod
    def concept_to_dict(row: LearningConcept) -> dict[str, Any]:
        elapsed = (
            max(0.0, (utc_now() - row.last_reviewed_at).total_seconds() / 86400)
            if row.last_reviewed_at
            else 0.0
        )
        retention = (
            knowledge_retention(row.initial_strength, row.forgetting_rate, elapsed)
            if row.evidence_count
            else 0.0
        )
        return {
            "id": row.id,
            "goal_id": row.goal_id,
            "name": row.name,
            "description": row.description,
            "mastery_score": row.mastery_score,
            "retention": retention,
            "forgetting_rate": row.forgetting_rate,
            "evidence_count": row.evidence_count,
            "status": row.status,
            "last_reviewed_at": row.last_reviewed_at.isoformat() if row.last_reviewed_at else None,
            "next_review_at": row.next_review_at.isoformat() if row.next_review_at else None,
        }

    @staticmethod
    def edge_to_dict(row: KnowledgeEdge) -> dict[str, Any]:
        return {
            "id": row.id,
            "source_concept_id": row.source_concept_id,
            "target_concept_id": row.target_concept_id,
            "resource_item_id": row.resource_item_id,
            "relation_type": row.relation_type,
            "weight": row.weight,
            "confidence": row.confidence,
            "evidence_count": row.evidence_count,
        }
