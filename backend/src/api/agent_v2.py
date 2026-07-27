from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.agent_v2.orchestrator import (
    approve_run,
    cancel_run,
    create_run,
    pause_run,
    reject_run,
    resume_run,
    retry_run,
    run_detail,
    serialize_run,
    undo_run,
)
from src.core.agent_v2.registry import build_registry
from src.core.agent_v2.schemas import (
    ApprovalRequest,
    CreateRunRequest,
    ProactiveSuggestionRequest,
    RejectRequest,
)
from src.database import get_db
from src.deps import get_current_user
from src.models import AgentRun, User

router = APIRouter(prefix="/api/v2/agent", tags=["agent-v2"])


@router.get("/tools")
async def list_tools(_current_user: User = Depends(get_current_user)) -> list[dict]:
    return build_registry().public_catalog()


@router.post("/runs", status_code=201)
async def start_run(
    body: CreateRunRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    run = await create_run(
        db,
        user_id=current_user.id,
        request=body.request,
        goal_id=body.goal_id,
        step_budget=body.step_budget,
        token_budget=body.token_budget,
    )
    return await run_detail(db, current_user.id, run.id)


@router.get("/runs")
async def list_runs(
    limit: int = Query(default=20, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    runs = (
        (
            await db.execute(
                select(AgentRun)
                .where(AgentRun.user_id == current_user.id)
                .order_by(AgentRun.created_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return [serialize_run(run) for run in runs]


@router.get("/runs/{run_id}")
async def get_run(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return await run_detail(db, current_user.id, run_id)


@router.post("/runs/{run_id}/approve")
async def approve(
    run_id: str,
    body: ApprovalRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await approve_run(
        db,
        user_id=current_user.id,
        run_id=run_id,
        approval_id=body.approval_id,
        expected_hash=body.change_hash,
    )
    return await run_detail(db, current_user.id, run_id)


@router.post("/runs/{run_id}/reject")
async def reject(
    run_id: str,
    body: RejectRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await reject_run(
        db,
        user_id=current_user.id,
        run_id=run_id,
        approval_id=body.approval_id,
        reason=body.reason,
    )
    return await run_detail(db, current_user.id, run_id)


@router.post("/runs/{run_id}/cancel")
async def cancel(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await cancel_run(db, user_id=current_user.id, run_id=run_id)
    return await run_detail(db, current_user.id, run_id)


@router.post("/runs/{run_id}/pause")
async def pause(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await pause_run(db, user_id=current_user.id, run_id=run_id)
    return await run_detail(db, current_user.id, run_id)


@router.post("/runs/{run_id}/resume")
async def resume(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await resume_run(db, user_id=current_user.id, run_id=run_id)
    return await run_detail(db, current_user.id, run_id)


@router.post("/runs/{run_id}/retry")
async def retry(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await retry_run(db, user_id=current_user.id, run_id=run_id)
    return await run_detail(db, current_user.id, run_id)


@router.post("/runs/{run_id}/undo")
async def undo(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await undo_run(db, user_id=current_user.id, run_id=run_id)
    return await run_detail(db, current_user.id, run_id)


@router.post("/suggestions", status_code=201)
async def create_suggestion(
    body: ProactiveSuggestionRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    request = (
        f"主动检查最近 {body.lookback_days} 天的执行情况，"
        "如有落后任务则生成下周调整建议；只生成建议，任何修改都必须由我确认。"
    )
    run = await create_run(
        db,
        user_id=current_user.id,
        request=request,
        goal_id=body.goal_id,
        step_budget=10,
        token_budget=12000,
    )
    return await run_detail(db, current_user.id, run.id)
