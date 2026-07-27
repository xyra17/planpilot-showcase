from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from src.models import AgentAuditEvent


def record_event(
    db: AsyncSession,
    *,
    run_id: str,
    event_type: str,
    actor: str,
    detail: dict[str, Any] | None = None,
    step_id: str | None = None,
) -> None:
    db.add(
        AgentAuditEvent(
            run_id=run_id,
            step_id=step_id,
            event_type=event_type,
            actor=actor,
            detail=detail or {},
        )
    )
