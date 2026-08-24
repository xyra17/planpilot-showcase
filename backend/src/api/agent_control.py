"""Phase 5 Agent control, evaluation, experiment and monitoring APIs."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.core.model_gateway import distributed_gateway_status
from src.database import get_db
from src.deps import get_current_admin, get_current_user
from src.models import User
from src.services import (
    agent_control_service,
    beta_evidence_service,
    calibration_service,
    canary_service,
    core_experiment_service,
    evaluation_v2_service,
    experiment_service,
    feedback_learning_service,
    monitoring_service,
    product_validation_service,
    trace_service,
)

router = APIRouter(prefix="/api/v1/agent-control", tags=["agent-control"])


class PromptVersionCreate(BaseModel):
    agent_type: str = "coach"
    name: str = Field(min_length=2, max_length=100)
    version: str = Field(min_length=1, max_length=30)
    template: str = Field(min_length=20, max_length=20000)
    variables_schema: dict[str, Any] = Field(default_factory=dict)
    output_schema: dict[str, Any] = Field(default_factory=dict)
    change_note: str = Field(min_length=2, max_length=1000)


class ModelConfigCreate(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    version: str = Field(min_length=1, max_length=30)
    provider: Literal["local", "smart"]
    model_name: str = Field(min_length=1, max_length=200)
    temperature: float = Field(default=0.2, ge=0, le=2)
    max_tokens: int = Field(default=700, ge=64, le=32000)


class PolicyVersionCreate(BaseModel):
    agent_type: str = "coach"
    name: str = Field(min_length=2, max_length=100)
    version: str = Field(min_length=1, max_length=30)
    rules: dict[str, Any]
    change_note: str = Field(min_length=2, max_length=1000)


class DeploymentCreate(BaseModel):
    agent_type: str = "coach"
    environment: str = "production"
    prompt_version_id: str
    model_config_id: str
    policy_version_id: str


class RollbackBody(BaseModel):
    target_deployment_id: str
    reason: str = Field(min_length=2, max_length=1000)


class VariantCreate(BaseModel):
    key: str
    display_name: str
    traffic_weight: float = Field(gt=0, le=1)
    prompt_version_id: str
    model_config_id: str
    policy_version_id: str
    is_control: bool = False
    treatment_config: dict[str, bool] = Field(default_factory=dict)


class ExperimentCreate(BaseModel):
    name: str = Field(min_length=2, max_length=150)
    hypothesis: str = Field(min_length=5, max_length=2000)
    allocation_percent: float = Field(gt=0, le=100)
    primary_metric: str = "helpful_rate"
    variants: list[VariantCreate] = Field(min_length=2, max_length=5)


class ExperimentTransition(BaseModel):
    target: Literal["approved", "running", "paused", "completed", "cancelled"]


class CoreExperimentRun(BaseModel):
    window_days: int = Field(default=90, ge=30, le=365)
    personalization_experiment_id: str | None = None


class ProductionReadinessRun(BaseModel):
    canary_release_id: str | None = None
    personalization_experiment_id: str | None = None
    window_days: int = Field(default=90, ge=30, le=365)
    enforce_rollback: bool = False


class CoachCanaryCreate(BaseModel):
    name: str = Field(min_length=3, max_length=150)
    hypothesis: str = Field(min_length=5, max_length=2000)
    offline_gate_id: str
    prompt_version_id: str
    model_config_id: str
    policy_version_id: str


class CanaryAction(BaseModel):
    reason: str = Field(min_length=2, max_length=1000)


class BetaControlUpdate(BaseModel):
    beta_enabled: bool | None = None
    new_action_runs_enabled: bool | None = None
    cohort_mode: Literal["allowlist", "percentage"] | None = None
    traffic_percent: Literal[0, 5, 20, 50] | None = None
    allowlisted_user_ids: list[str] | None = None
    reason: str = Field(min_length=2, max_length=1000)


class BetaReviewUpdate(BaseModel):
    status: Literal["reviewed", "confirmed", "dismissed"]
    note: str = Field(min_length=2, max_length=2000)
    sample_type: Literal[
        "false_action",
        "missed_action",
        "wrong_core_need",
        "wrong_entity",
        "unnecessary_clarification",
        "insufficient_clarification",
        "heavily_edited_changeset",
        "quick_rollback",
        "review_false_positive",
        "review_false_negative",
        "review_decision_check",
        "execution_failure",
        "routing_anomaly",
        "clarification_anomaly",
    ] | None = None


class BetaCandidateCreate(BaseModel):
    dataset_kind: Literal["intent-routing", "action-changeset"]


def _raise_service_error(exc: Exception) -> None:
    if isinstance(exc, LookupError):
        raise HTTPException(404, str(exc)) from exc
    raise HTTPException(400, str(exc)) from exc


@router.get("/overview")
async def user_overview(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    runtime = await agent_control_service.runtime_overview(db, current_user.id)
    monitoring = await monitoring_service.monitoring_overview(db)
    feedback = await feedback_learning_service.feedback_learning_summary(db)
    evaluation = await evaluation_v2_service.list_evaluation_runs(db)
    canary = await canary_service.canary_overview(db)
    calibration = await calibration_service.calibration_overview(db)
    return {
        **runtime,
        "monitoring": monitoring,
        "feedback_learning": feedback,
        "latest_evaluation": evaluation[0] if evaluation else None,
        "canary": canary,
        "calibration": calibration,
    }


@router.get("/invocations")
async def user_invocations(
    limit: int = Query(default=30, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    return await agent_control_service.list_user_invocations(db, current_user.id, limit=limit)


@router.get("/admin/invocations")
async def admin_invocations(
    limit: int = Query(default=100, ge=1, le=200),
    _: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """System-wide, privacy-safe invocation audit for the admin console."""
    return await agent_control_service.list_admin_invocations(db, limit=limit)


@router.get("/traces/{trace_id}")
async def agent_trace(
    trace_id: str,
    current_user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await trace_service.get_trace(db, trace_id, user_id=current_user.id, is_admin=True)
    except Exception as exc:
        _raise_service_error(exc)


@router.get("/gateway/circuits")
async def gateway_circuits(
    _: User = Depends(get_current_admin), _db: AsyncSession = Depends(get_db)
) -> list[dict]:
    # Only report routes that the current runtime can actually call. Historical
    # model registrations (including the retired configured-router alias) remain
    # auditable in version history but are not live gateway routes.
    routes = sorted(
        route
        for route in {
            f"local:{settings.model_name}" if settings.model_name else "",
            f"smart:{settings.smart_model_name}" if settings.smart_model_name else "",
            f"pro:{settings.smart_pro_model_name}" if settings.smart_pro_model_name else "",
        }
        if route
    )
    return await distributed_gateway_status(routes)


@router.get("/feedback-history")
async def feedback_history(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    return await feedback_learning_service.user_feedback_history(db, current_user.id)


@router.get("/versions")
async def versions(
    _: User = Depends(get_current_admin), db: AsyncSession = Depends(get_db)
) -> dict:
    await agent_control_service.ensure_baseline(db)
    await db.commit()
    return await agent_control_service.list_versions(db)


@router.post("/prompts", status_code=201)
async def create_prompt(
    body: PromptVersionCreate,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await agent_control_service.create_prompt_version(
            db, actor=admin.id, **body.model_dump()
        )
    except Exception as exc:
        _raise_service_error(exc)


@router.post("/models", status_code=201)
async def create_model(
    body: ModelConfigCreate,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await agent_control_service.create_model_config(
            db, actor=admin.id, **body.model_dump()
        )
    except Exception as exc:
        _raise_service_error(exc)


@router.post("/policies", status_code=201)
async def create_policy(
    body: PolicyVersionCreate,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await agent_control_service.create_policy_version(
            db, actor=admin.id, **body.model_dump()
        )
    except Exception as exc:
        _raise_service_error(exc)


@router.post("/versions/{kind}/{version_id}/approve")
async def approve_version(
    kind: Literal["prompt", "model", "policy"],
    version_id: str,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await agent_control_service.approve_version(
            db, kind=kind, version_id=version_id, actor=admin.id
        )
    except Exception as exc:
        _raise_service_error(exc)


@router.post("/deployments", status_code=201)
async def deploy(
    body: DeploymentCreate,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await agent_control_service.deploy_versions(db, actor=admin.id, **body.model_dump())
    except Exception as exc:
        _raise_service_error(exc)


@router.post("/deployments/rollback", status_code=201)
async def rollback(
    body: RollbackBody,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await monitoring_service.rollback_deployment(
            db,
            target_deployment_id=body.target_deployment_id,
            actor=admin.id,
            reason=body.reason,
        )
    except Exception as exc:
        _raise_service_error(exc)


@router.post("/evaluations/run", status_code=201)
async def run_evaluation(
    admin: User = Depends(get_current_admin), db: AsyncSession = Depends(get_db)
) -> dict:
    return await evaluation_v2_service.run_baseline_evaluation(db, admin.id)


@router.get("/evaluations")
async def evaluation_runs(
    _: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> list[dict]:
    return await evaluation_v2_service.list_evaluation_runs(db)


@router.post("/offline-gates/run", status_code=201)
async def run_offline_gate(
    admin: User = Depends(get_current_admin), db: AsyncSession = Depends(get_db)
) -> dict:
    return await evaluation_v2_service.run_combined_production_gate(db, admin.id)


@router.get("/offline-gates")
async def offline_gates(
    _: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> list[dict]:
    return await evaluation_v2_service.list_production_gates(db)


@router.post("/experiments", status_code=201)
async def create_experiment(
    body: ExperimentCreate,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await experiment_service.create_experiment(
            db,
            created_by=admin.id,
            variants=[row.model_dump() for row in body.variants],
            **body.model_dump(exclude={"variants"}),
        )
    except Exception as exc:
        _raise_service_error(exc)


@router.get("/experiments")
async def experiments(
    _: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> list[dict]:
    return await experiment_service.list_experiments(db)


@router.post("/experiments/{experiment_id}/transition")
async def transition_experiment(
    experiment_id: str,
    body: ExperimentTransition,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await experiment_service.transition_experiment(
            db, experiment_id, body.target, admin.id
        )
    except Exception as exc:
        _raise_service_error(exc)


@router.get("/experiments/{experiment_id}/results")
async def experiment_results(
    experiment_id: str,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await experiment_service.experiment_results(db, experiment_id)
    except Exception as exc:
        _raise_service_error(exc)


@router.post("/learning-experiments/run", status_code=201)
async def run_learning_experiments(
    body: CoreExperimentRun,
    _: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return await core_experiment_service.run_core_experiments(
        db,
        window_days=body.window_days,
        experiment_id=body.personalization_experiment_id,
    )


@router.get("/learning-experiments/reports")
async def learning_experiment_reports(
    limit: int = Query(default=40, ge=1, le=200),
    _: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    return await core_experiment_service.list_reports(db, limit=limit)


@router.post("/production-readiness/evaluate", status_code=201)
async def evaluate_production_readiness(
    body: ProductionReadinessRun,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await product_validation_service.evaluate_production_readiness(
            db,
            actor=admin.id,
            canary_release_id=body.canary_release_id,
            personalization_experiment_id=body.personalization_experiment_id,
            window_days=body.window_days,
            enforce_rollback=body.enforce_rollback,
        )
    except Exception as exc:
        _raise_service_error(exc)


@router.get("/production-readiness/decisions")
async def production_readiness_decisions(
    limit: int = Query(default=30, ge=1, le=200),
    _: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    return await product_validation_service.list_decisions(db, limit=limit)


@router.get("/admin/product-validation/latest")
async def latest_product_validation(
    _: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict | None:
    return await product_validation_service.latest_product_validation(db)


@router.get("/admin/product-validation/history")
async def product_validation_history(
    limit: int = Query(default=30, ge=1, le=120),
    _: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    return await product_validation_service.list_product_validation_snapshots(
        db, limit=limit
    )


@router.post("/admin/product-validation/aggregate", status_code=201)
async def aggregate_product_validation(
    _: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return await product_validation_service.generate_product_validation(db)


@router.get("/monitoring")
async def monitoring(
    _: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    return await monitoring_service.monitoring_overview(db)


@router.get("/canary")
async def canary_overview(
    _: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict | None:
    return await canary_service.canary_overview(db)


@router.post("/canary", status_code=201)
async def create_canary(
    body: CoachCanaryCreate,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await canary_service.create_coach_canary(db, actor=admin.id, **body.model_dump())
    except Exception as exc:
        _raise_service_error(exc)


@router.post("/canary/{release_id}/advance")
async def advance_canary(
    release_id: str,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await canary_service.advance_canary(db, release_id, admin.id)
    except Exception as exc:
        _raise_service_error(exc)


@router.post("/canary/{release_id}/pause")
async def pause_canary(
    release_id: str,
    body: CanaryAction,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await canary_service.pause_canary(db, release_id, admin.id, body.reason)
    except Exception as exc:
        _raise_service_error(exc)


@router.post("/canary/{release_id}/resume")
async def resume_canary(
    release_id: str,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await canary_service.resume_canary(db, release_id, admin.id)
    except Exception as exc:
        _raise_service_error(exc)


@router.post("/canary/{release_id}/rollback")
async def rollback_canary(
    release_id: str,
    body: CanaryAction,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await canary_service.rollback_canary(db, release_id, admin.id, body.reason)
    except Exception as exc:
        _raise_service_error(exc)


@router.get("/calibration")
async def calibration_overview(
    _: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    return await calibration_service.calibration_overview(db)


@router.post("/calibration/aggregate")
async def aggregate_calibration(
    _: User = Depends(get_current_admin), db: AsyncSession = Depends(get_db)
) -> dict:
    await calibration_service.capture_actual_outcomes(db)
    return await calibration_service.calculate_calibration(db)


@router.post("/canary/observations/normalize")
async def normalize_canary_observations(
    _: User = Depends(get_current_admin), db: AsyncSession = Depends(get_db)
) -> dict[str, int]:
    from src.services.canary_observation_service import normalize_canary_observations

    return {"created": await normalize_canary_observations(db)}


@router.post("/monitoring/aggregate")
async def aggregate_monitoring(
    _: User = Depends(get_current_admin), db: AsyncSession = Depends(get_db)
) -> dict:
    return await monitoring_service.aggregate_daily_metrics(db)


@router.get("/admin/beta/overview")
async def beta_overview(
    _: User = Depends(get_current_admin), db: AsyncSession = Depends(get_db)
) -> dict:
    return await beta_evidence_service.beta_overview(db)


@router.get("/admin/beta/metrics")
async def beta_metrics(
    start: datetime | None = None,
    end: datetime | None = None,
    beta_only: bool = True,
    cohort: Literal["beta", "stable", "all"] | None = None,
    source: Literal[
        "conversation",
        "insight",
        "scheduler",
        "api",
        "internal",
        "legacy_unattributed",
        "all",
    ] = "conversation",
    metric_version: Literal["action-beta-funnel-v1", "action-beta-funnel-v2"] = (
        "action-beta-funnel-v2"
    ),
    capability: str | None = None,
    resolution_quality: str | None = None,
    _: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if metric_version == "action-beta-funnel-v1":
        return await beta_evidence_service.funnel_overview_v1(
            db,
            start=start,
            end=end,
            beta_only=beta_only,
            capability=capability,
            resolution_quality=resolution_quality,
        )
    return await beta_evidence_service.funnel_overview(
        db,
        start=start,
        end=end,
        beta_only=beta_only,
        cohort=cohort,
        source=source,
        capability=capability,
        resolution_quality=resolution_quality,
    )


@router.patch("/admin/beta/control")
async def update_beta_control(
    body: BetaControlUpdate,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await beta_evidence_service.update_control(
            db, actor_id=admin.id, **body.model_dump()
        )
    except Exception as exc:
        _raise_service_error(exc)


@router.post("/admin/beta/safety/scan")
async def scan_beta_safety(
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return await beta_evidence_service.scan_hard_safety(
        db, actor_id=admin.id, source="admin_audit_scan"
    )


@router.post("/admin/beta/review-samples/normalize")
async def normalize_beta_review_samples(
    _: User = Depends(get_current_admin), db: AsyncSession = Depends(get_db)
) -> dict[str, int]:
    return {"created": await beta_evidence_service.normalize_review_samples(db)}


@router.get("/admin/beta/review-samples")
async def beta_review_samples(
    status: Literal["pending", "reviewed", "confirmed", "dismissed"] | None = None,
    limit: int = Query(default=100, ge=1, le=200),
    _: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    return await beta_evidence_service.list_review_samples(db, status=status, limit=limit)


@router.patch("/admin/beta/review-samples/{sample_id}")
async def update_beta_review_sample(
    sample_id: str,
    body: BetaReviewUpdate,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await beta_evidence_service.review_sample(
            db,
            sample_id=sample_id,
            reviewer_id=admin.id,
            status=body.status,
            note=body.note,
            sample_type=body.sample_type,
        )
    except Exception as exc:
        _raise_service_error(exc)


@router.post("/admin/beta/review-samples/{sample_id}/candidate")
async def promote_beta_review_sample(
    sample_id: str,
    body: BetaCandidateCreate,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await beta_evidence_service.promote_candidate(
            db,
            sample_id=sample_id,
            reviewer_id=admin.id,
            dataset_kind=body.dataset_kind,
        )
    except Exception as exc:
        _raise_service_error(exc)
