"""Immutable Agent version registry, runtime resolution and invocation facts."""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.core.llm_router import MODEL_ROLE_CONTRACTS
from src.core.time import utc_now
from src.models import (
    AgentDeployment,
    AgentInvocation,
    AgentPolicyVersion,
    DecisionProposal,
    Experiment,
    ExperimentAssignment,
    ExperimentExposure,
    ExperimentVariant,
    Goal,
    ModelConfig,
    PromptVersion,
    ProposalFeedback,
    User,
)
from src.services.privacy_service import experiments_allowed

COACH_TEMPLATE = (
    "你是 PlanPilot 学习伙伴。只根据提供的行为证据解释建议，"
    "不得编造数据，不得声称已经修改计划。只输出一个 JSON 对象，字段为 "
    "proposal_type、title、summary、reasoning。proposal_type 必须严格等于 "
    "{expected_type}；reasoning 为 1 到 5 条简短中文理由。"
)
BASELINE_RULES = {
    "allowed_proposal_types": [
        "reschedule_overdue_tasks",
        "reduce_daily_load",
        "learning_nudge",
        "PLAN_ADJUSTMENT",
        "TASK_SPLIT",
        "DIFFICULTY_ADJUST",
        "REVIEW_INSERTION",
    ],
    "require_user_confirmation": True,
    "max_tasks_per_day": 5,
}


