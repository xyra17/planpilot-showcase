from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import src.database as database
from src.core.agent_v2.orchestrator import (
    approve_run,
    cancel_run,
    create_run,
    delete_run,
    edit_approval,
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
    EditApprovalRequest,
    ProactiveSuggestionRequest,
    RejectRequest,
)
from src.database import get_db
from src.deps import get_current_user
from src.models import AgentAuditEvent, AgentRun, User
from src.tasks.agent_runs import dispatch_agent_run

router = APIRouter(prefix="/api/v2/agent", tags=["agent-v2"])
logger = logging.getLogger(__name__)

EVENT_STREAM_POLL_SECONDS = 1.0
EVENT_STREAM_HEARTBEAT_SECONDS = 15.0
EVENT_STREAM_BATCH_SIZE = 200


def _serialize_event(item: AgentAuditEvent) -> dict:
    return {
        "id": item.id,
        "sequence": item.sequence,
        "schema_version": item.schema_version,
        "step_id": item.step_id,
        "type": item.event_type,
        "actor": item.actor,
        "summary": item.safe_summary,
        "detail": item.detail,
        "created_at": item.created_at.isoformat() if item.created_at else None,
    }


def _event_cursor(after: int | None, last_event_id: str | None) -> int:
    cursor = after or 0
    if last_event_id:
        try:
            cursor = max(cursor, int(last_event_id))
        except ValueError as exc:
            raise HTTPException(400, "Last-Event-ID 必须是非负整数") from exc
    if cursor < 0:
        raise HTTPException(400, "事件 cursor 必须是非负整数")
    return cursor


async def _stream_run_events(request: Request, run_id: str, cursor: int) -> AsyncIterator[str]:
    heartbeat_elapsed = 0.0
    yield ": connected\n\n"
    while not await request.is_disconnected():
        async with database.AsyncSessionLocal() as session:
            events = list(
                (
                    await session.execute(
                        select(AgentAuditEvent)
                        .where(
                            AgentAuditEvent.run_id == run_id,
                            AgentAuditEvent.sequence > cursor,
                        )
                        .order_by(AgentAuditEvent.sequence)
                        .limit(EVENT_STREAM_BATCH_SIZE)
                    )
                )
                .scalars()
                .all()
            )
        if events:
            for item in events:
                payload = json.dumps(
                    _serialize_event(item), ensure_ascii=False, separators=(",", ":")
                )
                yield f"id: {item.sequence}\nevent: agent.audit.v1\ndata: {payload}\n\n"
                cursor = item.sequence
            heartbeat_elapsed = 0.0
            if len(events) == EVENT_STREAM_BATCH_SIZE:
                continue
        else:
            heartbeat_elapsed += EVENT_STREAM_POLL_SECONDS
            if heartbeat_elapsed >= EVENT_STREAM_HEARTBEAT_SECONDS:
                yield f": heartbeat {cursor}\n\n"
                heartbeat_elapsed = 0.0
        await asyncio.sleep(EVENT_STREAM_POLL_SECONDS)


def _dispatch(run_id: str, user_id: str) -> None:
    try:
        dispatch_agent_run(run_id, user_id)
    except Exception:
        logger.exception("Agent run dispatch failed; recovery task will retry: %s", run_id)


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
        auto_advance=False,
    )
    _dispatch(run.id, current_user.id)
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


@router.delete("/runs/{run_id}", status_code=204)
async def remove_run(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    await delete_run(db, user_id=current_user.id, run_id=run_id)


@router.post("/runs/{run_id}/approve")
async def approve(
    run_id: str,
    body: ApprovalRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    _run, approved_now = await approve_run(
        db,
        user_id=current_user.id,
        run_id=run_id,
        approval_id=body.approval_id,
        expected_hash=body.change_hash,
        change_set_version=body.change_set_version,
        run_state_version=body.run_state_version,
        high_risk_confirmed=body.high_risk_confirmed,
        auto_advance=False,
    )
    if approved_now:
        _dispatch(run_id, current_user.id)
    return await run_detail(db, current_user.id, run_id)


@router.patch("/runs/{run_id}/approvals/{approval_id}")
async def edit_change_set(
    run_id: str,
    approval_id: str,
    body: EditApprovalRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await edit_approval(
        db,
        user_id=current_user.id,
        run_id=run_id,
        approval_id=approval_id,
        change_set=body.change_set,
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
    detail = await run_detail(db, current_user.id, run_id)
    if detail["status"] == "queued":
        _dispatch(run_id, current_user.id)
    return detail


@router.post("/runs/{run_id}/retry")
async def retry(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await retry_run(db, user_id=current_user.id, run_id=run_id, auto_advance=False)
    _dispatch(run_id, current_user.id)
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
        auto_advance=False,
        run_kind="suggestion",
    )
    _dispatch(run.id, current_user.id)
    return await run_detail(db, current_user.id, run.id)


@router.get("/runs/{run_id}/events")
async def list_run_events(
    run_id: str,
    after: int | None = Query(default=None, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    owned = (
        await db.execute(
            select(AgentRun.id).where(AgentRun.id == run_id, AgentRun.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    if not owned:
        raise HTTPException(404, "Agent 任务不存在")
    query = select(AgentAuditEvent).where(AgentAuditEvent.run_id == run_id)
    if after is not None:
        query = query.where(AgentAuditEvent.sequence > after)
    events = list(
        (await db.execute(query.order_by(AgentAuditEvent.sequence).limit(limit))).scalars().all()
    )
    return {
        "events": [_serialize_event(item) for item in events],
        "next_cursor": events[-1].sequence if events else after,
    }


@router.get("/runs/{run_id}/events/stream")
async def stream_run_events(
    request: Request,
    run_id: str,
    after: int | None = Query(default=None, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    owned = (
        await db.execute(
            select(AgentRun.id).where(AgentRun.id == run_id, AgentRun.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    if not owned:
        raise HTTPException(404, "Agent 任务不存在")
    cursor = _event_cursor(after, request.headers.get("last-event-id"))
    return StreamingResponse(
        _stream_run_events(request, run_id, cursor),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
