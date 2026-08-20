from __future__ import annotations

import itertools
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from src.models import AgentAuditEvent

_sqlite_sequence = itertools.count(1)


def record_event(
    db: AsyncSession,
    *,
    run_id: str,
    event_type: str,
    actor: str,
    detail: dict[str, Any] | None = None,
    step_id: str | None = None,
    safe_summary: str | None = None,
) -> None:
    values: dict[str, Any] = {}
    bind = db.get_bind()
    if bind is not None and bind.dialect.name == "sqlite":
        values["sequence"] = next(_sqlite_sequence)
    db.add(
        AgentAuditEvent(
            run_id=run_id,
            step_id=step_id,
            event_type=event_type,
            actor=actor,
            schema_version=1,
            safe_summary=safe_summary,
            detail=detail or {},
            **values,
        )
    )
