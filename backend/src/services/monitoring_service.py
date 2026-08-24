"""Daily Agent metrics, drift summaries, incidents and rollback."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.models import (
    AgentApproval,
    AgentAuditEvent,
    AgentDeployment,
    AgentFeedbackEvent,
    AgentIncident,
    AgentInvocation,
    AgentMetricsDaily,
    AgentRun,
    DecisionProposal,
    InsightActionRun,
    LearningEvent,
    ModelConfig,
)
from src.services.agent_control_service import canonical_hash, ensure_baseline


async def aggregate_daily_metrics(
    db: AsyncSession, metric_date: date | None = None
) -> dict[str, Any]:
    metric_date = metric_date or date.today()
    start = datetime.combine(metric_date, time.min)
    end = start + timedelta(days=1)
    invocations = list(
        (
            await db.execute(
                select(AgentInvocation).where(
                    AgentInvocation.started_at >= start, AgentInvocation.started_at < end
                )
            )
        ).scalars()
    )
    proposals = list(
        (
            await db.execute(
                select(DecisionProposal).where(
                    DecisionProposal.created_at >= start,
                    DecisionProposal.created_at < end,
                    DecisionProposal.proposal_type.notin_({"GOAL_PLAN_CREATE", "CHECKIN_RECORD"}),
                )
            )
        ).scalars()
    )
    feedback = list(
        (
            await db.execute(
                select(AgentFeedbackEvent).where(
                    AgentFeedbackEvent.occurred_at >= start,
                    AgentFeedbackEvent.occurred_at < end,
                )
            )
        ).scalars()
    )
    runs = list(
        (
            await db.execute(
                select(AgentRun).where(AgentRun.created_at >= start, AgentRun.created_at < end)
            )
        ).scalars()
    )
    run_ids = [run.id for run in runs]
    approvals = (
        list(
            (
                await db.execute(select(AgentApproval).where(AgentApproval.run_id.in_(run_ids)))
            ).scalars()
        )
        if run_ids
        else []
    )
    audit_events = (
        list(
            (
                await db.execute(select(AgentAuditEvent).where(AgentAuditEvent.run_id.in_(run_ids)))
            ).scalars()
        )
        if run_ids
        else []
    )
    turn_events = list(
        (
            await db.execute(
                select(LearningEvent).where(
                    LearningEvent.created_at >= start,
                    LearningEvent.created_at < end,
                    LearningEvent.event_type.in_(
                        {"ClarificationRequested", "IntentResolved", "NeedFrameResolved"}
                    ),
                )
            )
        ).scalars()
    )
    proposal_ids = [row.id for row in proposals]
    converted_insight_ids = (
        set(
            (
                await db.execute(
                    select(InsightActionRun.insight_id).where(
                        InsightActionRun.insight_id.in_(proposal_ids)
                    )
                )
            ).scalars()
        )
        if proposal_ids
        else set()
    )
    approved_count = sum(item.status == "approved" for item in approvals)
    rejected_count = sum(item.status == "rejected" for item in approvals)
    approved_run_ids = {item.run_id for item in approvals if item.status == "approved"}
    completed_count = sum(
        run.id in approved_run_ids and run.status in {"completed", "rolled_back"} for run in runs
    )
    successful_count = sum(run.id in approved_run_ids and run.status == "completed" for run in runs)
    rolled_back_count = sum(
        run.id in approved_run_ids and run.status == "rolled_back" for run in runs
    )
    edited_run_ids = {
        event.run_id for event in audit_events if event.event_type == "approval.edited"
    }
    clarified_count = sum(event.event_type == "ClarificationRequested" for event in turn_events)
    preview_latencies = sorted(
        (run.preview_ready_at - run.input_received_at).total_seconds() * 1000
        for run in runs
        if run.preview_ready_at and run.input_received_at
    )
    explicit_feedback = [row for row in feedback if row.feedback_type == "proposal_feedback"]
    helpful_events = sum((row.value or {}).get("outcome") == "helpful" for row in explicit_feedback)
    delayed_completion = [
        float(row.value["completion_rate"])
        for row in feedback
        if row.feedback_type.startswith("completion_rate_")
        and (row.value or {}).get("completion_rate") is not None
    ]
    latencies = sorted(row.latency_ms for row in invocations)
    success_rate = (
        sum(row.success for row in invocations) / len(invocations) if invocations else None
    )
    fallback_rate = (
        sum(row.fallback for row in invocations) / len(invocations) if invocations else None
    )
    metrics = {
        "invocation_count": len(invocations),
        "success_rate": round(success_rate, 4) if success_rate is not None else None,
        "fallback_rate": round(fallback_rate, 4) if fallback_rate is not None else None,
        "proposal_count": len(proposals),
        "insight_to_action_rate": (
            round(len(converted_insight_ids) / len(proposals), 4) if proposals else None
        ),
        "action_approval_rate": (
            round(approved_count / (approved_count + rejected_count), 4)
            if approved_count + rejected_count
            else None
        ),
        "changeset_edit_rate": (
            round(len(edited_run_ids) / len(approvals), 4) if approvals else None
        ),
        "execution_success_rate": (
            round(successful_count / approved_count, 4) if approved_count else None
        ),
        "undo_rate": (round(rolled_back_count / completed_count, 4) if completed_count else None),
        "clarification_rate": (
            round(clarified_count / len(turn_events), 4) if turn_events else None
        ),
        "input_to_preview_p50_ms": (
            round(preview_latencies[len(preview_latencies) // 2], 1) if preview_latencies else None
        ),
        "input_to_preview_p95_ms": (
            round(
                preview_latencies[
                    min(len(preview_latencies) - 1, round(len(preview_latencies) * 0.95))
                ],
                1,
            )
            if preview_latencies
            else None
        ),
        "accept_rate": (
            round(approved_count / (approved_count + rejected_count), 4)
            if approved_count + rejected_count
            else None
        ),
        "apply_rate": (round(successful_count / approved_count, 4) if approved_count else None),
        "helpful_rate": (
            round(helpful_events / len(explicit_feedback), 4) if explicit_feedback else None
        ),
        "completion_after_advice": (
            round(sum(delayed_completion) / len(delayed_completion), 4)
            if delayed_completion
            else None
        ),
        "feedback_event_count": len(feedback),
        "context_novelty_rate": (
            round(len({row.input_context_hash for row in invocations}) / len(invocations), 4)
            if invocations
            else None
        ),
        "avg_latency_ms": round(sum(latencies) / len(latencies), 1) if latencies else None,
        "p95_latency_ms": latencies[min(len(latencies) - 1, round(len(latencies) * 0.95))]
        if latencies
        else None,
        "total_tokens": sum(row.total_tokens or 0 for row in invocations),
    }
    health = "healthy"
    if invocations and (success_rate or 0) < 0.7:
        health = "critical"
    elif invocations and ((success_rate or 0) < 0.9 or (fallback_rate or 0) > 0.2):
        health = "warning"
    dimension_key = canonical_hash({"agent_type": "coach", "segment": "all"})
    row = await db.scalar(
        select(AgentMetricsDaily).where(
            AgentMetricsDaily.metric_date == metric_date.isoformat(),
            AgentMetricsDaily.agent_type == "coach",
            AgentMetricsDaily.dimension_key == dimension_key,
            AgentMetricsDaily.metric_version == "v2",
        )
    )
    if row is None:
        row = AgentMetricsDaily(
            metric_date=metric_date.isoformat(),
            agent_type="coach",
            segment_key="all",
            dimension_key=dimension_key,
            metric_version="v2",
        )
        db.add(row)
    row.metrics = metrics
    row.health_status = health
    row.updated_at = utc_now()
    version_groups: dict[tuple[str | None, ...], list[AgentInvocation]] = {}
    for invocation in invocations:
        key = (
            invocation.prompt_version_id,
            invocation.model_config_id,
            invocation.policy_version_id,
            invocation.experiment_id,
            invocation.variant_id,
        )
        version_groups.setdefault(key, []).append(invocation)
    for dimensions, group in version_groups.items():
        prompt_id, model_id, policy_id, experiment_id, variant_id = dimensions
        dimension = {
            "prompt_version_id": prompt_id,
            "model_config_id": model_id,
            "policy_version_id": policy_id,
            "experiment_id": experiment_id,
            "variant_id": variant_id,
            "segment": "version",
        }
        version_key = canonical_hash(dimension)
        version_row = await db.scalar(
            select(AgentMetricsDaily).where(
                AgentMetricsDaily.metric_date == metric_date.isoformat(),
                AgentMetricsDaily.agent_type == "coach",
                AgentMetricsDaily.dimension_key == version_key,
                AgentMetricsDaily.metric_version == "v1",
            )
        )
        if version_row is None:
            version_row = AgentMetricsDaily(
                metric_date=metric_date.isoformat(),
                agent_type="coach",
                prompt_version_id=prompt_id,
                model_config_id=model_id,
                policy_version_id=policy_id,
                experiment_id=experiment_id,
                variant_id=variant_id,
                segment_key="version",
                dimension_key=version_key,
                metric_version="v1",
            )
            db.add(version_row)
        group_latency = sorted(item.latency_ms for item in group)
        version_row.metrics = {
            "invocation_count": len(group),
            "success_rate": round(sum(item.success for item in group) / len(group), 4),
            "fallback_rate": round(sum(item.fallback for item in group) / len(group), 4),
            "avg_latency_ms": round(sum(group_latency) / len(group_latency), 1),
            "total_tokens": sum(item.total_tokens or 0 for item in group),
        }
        version_row.health_status = health
        version_row.updated_at = utc_now()
    if health == "critical":
        existing = await db.scalar(
            select(AgentIncident).where(
                AgentIncident.agent_type == "coach",
                AgentIncident.status.in_(["open", "mitigating"]),
                AgentIncident.action_taken.is_(None),
            )
        )
        if existing is None:
            runtime = await ensure_baseline(db)
            db.add(
                AgentIncident(
                    severity="critical",
                    agent_type="coach",
                    deployment_id=runtime.deployment.id,
                    trigger_metric={"metric": "success_rate", "value": success_rate},
                    evidence_snapshot=metrics,
                    status="open",
                )
            )
    await db.commit()
    return {"date": metric_date.isoformat(), "health_status": health, "metrics": metrics}


async def monitoring_overview(db: AsyncSession) -> dict[str, Any]:
    rows = list(
        (
            await db.execute(
                select(AgentMetricsDaily)
                .order_by(AgentMetricsDaily.metric_date.desc())
                .limit(14)
                .where(
                    AgentMetricsDaily.segment_key == "all",
                    AgentMetricsDaily.prompt_version_id.is_(None),
                )
            )
        ).scalars()
    )
    incidents = list(
        (
            await db.execute(
                select(AgentIncident)
                .where(AgentIncident.status.in_(["open", "mitigating"]))
                .order_by(AgentIncident.created_at.desc())
            )
        ).scalars()
    )
    drift: dict[str, Any] = {
        "status": "insufficient_data",
        "success_rate_delta": None,
        "data_drift": {"status": "insufficient_data", "context_novelty_delta": None},
        "concept_drift": {"status": "insufficient_data", "accept_rate_delta": None},
        "operational_drift": {"status": "insufficient_data", "fallback_rate_delta": None},
    }
    if len(rows) >= 2:
        current = rows[0].metrics.get("success_rate")
        previous = rows[1].metrics.get("success_rate")
        if current is not None and previous is not None:
            delta = round(current - previous, 4)
            drift["status"] = "warning" if delta <= -0.1 else "stable"
            drift["success_rate_delta"] = delta
        novelty_current = rows[0].metrics.get("context_novelty_rate")
        novelty_previous = rows[1].metrics.get("context_novelty_rate")
        if novelty_current is not None and novelty_previous is not None:
            delta = round(novelty_current - novelty_previous, 4)
            drift["data_drift"] = {
                "status": "warning" if abs(delta) >= 0.25 else "stable",
                "context_novelty_delta": delta,
            }
        accept_current = rows[0].metrics.get("accept_rate")
        accept_previous = rows[1].metrics.get("accept_rate")
        if accept_current is not None and accept_previous is not None:
            delta = round(accept_current - accept_previous, 4)
            drift["concept_drift"] = {
                "status": "warning" if delta <= -0.1 else "stable",
                "accept_rate_delta": delta,
            }
        fallback_current = rows[0].metrics.get("fallback_rate")
        fallback_previous = rows[1].metrics.get("fallback_rate")
        if fallback_current is not None and fallback_previous is not None:
            delta = round(fallback_current - fallback_previous, 4)
            drift["operational_drift"] = {
                "status": "warning" if delta >= 0.1 else "stable",
                "fallback_rate_delta": delta,
            }
    return {
        "current": (
            {
                "date": rows[0].metric_date,
                "health_status": rows[0].health_status,
                "metrics": rows[0].metrics,
            }
            if rows
            else None
        ),
        "history": [
            {"date": row.metric_date, "health_status": row.health_status, "metrics": row.metrics}
            for row in rows
        ],
        "drift": drift,
        "open_incidents": [
            {
                "id": row.id,
                "severity": row.severity,
                "status": row.status,
                "trigger_metric": row.trigger_metric,
                "created_at": row.created_at.isoformat(),
            }
            for row in incidents
        ],
    }


async def rollback_deployment(
    db: AsyncSession, *, target_deployment_id: str, actor: str, reason: str
) -> dict[str, Any]:
    target = await db.get(AgentDeployment, target_deployment_id)
    if target is None:
        raise LookupError("目标版本不存在")
    target_model = await db.get(ModelConfig, target.model_config_id)
    if target_model is None or target_model.provider not in {"local", "smart"}:
        raise ValueError("目标修订使用已退役模型路由，仅供历史审计，不能回滚为生产版本")
    current = await db.scalar(
        select(AgentDeployment).where(
            AgentDeployment.agent_type == target.agent_type,
            AgentDeployment.environment == target.environment,
            AgentDeployment.status == "active",
        )
    )
    revision = (current.revision if current else target.revision) + 1
    if current:
        current.status = "rolled_back"
    rollback = AgentDeployment(
        agent_type=target.agent_type,
        environment=target.environment,
        prompt_version_id=target.prompt_version_id,
        model_config_id=target.model_config_id,
        policy_version_id=target.policy_version_id,
        status="active",
        revision=revision,
        deployed_by=actor,
        rollback_of_id=current.id if current else None,
        deployed_at=utc_now(),
    )
    db.add(rollback)
    await db.flush()
    db.add(
        AgentIncident(
            severity="warning",
            agent_type=target.agent_type,
            deployment_id=current.id if current else None,
            trigger_metric={"reason": reason},
            evidence_snapshot={},
            status="resolved",
            action_taken="rollback",
            rollback_deployment_id=rollback.id,
            resolution_note=reason,
            resolved_at=utc_now(),
            resolved_by=actor,
        )
    )
    await db.commit()
    return {"deployment_id": rollback.id, "revision": revision, "status": "active"}
