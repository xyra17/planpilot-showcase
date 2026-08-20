"""Guarded fixed-allocation online experiments."""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.core.time import utc_now
from src.models import (
    AgentFeedbackEvent,
    AgentInvocation,
    AgentPolicyVersion,
    DecisionProposal,
    Experiment,
    ExperimentAssignment,
    ExperimentExposure,
    ExperimentVariant,
    ModelConfig,
    PromptVersion,
    ProposalFeedback,
)


async def create_experiment(
    db: AsyncSession,
    *,
    created_by: str,
    name: str,
    hypothesis: str,
    allocation_percent: float,
    primary_metric: str,
    variants: list[dict[str, Any]],
) -> dict[str, Any]:
    if not 0 < allocation_percent <= 100:
        raise ValueError("实验流量必须在 0 到 100 之间")
    if len(variants) < 2 or abs(sum(float(row["traffic_weight"]) for row in variants) - 1) > 0.001:
        raise ValueError("实验至少需要两个变体，且权重之和必须为 1")
    if sum(bool(row.get("is_control")) for row in variants) != 1:
        raise ValueError("实验必须且只能有一个对照组")
    for row in variants:
        treatment_config = row.get("treatment_config") or {}
        if any(key not in {"personalization_enabled"} for key in treatment_config):
            raise ValueError("实验 treatment_config 包含不支持的开关")
        if "personalization_enabled" in treatment_config and not isinstance(
            treatment_config["personalization_enabled"], bool
        ):
            raise ValueError("personalization_enabled 必须是布尔值")
        prompt = await db.get(PromptVersion, str(row["prompt_version_id"]))
        model = await db.get(ModelConfig, str(row["model_config_id"]))
        policy = await db.get(AgentPolicyVersion, str(row["policy_version_id"]))
        if not prompt or not model or not policy:
            raise ValueError("实验变体引用的版本不存在")
        if any(item.status != "approved" for item in (prompt, model, policy)):
            raise ValueError("实验只能引用已批准的 Prompt、模型和策略版本")
    experiment = Experiment(
        name=name,
        hypothesis=hypothesis,
        agent_type="coach",
        environment=settings.environment,
        status="draft",
        allocation_percent=allocation_percent,
        primary_metric=primary_metric,
        secondary_metrics=["accept_rate", "helpful_rate"],
        guardrail_metrics={"max_fallback_rate": 0.2, "max_error_rate": 0.1},
        eligibility_rules={"coach_enabled": True},
        minimum_sample_size=20,
        analysis_plan={"assignment": "stable_hmac_v1"},
        created_by=created_by,
    )
    db.add(experiment)
    await db.flush()
    for row in variants:
        db.add(
            ExperimentVariant(
                experiment_id=experiment.id,
                key=str(row["key"]),
                display_name=str(row["display_name"]),
                traffic_weight=float(row["traffic_weight"]),
                prompt_version_id=str(row["prompt_version_id"]),
                model_config_id=str(row["model_config_id"]),
                policy_version_id=str(row["policy_version_id"]),
                is_control=bool(row.get("is_control")),
                treatment_config=treatment_config,
            )
        )
    await db.commit()
    return await get_experiment(db, experiment.id)


async def transition_experiment(
    db: AsyncSession, experiment_id: str, target: str, actor: str
) -> dict[str, Any]:
    experiment = await db.get(Experiment, experiment_id)
    if experiment is None:
        raise LookupError("实验不存在")
    allowed = {
        "draft": {"approved", "cancelled"},
        "approved": {"running", "cancelled"},
        "running": {"paused", "completed", "cancelled"},
        "paused": {"running", "completed", "cancelled"},
    }
    if target not in allowed.get(experiment.status, set()):
        raise ValueError(f"不允许从 {experiment.status} 变更为 {target}")
    if target == "running":
        active = await db.scalar(
            select(Experiment.id).where(
                Experiment.id != experiment.id,
                Experiment.agent_type == experiment.agent_type,
                Experiment.environment == experiment.environment,
                Experiment.status == "running",
            )
        )
        if active is not None:
            raise ValueError("同一环境同一 Agent 同时只能运行一个互斥实验")
    experiment.status = target
    experiment.updated_at = utc_now()
    if target == "approved":
        experiment.approved_by = actor
    if target == "running" and experiment.start_at is None:
        experiment.start_at = utc_now()
    if target in {"completed", "cancelled"}:
        experiment.end_at = utc_now()
    await db.commit()
    return await get_experiment(db, experiment.id)


