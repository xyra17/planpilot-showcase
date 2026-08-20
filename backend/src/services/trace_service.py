"""Persist and retrieve privacy-safe Agent execution spans."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import AgentInvocation, AgentTraceSpan, Goal, User


async def persist_invocation_trace(
    db: AsyncSession,
    invocation: AgentInvocation,
    trace: dict[str, Any],
) -> None:
    root_span = uuid.uuid4().hex[:16]
    started = invocation.started_at
    finished = invocation.finished_at
    usage = trace.get("token_usage") or {}
    spans = [
        AgentTraceSpan(
            trace_id=invocation.trace_id,
            span_id=root_span,
            agent_invocation_id=invocation.id,
            user_id=invocation.user_id,
            goal_id=invocation.goal_id,
            name="coach_agent_run",
            span_kind="agent",
            status="ok" if invocation.success else "error",
            started_at=started,
            finished_at=finished,
            latency_ms=invocation.latency_ms,
            input_tokens=usage.get("input_tokens"),
            output_tokens=usage.get("output_tokens"),
            estimated_cost=invocation.estimated_cost,
            attributes={
                "fallback": invocation.fallback,
                "prompt_version_id": invocation.prompt_version_id,
                "model_config_id": invocation.model_config_id,
                "policy_version_id": invocation.policy_version_id,
                "experiment_id": invocation.experiment_id,
                "variant_id": invocation.variant_id,
            },
            error_category=invocation.error_category,
        )
    ]
    cursor = started
    context_span = uuid.uuid4().hex[:16]
    spans.append(
        AgentTraceSpan(
            trace_id=invocation.trace_id,
            span_id=context_span,
            parent_span_id=root_span,
            agent_invocation_id=invocation.id,
            user_id=invocation.user_id,
            goal_id=invocation.goal_id,
            name="retrieve_decision_context",
            span_kind="internal",
            status="ok",
            started_at=cursor,
            finished_at=cursor,
            latency_ms=0,
            attributes={"context_hash": invocation.input_context_hash},
        )
    )
    for attempt in trace.get("gateway_attempts") or []:
        latency = float(attempt.get("latency_ms") or 0)
        attempt_finished = cursor + timedelta(milliseconds=latency)
        spans.append(
            AgentTraceSpan(
                trace_id=invocation.trace_id,
                span_id=uuid.uuid4().hex[:16],
                parent_span_id=root_span,
                agent_invocation_id=invocation.id,
                user_id=invocation.user_id,
                goal_id=invocation.goal_id,
                name="model_call",
                span_kind="client",
                status="ok" if attempt.get("outcome") == "success" else "error",
                started_at=cursor,
                finished_at=attempt_finished,
                latency_ms=latency,
                attributes={
                    "route": attempt.get("route"),
                    "attempt": attempt.get("attempt"),
                    "outcome": attempt.get("outcome"),
                },
                error_category=attempt.get("error_category"),
            )
        )
        cursor = attempt_finished
    for tool_call in trace.get("tool_calls") or []:
        latency = float(tool_call.get("latency_ms") or 0)
        tool_finished = cursor + timedelta(milliseconds=latency)
        spans.append(
            AgentTraceSpan(
                trace_id=invocation.trace_id,
                span_id=uuid.uuid4().hex[:16],
                parent_span_id=root_span,
                agent_invocation_id=invocation.id,
                user_id=invocation.user_id,
                goal_id=invocation.goal_id,
                name="tool_call",
                span_kind="client",
                status="ok" if tool_call.get("success", True) else "error",
                started_at=cursor,
                finished_at=tool_finished,
                latency_ms=latency,
                attributes={"tool_name": tool_call.get("name")},
                error_category=tool_call.get("error_category"),
            )
        )
        cursor = tool_finished
    spans.append(
        AgentTraceSpan(
            trace_id=invocation.trace_id,
            span_id=uuid.uuid4().hex[:16],
            parent_span_id=root_span,
            agent_invocation_id=invocation.id,
            user_id=invocation.user_id,
            goal_id=invocation.goal_id,
            name="create_proposal",
            span_kind="internal",
            status="ok",
            started_at=finished,
            finished_at=finished,
            latency_ms=0,
            attributes={"proposal_type": (invocation.output or {}).get("proposal_type")},
        )
    )
    db.add_all(spans)
    await db.flush()


async def get_trace(
    db: AsyncSession, trace_id: str, *, user_id: str, is_admin: bool
) -> dict[str, Any]:
    invocation = await db.scalar(
        select(AgentInvocation).where(AgentInvocation.trace_id == trace_id)
    )
    if invocation is None or (not is_admin and invocation.user_id != user_id):
        raise LookupError("Agent Trace 不存在")
    owner = await db.get(User, invocation.user_id) if invocation.user_id else None
    goal = await db.get(Goal, invocation.goal_id) if invocation.goal_id else None
    rows = list(
        (
            await db.execute(
                select(AgentTraceSpan)
                .where(AgentTraceSpan.trace_id == trace_id)
                .order_by(AgentTraceSpan.started_at, AgentTraceSpan.created_at)
            )
        ).scalars()
    )
    return {
        "trace_id": trace_id,
        "invocation_id": invocation.id,
        "user_id": invocation.user_id,
        "username": owner.username if owner else None,
        "goal_id": invocation.goal_id,
        "goal_title": goal.title if goal else None,
        "total_latency_ms": invocation.latency_ms,
        "total_tokens": invocation.total_tokens,
        "estimated_cost": invocation.estimated_cost,
        "spans": [
            {
                "span_id": row.span_id,
                "parent_span_id": row.parent_span_id,
                "name": row.name,
                "span_kind": row.span_kind,
                "status": row.status,
                "latency_ms": row.latency_ms,
                "input_tokens": row.input_tokens,
                "output_tokens": row.output_tokens,
                "estimated_cost": row.estimated_cost,
                "attributes": row.attributes,
                "error_category": row.error_category,
                "started_at": row.started_at.isoformat(),
                "finished_at": row.finished_at.isoformat(),
            }
            for row in rows
        ],
    }
