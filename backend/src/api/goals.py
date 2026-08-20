from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import User
from src.services import goal_service
from src.services.goal_service import (
    GoalCreate,
    GoalOut,
    GoalPatch,
    GoalPatchValidationError,
    ProgressOut,
    TaskBriefOut,
)

router = APIRouter(prefix="/api/v1/goals", tags=["goals"])


@router.get("", response_model=list[GoalOut])
async def list_goals(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await goal_service.list_goals(current_user.id, db)


@router.post("", response_model=GoalOut, status_code=201)
async def create_goal(
    body: GoalCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await goal_service.create_goal(current_user.id, body, db)


@router.get("/progress", response_model=list[ProgressOut])
async def goals_progress(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return progress for all owned goals in one structured response."""
    return await goal_service.get_progress_summaries(current_user.id, db)


@router.get("/{goal_id}", response_model=GoalOut)
async def get_goal(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    goal = await goal_service.get_goal(current_user.id, goal_id, db)
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")
    return goal


@router.patch("/{goal_id}", response_model=GoalOut)
async def patch_goal(
    goal_id: str,
    body: GoalPatch,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        goal = await goal_service.update_goal(current_user.id, goal_id, body, db)
    except GoalPatchValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")
    return goal


@router.delete("/{goal_id}", status_code=204)
async def delete_goal(
    goal_id: str,
    delete_kb: bool = False,
    expected_version: int | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ok = await goal_service.delete_goal(
        current_user.id,
        goal_id,
        delete_kb,
        db,
        expected_version=expected_version,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="目标不存在")


@router.get("/{goal_id}/progress", response_model=ProgressOut)
async def goal_progress(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await goal_service.get_progress(current_user.id, goal_id, db)
    if result is None:
        raise HTTPException(status_code=404, detail="目标不存在")
    return result


@router.get("/{goal_id}/tasks", response_model=list[TaskBriefOut])
async def list_goal_tasks(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[TaskBriefOut]:
    result = await goal_service.list_goal_tasks(current_user.id, goal_id, db)
    if result is None:
        raise HTTPException(status_code=404, detail="目标不存在")
    return result


@router.get("/{goal_id}/plan")
async def get_goal_plan(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    result = await goal_service.get_goal_plan(current_user.id, goal_id, db)
    if result is None:
        raise HTTPException(status_code=404, detail="目标不存在")
    return result
