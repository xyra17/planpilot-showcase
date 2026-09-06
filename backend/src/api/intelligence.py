"""Knowledge graph and learning gap APIs."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.intelligence.evaluation import evaluation_summary
from src.intelligence.knowledge_graph import (
    ConceptCreate,
    ConceptMerge,
    ConceptSplit,
    ConceptUpdate,
    EdgeCreate,
    EdgeReview,
    KnowledgeGraphService,
    KnowledgeImpactPreview,
    KnowledgeMapActivate,
    KnowledgeMapBuild,
    KnowledgeMapReview,
)
from src.models import MasteryEvidence, User

router = APIRouter(prefix="/api/v1/intelligence", tags=["intelligence"])


@router.get("/evaluations/summary")
async def get_evaluation_summary(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    # Authentication is required even though benchmark rows contain no user data.
    _ = current_user
    return await evaluation_summary(db)


@router.post("/concepts", status_code=201)
async def create_concept(
    body: ConceptCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await KnowledgeGraphService.create_concept(db, current_user.id, body)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.patch("/concepts/{concept_id}")
async def update_concept(
    concept_id: str,
    body: ConceptUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await KnowledgeGraphService.update_concept(db, current_user.id, concept_id, body)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/edges", status_code=201)
async def create_edge(
    body: EdgeCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await KnowledgeGraphService.create_edge(db, current_user.id, body)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/knowledge-graph")
async def get_knowledge_graph(
    goal_id: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return await KnowledgeGraphService.get_graph(db, current_user.id, goal_id=goal_id)


@router.post("/knowledge-map/build")
async def build_knowledge_map(
    body: KnowledgeMapBuild,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await KnowledgeGraphService.build_resource_map(db, current_user.id, body)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/knowledge-map/review")
async def review_knowledge_map(
    body: KnowledgeMapReview,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await KnowledgeGraphService.review_map(db, current_user.id, body)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/knowledge-map/{goal_id}/versions")
async def list_knowledge_map_versions(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return {"items": await KnowledgeGraphService.list_versions(db, current_user.id, goal_id)}


@router.get("/knowledge-map/{goal_id}/diff")
async def diff_knowledge_map_versions(
    goal_id: str,
    from_version: int = Query(ge=1),
    to_version: int = Query(ge=1),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await KnowledgeGraphService.version_diff(
            db, current_user.id, goal_id, from_version, to_version
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/knowledge-map/{goal_id}/versions/{version}/activate")
async def activate_knowledge_map_version(
    goal_id: str,
    version: int,
    body: KnowledgeMapActivate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await KnowledgeGraphService.activate_version(
            db, current_user.id, goal_id, version, body.reason
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/knowledge-map/impact-preview")
async def preview_knowledge_change_impact(
    body: KnowledgeImpactPreview,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await KnowledgeGraphService.preview_impact(db, current_user.id, body)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/concepts/merge")
async def merge_concepts(
    body: ConceptMerge,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await KnowledgeGraphService.merge_concepts(db, current_user.id, body)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/concepts/{concept_id}/split")
async def split_concept(
    concept_id: str,
    body: ConceptSplit,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await KnowledgeGraphService.split_concept(db, current_user.id, concept_id, body)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/mastery-evidence")
async def list_mastery_evidence(
    goal_id: str = Query(),
    concept_id: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    statement = select(MasteryEvidence).where(
        MasteryEvidence.user_id == current_user.id,
        MasteryEvidence.goal_id == goal_id,
    )
    if concept_id:
        statement = statement.where(MasteryEvidence.concept_id == concept_id)
    rows = list(
        (
            await db.execute(statement.order_by(MasteryEvidence.created_at.desc()).limit(limit))
        ).scalars()
    )
    return {
        "items": [
            {
                "id": row.id,
                "goal_id": row.goal_id,
                "task_id": row.task_id,
                "concept_id": row.concept_id,
                "evidence_type": row.evidence_type,
                "score": row.score,
                "reliability": row.reliability,
                "source_item_id": row.source_item_id,
                "summary": row.summary,
                "detail": row.detail,
                "created_at": row.created_at.isoformat(),
            }
            for row in rows
        ]
    }


@router.patch("/edges/{edge_id}/review")
async def review_edge(
    edge_id: str,
    body: EdgeReview,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await KnowledgeGraphService.review_edge(db, current_user.id, edge_id, body)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/knowledge-gaps")
async def get_knowledge_gaps(
    goal_id: str | None = Query(default=None),
    limit: int = Query(default=10, ge=1, le=50),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    return await KnowledgeGraphService.detect_gaps(
        db, current_user.id, goal_id=goal_id, limit=limit
    )


@router.get("/concepts/{concept_id}/explain")
async def explain_concept_gap(
    concept_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await KnowledgeGraphService.explain_gap(db, current_user.id, concept_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/next-concepts")
async def get_next_concepts(
    goal_id: str | None = Query(default=None),
    limit: int = Query(default=5, ge=1, le=20),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    return await KnowledgeGraphService.next_concepts(
        db, current_user.id, goal_id=goal_id, limit=limit
    )