async def get_experiment(db: AsyncSession, experiment_id: str) -> dict[str, Any]:
    experiment = await db.get(Experiment, experiment_id)
    if experiment is None:
        raise LookupError("实验不存在")
    variants = list(
        (
            await db.execute(
                select(ExperimentVariant).where(ExperimentVariant.experiment_id == experiment_id)
            )
        ).scalars()
    )
    return {
        "id": experiment.id,
        "name": experiment.name,
        "hypothesis": experiment.hypothesis,
        "status": experiment.status,
        "allocation_percent": experiment.allocation_percent,
        "primary_metric": experiment.primary_metric,
        "minimum_sample_size": experiment.minimum_sample_size,
        "variants": [
            {
                "id": row.id,
                "key": row.key,
                "display_name": row.display_name,
                "traffic_weight": row.traffic_weight,
                "is_control": row.is_control,
                "treatment_config": row.treatment_config,
            }
            for row in variants
        ],
    }


async def list_experiments(db: AsyncSession) -> list[dict[str, Any]]:
    ids = list(
        (await db.execute(select(Experiment.id).order_by(Experiment.created_at.desc()))).scalars()
    )
    return [await get_experiment(db, item) for item in ids]


async def experiment_results(db: AsyncSession, experiment_id: str) -> dict[str, Any]:
    experiment = await get_experiment(db, experiment_id)
    variants = experiment["variants"]
    rows = []
    for variant in variants:
        assignments = int(
            await db.scalar(
                select(func.count())
                .select_from(ExperimentAssignment)
                .where(ExperimentAssignment.variant_id == variant["id"])
            )
            or 0
        )
        invocation_ids = (
            select(ExperimentExposure.agent_invocation_id)
            .join(
                ExperimentAssignment,
                ExperimentExposure.assignment_id == ExperimentAssignment.id,
            )
            .where(ExperimentAssignment.variant_id == variant["id"])
        )
        exposures = int(
            await db.scalar(select(func.count()).select_from(invocation_ids.subquery())) or 0
        )
        invocations = list(
            (
                await db.execute(
                    select(AgentInvocation).where(AgentInvocation.id.in_(invocation_ids))
                )
            ).scalars()
        )
        proposal_ids = select(AgentInvocation.proposal_id).where(
            AgentInvocation.id.in_(invocation_ids), AgentInvocation.proposal_id.isnot(None)
        )
        reviewed = int(
            await db.scalar(
                select(func.count())
                .select_from(DecisionProposal)
                .where(
                    DecisionProposal.id.in_(proposal_ids),
                    DecisionProposal.status.in_(["accepted", "applied", "rejected"]),
                )
            )
            or 0
        )
        accepted = int(
            await db.scalar(
                select(func.count())
                .select_from(DecisionProposal)
                .where(
                    DecisionProposal.id.in_(proposal_ids),
                    DecisionProposal.status.in_(["accepted", "applied"]),
                )
            )
            or 0
        )
        feedback = int(
            await db.scalar(
                select(func.count())
                .select_from(ProposalFeedback)
                .where(ProposalFeedback.proposal_id.in_(proposal_ids))
            )
            or 0
        )
        helpful = int(
            await db.scalar(
                select(func.count())
                .select_from(ProposalFeedback)
                .where(
                    ProposalFeedback.proposal_id.in_(proposal_ids),
                    ProposalFeedback.outcome == "helpful",
                )
            )
            or 0
        )
        completion_values = list(
            (
                await db.execute(
                    select(AgentFeedbackEvent.value).where(
                        AgentFeedbackEvent.proposal_id.in_(proposal_ids),
                        AgentFeedbackEvent.feedback_type.startswith("completion_rate_"),
                    )
                )
            ).scalars()
        )
        completion_rates = [
            float(value["completion_rate"])
            for value in completion_values
            if value and value.get("completion_rate") is not None
        ]
        latencies = sorted(row.latency_ms for row in invocations)
        known_costs = [row.estimated_cost for row in invocations if row.estimated_cost is not None]
        rows.append(
            {
                **variant,
                "assignments": assignments,
                "exposures": exposures,
                "accept_rate": round(accepted / reviewed, 4) if reviewed else None,
                "helpful_rate": round(helpful / feedback, 4) if feedback else None,
                "error_rate": (
                    round(sum(not row.success for row in invocations) / len(invocations), 4)
                    if invocations
                    else None
                ),
                "fallback_rate": (
                    round(sum(row.fallback for row in invocations) / len(invocations), 4)
                    if invocations
                    else None
                ),
                "p95_latency_ms": (
                    latencies[min(len(latencies) - 1, round(len(latencies) * 0.95))]
                    if latencies
                    else None
                ),
                "total_tokens": sum(row.total_tokens or 0 for row in invocations),
                "estimated_cost": round(sum(known_costs), 6) if known_costs else None,
                "completion_after_advice": (
                    round(sum(completion_rates) / len(completion_rates), 4)
                    if completion_rates
                    else None
                ),
                "sample_sufficient": exposures >= experiment["minimum_sample_size"],
            }
        )
    control = next((row for row in rows if row["is_control"]), None)
    for row in rows:
        baseline = control.get("completion_after_advice") if control else None
        current = row.get("completion_after_advice")
        row["completion_uplift"] = (
            round(current - baseline, 4) if current is not None and baseline is not None else None
        )
    return {**experiment, "results": rows}
