"""Offline-gated Coach canary lifecycle built on the Phase 5 experiment platform."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.core.time import utc_now
from src.models import (
    AgentIncident,
    AgentPolicyVersion,
    CanaryRelease,
    CanaryStageTransition,
    Experiment,
    ModelConfig,
    OfflineEvaluationGate,
    PromptVersion,
)
from src.services import agent_control_service, experiment_service, monitoring_service

STAGES = ("internal", "1", "5", "20", "50", "100")
STAGE_TRAFFIC = {"internal": 0.0, "1": 1.0, "5": 5.0, "20": 20.0, "50": 50.0, "100": 100.0}
STAGE_MIN_EXPOSURES = {"internal": 1, "1": 20, "5": 50, "20": 100, "50": 200, "100": 0}
DEFAULT_GUARDRAILS = {
    "max_error_rate": 0.05,
    "auto_pause_error_rate": 0.10,
    "max_fallback_rate": 0.20,
    "max_p95_latency_ms": 60000,
    "critical_safety_incidents": 0,
}


async def create_coach_canary(
    db: AsyncSession,
    *,
    actor: str,
    name: str,
    hypothesis: str,
    offline_gate_id: str,
    prompt_version_id: str,
    model_config_id: str,
    policy_version_id: str,
) -> dict[str, Any]:
    gate = await db.get(OfflineEvaluationGate, offline_gate_id)
    if gate is None or gate.status != "passed":
        raise ValueError("只能使用已通过的生产离线门禁")
    active = await db.scalar(
        select(CanaryRelease).where(
            CanaryRelease.agent_type == "coach",
            CanaryRelease.environment == settings.environment,
            CanaryRelease.status.in_(["running", "paused"]),
        )
    )
    if active is not None:
        raise ValueError("当前环境已有未结束的 Coach Canary")
    runtime = await agent_control_service.ensure_baseline(db)
    prompt = await db.get(PromptVersion, prompt_version_id)
    model = await db.get(ModelConfig, model_config_id)
    policy = await db.get(AgentPolicyVersion, policy_version_id)
    if not prompt or not model or not policy:
        raise ValueError("Canary 候选版本不完整")
    if any(row.status != "approved" for row in (prompt, model, policy)):
        raise ValueError("Canary 只允许已批准版本")
    experiment = await experiment_service.create_experiment(
        db,
        created_by=actor,
        name=name,
        hypothesis=hypothesis,
        allocation_percent=100.0,
        primary_metric="completion_uplift",
        variants=[
            {
                "key": "control",
                "display_name": "当前生产策略",
                "traffic_weight": 0.5,
                "prompt_version_id": runtime.prompt.id,
                "model_config_id": runtime.model.id,
                "policy_version_id": runtime.policy.id,
                "is_control": True,
            },
            {
                "key": "candidate",
                "display_name": "Canary 候选策略",
                "traffic_weight": 0.5,
                "prompt_version_id": prompt.id,
                "model_config_id": model.id,
                "policy_version_id": policy.id,
                "is_control": False,
            },
        ],
    )
    await experiment_service.transition_experiment(db, experiment["id"], "approved", actor)
    await experiment_service.transition_experiment(db, experiment["id"], "running", actor)
    experiment_row = await db.get(Experiment, experiment["id"])
    experiment_row.eligibility_rules = {
        "coach_enabled": True,
        "internal_only": True,
        "release_type": "canary",
    }
    release = CanaryRelease(
        experiment_id=experiment["id"],
        offline_gate_id=gate.id,
        baseline_deployment_id=runtime.deployment.id,
        agent_type="coach",
        environment=settings.environment,
        status="running",
        current_stage="internal",
        traffic_percent=0.0,
        guardrails=DEFAULT_GUARDRAILS,
        created_by=actor,
        started_at=utc_now(),
    )
    db.add(release)
    await db.flush()
    db.add(
        CanaryStageTransition(
            canary_release_id=release.id,
            from_stage=None,
            to_stage="internal",
            action="started",
            reason="离线门禁通过，进入内部流量验证",
            metrics_snapshot=gate.metrics_snapshot,
            actor=actor,
            occurred_at=utc_now(),
        )
    )
    await db.commit()
    return await get_canary(db, release.id)


async def _release_metrics(db: AsyncSession, release: CanaryRelease) -> dict[str, Any]:
    results = await experiment_service.experiment_results(db, release.experiment_id)
    variants = results["results"]
    candidate = next((row for row in variants if not row["is_control"]), None)
    exposures = sum(int(row["exposures"]) for row in variants)
    critical_incidents = len(
        list(
            (
                await db.execute(
                    select(AgentIncident.id).where(
                        AgentIncident.experiment_id == release.experiment_id,
                        AgentIncident.severity == "critical",
                        AgentIncident.status.in_(["open", "mitigating"]),
                    )
                )
            ).scalars()
        )
    )
    return {
        "exposures": exposures,
        "acceptance_rate": candidate.get("accept_rate") if candidate else None,
        "completion_uplift": candidate.get("completion_uplift") if candidate else None,
        "error_rate": candidate.get("error_rate") if candidate else None,
        "fallback_rate": candidate.get("fallback_rate") if candidate else None,
        "p95_latency_ms": candidate.get("p95_latency_ms") if candidate else None,
        "total_tokens": sum(int(row.get("total_tokens") or 0) for row in variants),
        "estimated_cost": (
            round(
                sum(
                    float(row["estimated_cost"])
                    for row in variants
                    if row["estimated_cost"] is not None
                ),
                6,
            )
            if any(row["estimated_cost"] is not None for row in variants)
            else None
        ),
        "critical_safety_incidents": critical_incidents,
        "variants": variants,
    }


def _guardrail_failures(release: CanaryRelease, metrics: dict[str, Any]) -> list[str]:
    guardrails = release.guardrails or DEFAULT_GUARDRAILS
    failures = []
    if metrics["critical_safety_incidents"] > guardrails["critical_safety_incidents"]:
        failures.append("critical_safety_incident")
    for key, limit in (
        ("error_rate", guardrails["max_error_rate"]),
        ("fallback_rate", guardrails["max_fallback_rate"]),
        ("p95_latency_ms", guardrails["max_p95_latency_ms"]),
    ):
        value = metrics.get(key)
        if value is not None and value > limit:
            failures.append(key)
    minimum = STAGE_MIN_EXPOSURES[release.current_stage]
    if release.current_stage != "100" and metrics["exposures"] < minimum:
        failures.append("minimum_exposures")
    return failures


async def advance_canary(db: AsyncSession, release_id: str, actor: str) -> dict[str, Any]:
    release = await db.get(CanaryRelease, release_id)
    if release is None:
        raise LookupError("Canary 不存在")
    if release.status != "running":
        raise ValueError("只有运行中的 Canary 可以升阶")
    gate = await db.get(OfflineEvaluationGate, release.offline_gate_id)
    if gate is None or gate.status != "passed":
        raise ValueError("离线门禁已失效")
    index = STAGES.index(release.current_stage)
    if index == len(STAGES) - 1:
        raise ValueError("Canary 已在 100% 阶段")
    metrics = await _release_metrics(db, release)
    failures = _guardrail_failures(release, metrics)
    if failures:
        raise ValueError("当前阶段不满足升阶条件：" + ", ".join(failures))
    target = STAGES[index + 1]
    previous = release.current_stage
    release.current_stage = target
    release.traffic_percent = STAGE_TRAFFIC[target]
    release.updated_at = utc_now()
    experiment = await db.get(Experiment, release.experiment_id)
    experiment.allocation_percent = STAGE_TRAFFIC[target]
    experiment.eligibility_rules = {
        **(experiment.eligibility_rules or {}),
        "internal_only": False,
    }
    db.add(
        CanaryStageTransition(
            canary_release_id=release.id,
            from_stage=previous,
            to_stage=target,
            action="advanced",
            reason="阶段指标和安全栏均通过",
            metrics_snapshot=metrics,
            actor=actor,
            occurred_at=utc_now(),
        )
    )
    await db.commit()
    return await get_canary(db, release.id)


async def pause_canary(
    db: AsyncSession, release_id: str, actor: str, reason: str
) -> dict[str, Any]:
    release = await db.get(CanaryRelease, release_id)
    if release is None:
        raise LookupError("Canary 不存在")
    if release.status != "running":
        raise ValueError("只有运行中的 Canary 可暂停")
    metrics = await _release_metrics(db, release)
    await experiment_service.transition_experiment(db, release.experiment_id, "paused", actor)
    release.status = "paused"
    db.add(
        CanaryStageTransition(
            canary_release_id=release.id,
            from_stage=release.current_stage,
            to_stage=release.current_stage,
            action="paused",
            reason=reason,
            metrics_snapshot=metrics,
            actor=actor,
            occurred_at=utc_now(),
        )
    )
    await db.commit()
    return await get_canary(db, release.id)


async def resume_canary(db: AsyncSession, release_id: str, actor: str) -> dict[str, Any]:
    """Resume a paused release at its current stage after a guardrail review."""
    release = await db.get(CanaryRelease, release_id)
    if release is None:
        raise LookupError("Canary 不存在")
    if release.status != "paused":
        raise ValueError("只有已暂停的 Canary 可以继续放量")
    gate = await db.get(OfflineEvaluationGate, release.offline_gate_id)
    if gate is None or gate.status != "passed":
        raise ValueError("离线门禁已失效，不能继续放量")

    metrics = await _release_metrics(db, release)
    safety_failures = [
        failure
        for failure in _guardrail_failures(release, metrics)
        if failure != "minimum_exposures"
    ]
    if safety_failures:
        raise ValueError("当前指标仍触发安全护栏：" + ", ".join(safety_failures))

    await experiment_service.transition_experiment(db, release.experiment_id, "running", actor)
    release.status = "running"
    release.updated_at = utc_now()
    db.add(
        CanaryStageTransition(
            canary_release_id=release.id,
            from_stage=release.current_stage,
            to_stage=release.current_stage,
            action="resumed",
            reason="管理员确认指标后继续放量",
            metrics_snapshot=metrics,
            actor=actor,
            occurred_at=utc_now(),
        )
    )
    await db.commit()
    return await get_canary(db, release.id)


async def rollback_canary(
    db: AsyncSession, release_id: str, actor: str, reason: str
) -> dict[str, Any]:
    release = await db.get(CanaryRelease, release_id)
    if release is None:
        raise LookupError("Canary 不存在")
    if release.status not in {"running", "paused"}:
        raise ValueError("当前 Canary 不可回滚")
    metrics = await _release_metrics(db, release)
    experiment = await db.get(Experiment, release.experiment_id)
    if experiment.status in {"running", "paused"}:
        await experiment_service.transition_experiment(db, experiment.id, "cancelled", actor)
    rollback = await monitoring_service.rollback_deployment(
        db,
        target_deployment_id=release.baseline_deployment_id,
        actor=actor,
        reason=reason,
    )
    release.status = "rolled_back"
    release.completed_at = utc_now()
    db.add(
        CanaryStageTransition(
            canary_release_id=release.id,
            from_stage=release.current_stage,
            to_stage=release.current_stage,
            action="rolled_back",
            reason=reason,
            metrics_snapshot={**metrics, "rollback": rollback},
            actor=actor,
            occurred_at=utc_now(),
        )
    )
    await db.commit()
    return await get_canary(db, release.id)


async def get_canary(db: AsyncSession, release_id: str) -> dict[str, Any]:
    release = await db.get(CanaryRelease, release_id)
    if release is None:
        raise LookupError("Canary 不存在")
    metrics = await _release_metrics(db, release)
    failures = _guardrail_failures(release, metrics) if release.status == "running" else []
    transitions = list(
        (
            await db.execute(
                select(CanaryStageTransition)
                .where(CanaryStageTransition.canary_release_id == release.id)
                .order_by(CanaryStageTransition.occurred_at.desc())
            )
        ).scalars()
    )
    from src.services.canary_observation_service import observation_summary

    observations = await observation_summary(db, release.id)
    return {
        "id": release.id,
        "experiment_id": release.experiment_id,
        "offline_gate_id": release.offline_gate_id,
        "baseline_deployment_id": release.baseline_deployment_id,
        "status": release.status,
        "current_stage": release.current_stage,
        "traffic_percent": release.traffic_percent,
        "stages": list(STAGES),
        "guardrails": release.guardrails,
        "metrics": metrics,
        "observations": observations,
        "advance_ready": release.status == "running"
        and not failures
        and release.current_stage != "100",
        "advance_blockers": failures,
        "transitions": [
            {
                "id": row.id,
                "from_stage": row.from_stage,
                "to_stage": row.to_stage,
                "action": row.action,
                "reason": row.reason,
                "metrics_snapshot": row.metrics_snapshot,
                "actor": row.actor,
                "occurred_at": row.occurred_at.isoformat(),
            }
            for row in transitions
        ],
    }


async def canary_overview(db: AsyncSession) -> dict[str, Any] | None:
    release = await db.scalar(select(CanaryRelease).order_by(CanaryRelease.created_at.desc()))
    return await get_canary(db, release.id) if release is not None else None