def canonical_hash(value: Any) -> str:
    rendered = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str
    )
    return hashlib.sha256(rendered.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ResolvedRuntime:
    deployment: AgentDeployment
    prompt: PromptVersion
    model: ModelConfig
    policy: AgentPolicyVersion
    experiment: Experiment | None = None
    variant: ExperimentVariant | None = None
    assignment: ExperimentAssignment | None = None


async def ensure_baseline(db: AsyncSession, *, environment: str | None = None) -> ResolvedRuntime:
    environment = environment or settings.environment
    prompt = await db.scalar(
        select(PromptVersion).where(
            PromptVersion.agent_type == "coach",
            PromptVersion.name == "daily_coach_prompt",
            PromptVersion.version == "coach-v2",
        )
    )
    if prompt is None:
        prompt = PromptVersion(
            agent_type="coach",
            name="daily_coach_prompt",
            version="coach-v2",
            template=COACH_TEMPLATE,
            variables_schema={"type": "object", "additionalProperties": False},
            output_schema={"required": ["proposal_type", "title", "summary", "reasoning"]},
            content_hash=canonical_hash({"template": COACH_TEMPLATE}),
            status="approved",
            change_note="学习伙伴产品称呼基线；行为与安全边界不变",
            created_by="system",
        )
        db.add(prompt)
        await db.flush()
    model = await db.scalar(
        select(ModelConfig).where(
            ModelConfig.name == "coach-structured",
            ModelConfig.version == "v2",
        )
    )
    if model is None:
        model = ModelConfig(
            name="coach-structured",
            version="v2",
            provider="smart",
            model_name=settings.smart_model_name or "structured-unavailable",
            temperature=0.2,
            max_tokens=700,
            timeout_ms=round(settings.cloud_routine_timeout_seconds * 1000),
            retry_policy={"max_retries": settings.cloud_model_max_retries},
            credential_alias="runtime-default",
            status="approved",
            created_by="system",
        )
        db.add(model)
        await db.flush()
    policy = await db.scalar(
        select(AgentPolicyVersion).where(
            AgentPolicyVersion.agent_type == "coach",
            AgentPolicyVersion.name == "coach-safety-policy",
            AgentPolicyVersion.version == "v1",
        )
    )
    if policy is None:
        policy = AgentPolicyVersion(
            agent_type="coach",
            name="coach-safety-policy",
            version="v1",
            rules=BASELINE_RULES,
            content_hash=canonical_hash(BASELINE_RULES),
            status="approved",
            change_note="Proposal/Review/Apply 安全基线",
            created_by="system",
            approved_by="system",
            approved_at=utc_now(),
        )
        db.add(policy)
        await db.flush()
    deployment = await db.scalar(
        select(AgentDeployment).where(
            AgentDeployment.agent_type == "coach",
            AgentDeployment.environment == environment,
            AgentDeployment.status == "active",
        )
    )
    if deployment is not None and deployment.model_config_id != model.id:
        deployed_model = await db.get(ModelConfig, deployment.model_config_id)
        is_legacy_router = bool(
            deployed_model
            and deployed_model.name == "coach-routine"
            and deployed_model.version == "v1"
            and deployed_model.provider == "configured-router"
        )
        if is_legacy_router:
            deployment.status = "superseded"
            await db.flush()
            deployment = AgentDeployment(
                agent_type="coach",
                environment=environment,
                prompt_version_id=prompt.id,
                model_config_id=model.id,
                policy_version_id=policy.id,
                status="active",
                revision=deployment.revision + 1,
                deployed_by="system:model-role-migration",
                deployed_at=utc_now(),
            )
            db.add(deployment)
            await db.flush()
    if deployment is None:
        deployment = AgentDeployment(
            agent_type="coach",
            environment=environment,
            prompt_version_id=prompt.id,
            model_config_id=model.id,
            policy_version_id=policy.id,
            status="active",
            revision=1,
            deployed_by="system",
            deployed_at=utc_now(),
        )
        db.add(deployment)
        await db.flush()
    return ResolvedRuntime(deployment=deployment, prompt=prompt, model=model, policy=policy)


async def resolve_runtime(
    db: AsyncSession,
    *,
    user_id: str,
    agent_type: str = "coach",
    environment: str | None = None,
) -> ResolvedRuntime:
    environment = environment or settings.environment
    baseline = await ensure_baseline(db, environment=environment)
    now = utc_now()
    experiment = await db.scalar(
        select(Experiment)
        .where(
            Experiment.agent_type == agent_type,
            Experiment.environment == environment,
            Experiment.status == "running",
            (Experiment.start_at.is_(None) | (Experiment.start_at <= now)),
            (Experiment.end_at.is_(None) | (Experiment.end_at > now)),
        )
        .order_by(Experiment.created_at)
    )
    if experiment is None:
        return baseline
    eligibility = experiment.eligibility_rules or {}
    if eligibility.get("internal_only"):
        is_internal = bool(await db.scalar(select(User.is_admin).where(User.id == user_id)))
        if not is_internal:
            return baseline
    elif not await experiments_allowed(db, user_id):
        return baseline
    bucket = (
        int(
            hmac.new(
                settings.secret_key.encode(),
                f"{experiment.id}:{user_id}".encode(),
                hashlib.sha256,
            ).hexdigest()[:8],
            16,
        )
        % 10000
    )
    if bucket >= round(experiment.allocation_percent * 100):
        return baseline
    assignment = await db.scalar(
        select(ExperimentAssignment).where(
            ExperimentAssignment.experiment_id == experiment.id,
            ExperimentAssignment.user_id == user_id,
        )
    )
    variants = list(
        (
            await db.execute(
                select(ExperimentVariant)
                .where(ExperimentVariant.experiment_id == experiment.id)
                .order_by(ExperimentVariant.key)
            )
        ).scalars()
    )
    if not variants:
        return baseline
    if assignment is None:
        point = (bucket % 10000) / 10000
        cumulative = 0.0
        selected = variants[-1]
        for item in variants:
            cumulative += item.traffic_weight
            if point < cumulative:
                selected = item
                break
        assignment = ExperimentAssignment(
            experiment_id=experiment.id,
            user_id=user_id,
            variant_id=selected.id,
            bucket=bucket,
            assignment_version="v1",
            eligibility_snapshot={
                "eligible": True,
                "internal_only": bool(eligibility.get("internal_only")),
                "experiments_consent": True,
            },
            assigned_at=now,
        )
        db.add(assignment)
        await db.flush()
    else:
        selected = next((row for row in variants if row.id == assignment.variant_id), variants[0])
    prompt = await db.get(PromptVersion, selected.prompt_version_id)
    model = await db.get(ModelConfig, selected.model_config_id)
    policy = await db.get(AgentPolicyVersion, selected.policy_version_id)
    if (
        not prompt
        or not model
        or not policy
        or any(row.status != "approved" for row in (prompt, model, policy))
    ):
        return baseline
    return ResolvedRuntime(
        deployment=baseline.deployment,
        prompt=prompt,
        model=model,
        policy=policy,
        experiment=experiment,
        variant=selected,
        assignment=assignment,
    )


async def record_invocation(
    db: AsyncSession,
    *,
    runtime: ResolvedRuntime,
    user_id: str,
    goal_id: str | None,
    context: dict[str, Any],
    output: dict[str, Any],
    trace: dict[str, Any],
) -> AgentInvocation:
    finished = utc_now()
    latency = int(float(trace.get("latency_ms") or 0))
    usage = trace.get("token_usage") or {}
    invocation = AgentInvocation(
        user_id=user_id,
        goal_id=goal_id,
        agent_type="coach",
        prompt_version_id=runtime.prompt.id,
        model_config_id=runtime.model.id,
        policy_version_id=runtime.policy.id,
        experiment_id=runtime.experiment.id if runtime.experiment else None,
        variant_id=runtime.variant.id if runtime.variant else None,
        input_context_hash=canonical_hash(context),
        prompt_render_hash=trace.get("prompt_render_hash"),
        output=output,
        latency_ms=latency,
        input_tokens=usage.get("input_tokens"),
        output_tokens=usage.get("output_tokens"),
        total_tokens=usage.get("total_tokens"),
        success=bool(trace.get("success", not bool(trace.get("fallback")))),
        fallback=bool(trace.get("fallback")),
        error_category=trace.get("fallback_reason"),
        trace_id=str(trace["trace_id"]),
        started_at=finished - timedelta(milliseconds=latency),
        finished_at=finished,
    )
    db.add(invocation)
    await db.flush()
    if runtime.assignment is not None:
        db.add(
            ExperimentExposure(
                assignment_id=runtime.assignment.id,
                agent_invocation_id=invocation.id,
                context_hash=invocation.input_context_hash,
                exposed_at=finished,
            )
        )
    from src.services.trace_service import persist_invocation_trace

    await persist_invocation_trace(db, invocation, trace)
    return invocation


async def runtime_overview(db: AsyncSession, user_id: str) -> dict[str, Any]:
    runtime = await ensure_baseline(db)
    # Read endpoints also bootstrap the immutable baseline once. Persist it here;
    # proposal generation keeps the same records in its own transaction instead.
    await db.commit()
    invocations = int(
        await db.scalar(
            select(func.count())
            .select_from(AgentInvocation)
            .where(AgentInvocation.user_id == user_id)
        )
        or 0
    )
    success = int(
        await db.scalar(
            select(func.count())
            .select_from(AgentInvocation)
            .where(AgentInvocation.user_id == user_id, AgentInvocation.success.is_(True))
        )
        or 0
    )
    proposals = int(
        await db.scalar(
            select(func.count())
            .select_from(DecisionProposal)
            .where(DecisionProposal.user_id == user_id)
        )
        or 0
    )
    helpful = int(
        await db.scalar(
            select(func.count())
            .select_from(ProposalFeedback)
            .where(ProposalFeedback.user_id == user_id, ProposalFeedback.outcome == "helpful")
        )
        or 0
    )
    feedback_count = int(
        await db.scalar(
            select(func.count())
            .select_from(ProposalFeedback)
            .where(ProposalFeedback.user_id == user_id)
        )
        or 0
    )
    return {
        "strategy": {
            "prompt": runtime.prompt.version,
            "model": runtime.model.model_name,
            "policy": runtime.policy.version,
            "deployment_revision": runtime.deployment.revision,
        },
        "metrics": {
            "invocation_count": invocations,
            "success_rate": round(success / invocations, 4) if invocations else None,
            "proposal_count": proposals,
            "helpful_rate": round(helpful / feedback_count, 4) if feedback_count else None,
        },
        "safety": {
            "requires_user_confirmation": True,
            "direct_mutation_allowed": False,
        },
        "model_roles": MODEL_ROLE_CONTRACTS,
    }


async def list_versions(db: AsyncSession) -> dict[str, Any]:
    prompts = list(
        (
            await db.execute(select(PromptVersion).order_by(PromptVersion.created_at.desc()))
        ).scalars()
    )
    models = list(
        (await db.execute(select(ModelConfig).order_by(ModelConfig.created_at.desc()))).scalars()
    )
    policies = list(
        (
            await db.execute(
                select(AgentPolicyVersion).order_by(AgentPolicyVersion.created_at.desc())
            )
        ).scalars()
    )
    deployments = list(
        (
            await db.execute(select(AgentDeployment).order_by(AgentDeployment.deployed_at.desc()))
        ).scalars()
    )
    return {
        "prompts": [
            {
                "id": row.id,
                "agent_type": row.agent_type,
                "name": row.name,
                "version": row.version,
                "status": row.status,
                "change_note": row.change_note,
                "content_hash": row.content_hash,
                "template": row.template,
                "variables_schema": row.variables_schema,
                "output_schema": row.output_schema,
            }
            for row in prompts
        ],
        "models": [
            {
                "id": row.id,
                "name": row.name,
                "version": row.version,
                "provider": row.provider,
                "model_name": row.model_name,
                "status": row.status,
                "temperature": row.temperature,
                "max_tokens": row.max_tokens,
            }
            for row in models
        ],
        "policies": [
            {
                "id": row.id,
                "agent_type": row.agent_type,
                "name": row.name,
                "version": row.version,
                "status": row.status,
                "rules": row.rules,
                "change_note": row.change_note,
            }
            for row in policies
        ],
        "deployments": [
            {
                "id": row.id,
                "agent_type": row.agent_type,
                "environment": row.environment,
                "status": row.status,
                "revision": row.revision,
                "prompt_version_id": row.prompt_version_id,
                "model_config_id": row.model_config_id,
                "policy_version_id": row.policy_version_id,
                "deployed_at": row.deployed_at.isoformat(),
            }
            for row in deployments
        ],
    }


async def create_prompt_version(
    db: AsyncSession,
    *,
    actor: str,
    agent_type: str,
    name: str,
    version: str,
    template: str,
    variables_schema: dict[str, Any],
    output_schema: dict[str, Any],
    change_note: str,
) -> dict[str, Any]:
    row = PromptVersion(
        agent_type=agent_type,
        name=name,
        version=version,
        template=template,
        variables_schema=variables_schema,
        output_schema=output_schema,
        content_hash=canonical_hash(
            {
                "template": template,
                "variables_schema": variables_schema,
                "output_schema": output_schema,
            }
        ),
        status="candidate",
        change_note=change_note,
        created_by=actor,
    )
    db.add(row)
    await db.commit()
    return {"id": row.id, "version": row.version, "status": row.status}


async def create_model_config(
    db: AsyncSession,
    *,
    actor: str,
    name: str,
    version: str,
    provider: str,
    model_name: str,
    temperature: float,
    max_tokens: int,
) -> dict[str, Any]:
    if provider not in {"local", "smart"}:
        raise ValueError("provider 只允许 local 或 smart")
    row = ModelConfig(
        name=name,
        version=version,
        provider=provider,
        model_name=model_name,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout_ms=60000,
        retry_policy={"max_retries": 0},
        credential_alias="runtime-default",
        status="candidate",
        created_by=actor,
    )
    db.add(row)
    await db.commit()
    return {"id": row.id, "version": row.version, "status": row.status}


async def create_policy_version(
    db: AsyncSession,
    *,
    actor: str,
    agent_type: str,
    name: str,
    version: str,
    rules: dict[str, Any],
    change_note: str,
) -> dict[str, Any]:
    if rules.get("require_user_confirmation") is not True:
        raise ValueError("生产策略必须要求用户确认")
    row = AgentPolicyVersion(
        agent_type=agent_type,
        name=name,
        version=version,
        rules=rules,
        content_hash=canonical_hash(rules),
        status="candidate",
        change_note=change_note,
        created_by=actor,
    )
    db.add(row)
    await db.commit()
    return {"id": row.id, "version": row.version, "status": row.status}


async def approve_version(db: AsyncSession, *, kind: str, version_id: str, actor: str) -> dict:
    model = {
        "prompt": PromptVersion,
        "model": ModelConfig,
        "policy": AgentPolicyVersion,
    }.get(kind)
    if model is None:
        raise ValueError("未知版本类型")
    row = await db.get(model, version_id)
    if row is None:
        raise LookupError("版本不存在")
    if row.status not in {"candidate", "approved"}:
        raise ValueError("只有候选版本可以批准")
    row.status = "approved"
    if isinstance(row, AgentPolicyVersion):
        row.approved_by = actor
        row.approved_at = utc_now()
    await db.commit()
    return {"id": row.id, "status": row.status}


async def deploy_versions(
    db: AsyncSession,
    *,
    actor: str,
    agent_type: str,
    environment: str,
    prompt_version_id: str,
    model_config_id: str,
    policy_version_id: str,
) -> dict[str, Any]:
    prompt = await db.get(PromptVersion, prompt_version_id)
    model = await db.get(ModelConfig, model_config_id)
    policy = await db.get(AgentPolicyVersion, policy_version_id)
    if not prompt or not model or not policy:
        raise LookupError("版本组合不完整")
    if any(row.status != "approved" for row in (prompt, model, policy)):
        raise ValueError("只能发布已批准版本")
    if model.provider not in {"local", "smart"}:
        raise ValueError("该模型配置使用已退役路由，仅供历史审计，不能重新发布")
    current = await db.scalar(
        select(AgentDeployment).where(
            AgentDeployment.agent_type == agent_type,
            AgentDeployment.environment == environment,
            AgentDeployment.status == "active",
        )
    )
    revision = (current.revision if current else 0) + 1
    if current:
        current.status = "retired"
    row = AgentDeployment(
        agent_type=agent_type,
        environment=environment,
        prompt_version_id=prompt.id,
        model_config_id=model.id,
        policy_version_id=policy.id,
        status="active",
        revision=revision,
        deployed_by=actor,
        deployed_at=utc_now(),
    )
    db.add(row)
    await db.commit()
    return {"id": row.id, "revision": revision, "status": row.status}


async def list_user_invocations(
    db: AsyncSession, user_id: str, *, limit: int = 50
) -> list[dict[str, Any]]:
    rows = list(
        (
            await db.execute(
                select(
                    AgentInvocation,
                    PromptVersion.version,
                    ModelConfig.model_name,
                    AgentPolicyVersion.version,
                )
                .outerjoin(PromptVersion, AgentInvocation.prompt_version_id == PromptVersion.id)
                .outerjoin(ModelConfig, AgentInvocation.model_config_id == ModelConfig.id)
                .outerjoin(
                    AgentPolicyVersion,
                    AgentInvocation.policy_version_id == AgentPolicyVersion.id,
                )
                .where(AgentInvocation.user_id == user_id)
                .order_by(AgentInvocation.created_at.desc())
                .limit(limit)
            )
        ).all()
    )
    return [
        {
            "id": invocation.id,
            "proposal_id": invocation.proposal_id,
            "prompt_version": prompt_version,
            "model_name": model_name,
            "policy_version": policy_version,
            "experiment_id": invocation.experiment_id,
            "variant_id": invocation.variant_id,
            "success": invocation.success,
            "fallback": invocation.fallback,
            "latency_ms": invocation.latency_ms,
            "total_tokens": invocation.total_tokens,
            "trace_id": invocation.trace_id,
            "created_at": invocation.created_at.isoformat(),
        }
        for invocation, prompt_version, model_name, policy_version in rows
    ]


async def list_admin_invocations(db: AsyncSession, *, limit: int = 100) -> list[dict[str, Any]]:
    """Return a privacy-safe, system-wide invocation audit for administrators.

    The regular ``/invocations`` endpoint intentionally remains user-scoped.  This
    separate query is used only by the admin console and adds the account/goal
    labels needed to make a cross-user operational audit understandable without
    returning prompts or model input payloads.
    """
    rows = list(
        (
            await db.execute(
                select(
                    AgentInvocation,
                    PromptVersion.version,
                    ModelConfig.model_name,
                    AgentPolicyVersion.version,
                    User.username,
                    Goal.title,
                )
                .outerjoin(PromptVersion, AgentInvocation.prompt_version_id == PromptVersion.id)
                .outerjoin(ModelConfig, AgentInvocation.model_config_id == ModelConfig.id)
                .outerjoin(
                    AgentPolicyVersion,
                    AgentInvocation.policy_version_id == AgentPolicyVersion.id,
                )
                .outerjoin(User, AgentInvocation.user_id == User.id)
                .outerjoin(Goal, AgentInvocation.goal_id == Goal.id)
                .order_by(AgentInvocation.created_at.desc())
                .limit(limit)
            )
        ).all()
    )
    return [
        {
            "id": invocation.id,
            "user_id": invocation.user_id,
            "username": username,
            "goal_id": invocation.goal_id,
            "goal_title": goal_title,
            "proposal_id": invocation.proposal_id,
            "prompt_version": prompt_version,
            "model_name": model_name,
            "policy_version": policy_version,
            "experiment_id": invocation.experiment_id,
            "variant_id": invocation.variant_id,
            "success": invocation.success,
            "fallback": invocation.fallback,
            "latency_ms": invocation.latency_ms,
            "total_tokens": invocation.total_tokens,
            "trace_id": invocation.trace_id,
            "created_at": invocation.created_at.isoformat(),
        }
        for invocation, prompt_version, model_name, policy_version, username, goal_title in rows
    ]
