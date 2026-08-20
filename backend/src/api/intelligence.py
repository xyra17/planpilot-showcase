"""Knowledge graph and learning gap APIs."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.intelligence.evaluation import evaluation_summary
from src.intelligence.knowledge_graph import (
    ConceptCreate,
    ConceptUpdate,
    EdgeCreate,
    KnowledgeGraphService,
)
from src.models import User

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
