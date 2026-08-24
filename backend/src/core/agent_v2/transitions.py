from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.agent_v2.audit import record_event
from src.core.time import utc_now
from src.models import AgentRun, AgentStep

RUN_TRANSITIONS = {
    "queued": {"executing", "paused", "cancelled"},
    "executing": {
        "queued",
        "waiting_approval",
        "retrying",
        "replanning",
        "paused",
        "completed",
        "failed",
        "cancelled",
    },
    "waiting_approval": {"queued", "completed", "rejected", "cancelled"},
    "retrying": {"queued", "executing", "failed", "cancelled"},
    "replanning": {"executing", "waiting_approval", "failed", "cancelled"},
    "paused": {"queued", "cancelled"},
    "completed": {"compensating"},
    "compensating": {"rolled_back", "failed"},
    "failed": {"queued", "cancelled"},
}

STEP_TRANSITIONS = {
    "pending": {
        "ready",
        "running",
        "failed",
        "blocked",
        "skipped",
        "superseded",
        "waiting_approval",
    },
    "ready": {"running", "failed", "blocked", "superseded", "waiting_approval"},
    "running": {"completed", "retrying", "failed", "waiting_approval", "superseded"},
    "retrying": {"running", "failed", "superseded"},
    "waiting_approval": {"pending", "ready", "skipped", "superseded"},
    "failed": {"pending", "superseded"},
}


async def transition_run(
    db: AsyncSession,
    run: AgentRun,
    target: str,
    *,
    actor: str,
    detail: dict[str, Any] | None = None,
    lease_token: str | None = None,
) -> None:
    if target not in RUN_TRANSITIONS.get(run.status, set()):
        raise RuntimeError(f"非法 Run 状态迁移: {run.status} -> {target}")
    previous = run.status
    expected_version = run.state_version
    values: dict[str, Any] = {
        "status": target,
        "state_version": expected_version + 1,
        "updated_at": utc_now(),
    }
    if target in {
        "queued",
        "waiting_approval",
        "paused",
        "completed",
        "failed",
        "rejected",
        "cancelled",
        "rolled_back",
    }:
        values.update(worker_id=None, lease_token=None, lease_expires_at=None, heartbeat_at=None)
    conditions = [
        AgentRun.id == run.id,
        AgentRun.status == previous,
        AgentRun.state_version == expected_version,
    ]
    if lease_token:
        conditions.append(AgentRun.lease_token == lease_token)
    statement = (
        update(AgentRun)
        .where(*conditions)
        .values(**values)
        .returning(AgentRun.id)
        .execution_options(synchronize_session=False)
    )
    changed = (await db.execute(statement)).scalar_one_or_none()
    if not changed:
        raise RuntimeError("Run 状态已被其他执行器修改")
    for key, value in values.items():
        setattr(run, key, value)
    record_event(
        db,
        run_id=run.id,
        event_type="run.transitioned",
        actor=actor,
        detail={"from": previous, "to": target, **(detail or {})},
        safe_summary=f"状态由 {previous} 变为 {target}",
    )


async def transition_step(
    db: AsyncSession,
    step: AgentStep,
    target: str,
    *,
    actor: str,
    detail: dict[str, Any] | None = None,
) -> None:
    if target not in STEP_TRANSITIONS.get(step.status, set()):
        raise RuntimeError(f"非法 Step 状态迁移: {step.status} -> {target}")
    previous = step.status
    expected_version = step.state_version
    statement = (
        update(AgentStep)
        .where(
            AgentStep.id == step.id,
            AgentStep.status == previous,
            AgentStep.state_version == expected_version,
        )
        .values(status=target, state_version=expected_version + 1)
        .returning(AgentStep.id)
        .execution_options(synchronize_session=False)
    )
    changed = (await db.execute(statement)).scalar_one_or_none()
    if not changed:
        raise RuntimeError("Step 状态已被其他执行器修改")
    step.status = target
    step.state_version = expected_version + 1
    record_event(
        db,
        run_id=step.run_id,
        step_id=step.id,
        event_type="step.transitioned",
        actor=actor,
        detail={"from": previous, "to": target, **(detail or {})},
    )


async def claim_run_lease(
    db: AsyncSession, *, user_id: str, run_id: str, worker_id: str, lease_seconds: int = 90
) -> str | None:
    now = utc_now()
    token = str(uuid.uuid4())
    claimed = (
        await db.execute(
            update(AgentRun)
            .where(
                AgentRun.id == run_id,
                AgentRun.user_id == user_id,
                AgentRun.status.in_(["queued", "retrying"]),
                (AgentRun.lease_expires_at.is_(None) | (AgentRun.lease_expires_at < now)),
            )
            .values(
                status="executing",
                worker_id=worker_id,
                lease_token=token,
                lease_expires_at=now + timedelta(seconds=lease_seconds),
                heartbeat_at=now,
                started_at=func.coalesce(AgentRun.started_at, now),
                state_version=AgentRun.state_version + 1,
            )
            .returning(AgentRun.id)
        )
    ).scalar_one_or_none()
    if claimed:
        record_event(
            db,
            run_id=run_id,
            event_type="lease.claimed",
            actor="worker",
            detail={"worker_id": worker_id, "lease_seconds": lease_seconds},
        )
    await db.commit()
    return token if claimed else None


async def renew_run_lease(
    db: AsyncSession, *, run_id: str, lease_token: str, lease_seconds: int = 90
) -> bool:
    now = utc_now()
    renewed = (
        await db.execute(
            update(AgentRun)
            .where(
                AgentRun.id == run_id,
                AgentRun.lease_token == lease_token,
                AgentRun.status == "executing",
                AgentRun.lease_expires_at > now,
            )
            .values(
                heartbeat_at=now,
                lease_expires_at=now + timedelta(seconds=lease_seconds),
                updated_at=now,
            )
            .returning(AgentRun.id)
        )
    ).scalar_one_or_none()
    await db.commit()
    return renewed is not None


async def has_run_lease(db: AsyncSession, *, run_id: str, lease_token: str) -> bool:
    now = utc_now()
    return (
        await db.execute(
            select(AgentRun.id).where(
                AgentRun.id == run_id,
                AgentRun.status == "executing",
                AgentRun.lease_token == lease_token,
                AgentRun.lease_expires_at > now,
            )
        )
    ).scalar_one_or_none() is not None
