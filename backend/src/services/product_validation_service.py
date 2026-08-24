"""PMF evidence and a single auditable production-readiness decision workflow."""

from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.models import (
    DataQualitySnapshot,
    LearningEvent,
    ProductFeedbackSignal,
    ProductionReadinessDecision,
    ProductValidationSnapshot,
    User,
    UserDataConsent,
)
from src.services import canary_service, core_experiment_service

PMF_SCHEMA_VERSION = "product-validation-v2"
READINESS_SCHEMA_VERSION = "production-readiness-v1"
MIN_PMF_SURVEYS = 40
MIN_BEHAVIORAL_COHORT = 40
GOAL_ESTABLISHMENT_WINDOW = timedelta(minutes=10)
ACTIVATION_WINDOW = timedelta(hours=24)
EVIDENCE_WINDOW = timedelta(hours=24)
RECOVERY_WINDOW = timedelta(hours=72)
W4_START = timedelta(days=22)
W4_END = timedelta(days=29)
W8_START = timedelta(days=50)
W8_END = timedelta(days=57)

ACTION_EVENT_TYPES = {"TaskCompleted"}
START_EVENT_TYPES = {"TaskStarted", "TaskCompleted"}
EVIDENCE_EVENT_TYPES = {"MasteryEvidenceAdded", "MasteryRecorded"}
ADJUSTMENT_EVENT_TYPES = {"CheckinSubmitted", "RecoveryCompleted", "TaskRescheduled"}


def _first_event(events: list[LearningEvent], event_type: str) -> LearningEvent | None:
    return next(
        (event for event in sorted(events, key=lambda row: row.occurred_at) if event.event_type == event_type),
        None,
    )


def _events_between(
    events: list[LearningEvent],
    *,
    start,
    end,
    event_types: set[str],
    goal_id: str | None = None,
) -> list[LearningEvent]:
    return [
        event
        for event in events
        if event.event_type in event_types
        and start <= event.occurred_at < end
        and (goal_id is None or event.goal_id == goal_id)
    ]


def _has_wvlu(events: list[LearningEvent], *, start, end) -> bool:
    """WVLU：同一目标、同一观察周同时具备行动、证据和调整。"""
    actions = _events_between(
        events,
        start=start,
        end=end,
        event_types=ACTION_EVENT_TYPES,
    )
    for action in actions:
        if action.goal_id is None:
            continue
        evidence = _events_between(
            events,
            start=start,
            end=end,
            event_types=EVIDENCE_EVENT_TYPES,
            goal_id=action.goal_id,
        )
        adjustments = _events_between(
            events,
            start=start,
            end=end,
            event_types=ADJUSTMENT_EVENT_TYPES,
            goal_id=action.goal_id,
        )
        if evidence and adjustments:
            return True
    return False


async def record_pmf_survey(
    db: AsyncSession,
    *,
    user_id: str,
    disappointment: str,
    primary_value: str,
    request_id: str,
) -> dict[str, Any]:
    consent = await db.get(UserDataConsent, user_id)
    if consent is None or not consent.product_analytics_enabled:
        raise PermissionError("提交产品研究反馈前需启用产品分析同意")
    existing = await db.scalar(
        select(ProductFeedbackSignal).where(ProductFeedbackSignal.request_id == request_id)
    )
    if existing is None:
        existing = ProductFeedbackSignal(
            user_id=user_id,
            signal_type="pmf_survey",
            value={
                "disappointment": disappointment,
                "primary_value": primary_value,
                "survey_version": "sean-ellis-v1",
            },
            request_id=request_id,
            occurred_at=utc_now(),
        )
        db.add(existing)
        await db.commit()
    return {
        "id": existing.id,
        "signal_type": existing.signal_type,
        "value": existing.value,
        "occurred_at": existing.occurred_at.isoformat(),
    }


async def generate_product_validation(db: AsyncSession) -> dict[str, Any]:
    """按主产品路线生成同意授权后的可审计价值证据。

    所有时间窗均为左闭右开区间，用户和任务在单项指标内只计一次；未成熟
    队列不进入分母。用户撤回 ``product_analytics_enabled`` 后不会进入查询。
    """
    now = utc_now()
    eligible_users = list(
        (
            await db.execute(
                select(User)
                .join(UserDataConsent, UserDataConsent.user_id == User.id)
                .where(UserDataConsent.product_analytics_enabled.is_(True))
            )
        ).scalars()
    )
    user_ids = [row.id for row in eligible_users]
    events = list(
        (
            await db.execute(
                select(LearningEvent).where(LearningEvent.user_id.in_(user_ids))
            )
        ).scalars()
    ) if user_ids else []
    events_by_user: dict[str, list[LearningEvent]] = defaultdict(list)
    for event in events:
        events_by_user[event.user_id].append(event)

    first_goals = {
        user.id: _first_event(events_by_user[user.id], "GoalCreated")
        for user in eligible_users
    }

    goal_creation_cohort = [
        user for user in eligible_users if user.created_at <= now - GOAL_ESTABLISHMENT_WINDOW
    ]
    goals_created_10m = sum(
        first_goals[user.id] is not None
        and user.created_at <= first_goals[user.id].occurred_at < user.created_at + GOAL_ESTABLISHMENT_WINDOW
        for user in goal_creation_cohort
    )

    activation_cohort = [
        user
        for user in eligible_users
        if first_goals[user.id] is not None
        and first_goals[user.id].occurred_at <= now - ACTIVATION_WINDOW
    ]
    first_starts: dict[str, LearningEvent] = {}
    first_actions: dict[str, LearningEvent] = {}
    for user in activation_cohort:
        goal = first_goals[user.id]
        assert goal is not None
        goal_events = events_by_user[user.id]
        starts = _events_between(
            goal_events,
            start=goal.occurred_at,
            end=goal.occurred_at + ACTIVATION_WINDOW,
            event_types=START_EVENT_TYPES,
            goal_id=goal.goal_id,
        )
        actions = _events_between(
            goal_events,
            start=goal.occurred_at,
            end=goal.occurred_at + ACTIVATION_WINDOW,
            event_types=ACTION_EVENT_TYPES,
            goal_id=goal.goal_id,
        )
        if starts:
            first_starts[user.id] = min(starts, key=lambda row: row.occurred_at)
        if actions:
            first_actions[user.id] = min(actions, key=lambda row: row.occurred_at)

    evidence_cohort_actions = {
        user_id: action
        for user_id, action in first_actions.items()
        if action.occurred_at <= now - EVIDENCE_WINDOW
    }
    first_action_with_evidence = 0
    for user_id, action in evidence_cohort_actions.items():
        evidence = _events_between(
            events_by_user[user_id],
            start=action.occurred_at,
            end=action.occurred_at + EVIDENCE_WINDOW,
            event_types=EVIDENCE_EVENT_TYPES,
            goal_id=action.goal_id,
        )
        first_action_with_evidence += any(
            event.aggregate_id == action.aggregate_id or event.goal_id == action.goal_id
            for event in evidence
        )

    w4_cohort = [
        user
        for user in activation_cohort
        if user.id in first_actions
        and first_goals[user.id] is not None
        and first_goals[user.id].occurred_at <= now - W4_END
    ]
    w4_wvlu = sum(
        _has_wvlu(
            events_by_user[user.id],
            start=first_goals[user.id].occurred_at + W4_START,
            end=first_goals[user.id].occurred_at + W4_END,
        )
        for user in w4_cohort
    )
    w8_cohort = [
        user
        for user in activation_cohort
        if user.id in first_actions
        and first_goals[user.id] is not None
        and first_goals[user.id].occurred_at <= now - W8_END
    ]
    w8_wvlu = sum(
        _has_wvlu(
            events_by_user[user.id],
            start=first_goals[user.id].occurred_at + W8_START,
            end=first_goals[user.id].occurred_at + W8_END,
        )
        for user in w8_cohort
    )

    recent_deviation_start = now - timedelta(days=28)
    deviations = [
        event
        for event in events
        if event.event_type == "DeviationDetected"
        and recent_deviation_start <= event.occurred_at <= now - RECOVERY_WINDOW
    ]
    recovery_selected_ids = {
        str((event.payload or {}).get("deviation_event_id"))
        for event in events
        if event.event_type == "RecoverySelected"
    }
    recovery_completed_by_deviation = {
        str((event.payload or {}).get("deviation_event_id")): event
        for event in events
        if event.event_type == "RecoveryCompleted"
        and (event.payload or {}).get("deviation_event_id")
    }
    recovered_72h = sum(
        deviation.id in recovery_completed_by_deviation
        and deviation.occurred_at
        <= recovery_completed_by_deviation[deviation.id].occurred_at
        < deviation.occurred_at + RECOVERY_WINDOW
        for deviation in deviations
    )
    recovery_selected = sum(deviation.id in recovery_selected_ids for deviation in deviations)

    surveys = list(
        (
            await db.execute(
                select(ProductFeedbackSignal)
                .where(
                    ProductFeedbackSignal.user_id.in_(user_ids),
                    ProductFeedbackSignal.signal_type == "pmf_survey",
                )
                .order_by(ProductFeedbackSignal.occurred_at.desc())
            )
        ).scalars()
    ) if user_ids else []
    latest_surveys: dict[str, ProductFeedbackSignal] = {}
    for survey in surveys:
        latest_surveys.setdefault(survey.user_id, survey)
    very_disappointed = sum(
        (row.value or {}).get("disappointment") == "very_disappointed"
        for row in latest_surveys.values()
    )

    recent_events = [event for event in events if event.occurred_at >= now - timedelta(days=28)]
    task_outcomes = sum(
        event.event_type in {"TaskCompleted", "TaskSkipped", "TaskRescheduled"}
        for event in recent_events
    )
    overload_events = sum(
        event.event_type in {"TaskSkipped", "TaskRescheduled"} for event in recent_events
    )
    goal_created_10m_rate = (
        goals_created_10m / len(goal_creation_cohort) if goal_creation_cohort else None
    )
    first_task_started_24h_rate = (
        len(first_starts) / len(activation_cohort) if activation_cohort else None
    )
    activation_rate = len(first_actions) / len(activation_cohort) if activation_cohort else None
    first_action_evidence_rate = (
        first_action_with_evidence / len(evidence_cohort_actions)
        if evidence_cohort_actions
        else None
    )
    w4_retention_rate = w4_wvlu / len(w4_cohort) if w4_cohort else None
    w8_retention_rate = w8_wvlu / len(w8_cohort) if w8_cohort else None
    recovery_selected_rate = recovery_selected / len(deviations) if deviations else None
    recovery_rate = recovered_72h / len(deviations) if deviations else None
    pmf_rate = very_disappointed / len(latest_surveys) if latest_surveys else None
    overload_rate = overload_events / task_outcomes if task_outcomes else None

    latest_quality: dict[str, DataQualitySnapshot] = {}
    quality_rows = list(
        (
            await db.execute(
                select(DataQualitySnapshot)
                .where(DataQualitySnapshot.user_id.in_(user_ids))
                .order_by(DataQualitySnapshot.sampled_at.desc())
            )
        ).scalars()
    ) if user_ids else []
    for row in quality_rows:
        latest_quality.setdefault(row.user_id, row)
    quality_ready_rate = (
        sum(row.quality_score >= 0.8 for row in latest_quality.values()) / len(latest_quality)
        if latest_quality
        else None
    )

    sufficient = (
        len(latest_surveys) >= MIN_PMF_SURVEYS
        and len(goal_creation_cohort) >= MIN_BEHAVIORAL_COHORT
        and len(activation_cohort) >= MIN_BEHAVIORAL_COHORT
        and len(w4_cohort) >= MIN_BEHAVIORAL_COHORT
        and len(deviations) >= MIN_BEHAVIORAL_COHORT
        and task_outcomes > 0
    )
    thresholds = {
        "very_disappointed_rate": 0.40,
        "goal_created_10m_rate": 0.60,
        "activation_24h_rate": 0.60,
        "week4_wvlu_retention_rate": 0.35,
        "recovery_72h_rate": 0.40,
        "max_overload_rate": 0.25,
        "minimum_surveys": MIN_PMF_SURVEYS,
        "minimum_behavioral_cohort": MIN_BEHAVIORAL_COHORT,
    }
    status = "insufficient_data"
    if sufficient:
        status = (
            "supported"
            if pmf_rate is not None
            and pmf_rate >= thresholds["very_disappointed_rate"]
            and goal_created_10m_rate is not None
            and goal_created_10m_rate >= thresholds["goal_created_10m_rate"]
            and activation_rate is not None
            and activation_rate >= thresholds["activation_24h_rate"]
            and w4_retention_rate is not None
            and w4_retention_rate >= thresholds["week4_wvlu_retention_rate"]
            and recovery_rate is not None
            and recovery_rate >= thresholds["recovery_72h_rate"]
            and overload_rate is not None
            and overload_rate <= thresholds["max_overload_rate"]
            else "not_supported"
        )
    report = {
        "schema_version": PMF_SCHEMA_VERSION,
        "status": status,
        "generated_at": now.isoformat(),
        "consented_user_count": len(eligible_users),
        "metrics": {
            "survey_count": len(latest_surveys),
            "very_disappointed_rate": round(pmf_rate, 4) if pmf_rate is not None else None,
            "goal_creation_10m_cohort": len(goal_creation_cohort),
            "goal_created_10m_rate": (
                round(goal_created_10m_rate, 4) if goal_created_10m_rate is not None else None
            ),
            "activation_cohort": len(activation_cohort),
            "first_task_started_24h_rate": (
                round(first_task_started_24h_rate, 4)
                if first_task_started_24h_rate is not None
                else None
            ),
            "activation_24h_rate": (
                round(activation_rate, 4) if activation_rate is not None else None
            ),
            "first_action_evidence_rate": (
                round(first_action_evidence_rate, 4)
                if first_action_evidence_rate is not None
                else None
            ),
            "first_action_evidence_cohort": len(evidence_cohort_actions),
            "week4_wvlu_cohort": len(w4_cohort),
            "week4_wvlu_retention_rate": (
                round(w4_retention_rate, 4) if w4_retention_rate is not None else None
            ),
            "week8_wvlu_cohort": len(w8_cohort),
            "week8_wvlu_retention_rate": (
                round(w8_retention_rate, 4) if w8_retention_rate is not None else None
            ),
            "recovery_72h_cohort": len(deviations),
            "recovery_selected_rate": (
                round(recovery_selected_rate, 4)
                if recovery_selected_rate is not None
                else None
            ),
            "recovery_72h_rate": (
                round(recovery_rate, 4) if recovery_rate is not None else None
            ),
            "task_outcome_28d_count": task_outcomes,
            "overload_event_28d_count": overload_events,
            "overload_rate_28d": (
                round(overload_rate, 4) if overload_rate is not None else None
            ),
            "quality_ready_rate": (
                round(quality_ready_rate, 4) if quality_ready_rate is not None else None
            ),
        },
        "rate_details": {
            "very_disappointed_rate": {
                "numerator": very_disappointed,
                "denominator": len(latest_surveys),
                "value": round(pmf_rate, 4) if pmf_rate is not None else None,
            },
            "goal_created_10m_rate": {
                "numerator": goals_created_10m,
                "denominator": len(goal_creation_cohort),
                "value": round(goal_created_10m_rate, 4) if goal_created_10m_rate is not None else None,
            },
            "first_task_started_24h_rate": {
                "numerator": len(first_starts),
                "denominator": len(activation_cohort),
                "value": round(first_task_started_24h_rate, 4) if first_task_started_24h_rate is not None else None,
            },
            "activation_24h_rate": {
                "numerator": len(first_actions),
                "denominator": len(activation_cohort),
                "value": round(activation_rate, 4) if activation_rate is not None else None,
            },
            "first_action_evidence_rate": {
                "numerator": first_action_with_evidence,
                "denominator": len(evidence_cohort_actions),
                "value": round(first_action_evidence_rate, 4) if first_action_evidence_rate is not None else None,
            },
            "week4_wvlu_retention_rate": {
                "numerator": w4_wvlu,
                "denominator": len(w4_cohort),
                "value": round(w4_retention_rate, 4) if w4_retention_rate is not None else None,
            },
            "week8_wvlu_retention_rate": {
                "numerator": w8_wvlu,
                "denominator": len(w8_cohort),
                "value": round(w8_retention_rate, 4) if w8_retention_rate is not None else None,
            },
            "recovery_selected_rate": {
                "numerator": recovery_selected,
                "denominator": len(deviations),
                "value": round(recovery_selected_rate, 4) if recovery_selected_rate is not None else None,
            },
            "recovery_72h_rate": {
                "numerator": recovered_72h,
                "denominator": len(deviations),
                "value": round(recovery_rate, 4) if recovery_rate is not None else None,
            },
            "overload_rate_28d": {
                "numerator": overload_events,
                "denominator": task_outcomes,
                "value": round(overload_rate, 4) if overload_rate is not None else None,
            },
        },
        "thresholds": thresholds,
        "metric_definitions": {
            "goal_created_10m_rate": "注册满10分钟的授权用户中，注册后[0,10分钟)内创建首个目标的用户占比；每用户一次。",
            "first_task_started_24h_rate": "首个目标已满24小时的用户中，在该目标创建后[0,24小时)开始或完成至少一项任务的用户占比；诊断指标。",
            "activation_24h_rate": "首个目标已满24小时的用户中，在该目标创建后[0,24小时)完成至少一项任务的用户占比；每用户一次。",
            "first_action_evidence_rate": "首次完成已满24小时的激活用户中，在首次任务完成后[0,24小时)为同一目标留下掌握记录或掌握证据的用户占比。",
            "week4_wvlu_retention_rate": "24小时已激活且首个目标满29天的用户中，在目标创建后第22天（含）至第29天（不含）满足同目标行动+证据+复盘/恢复/调整三条件的用户占比。",
            "week8_wvlu_retention_rate": "24小时已激活且首个目标满57天的用户中，在目标创建后第50天（含）至第57天（不含）满足WVLU三条件的用户占比。",
            "recovery_72h_rate": "最近28天内已完整观察72小时的明确偏差中，在偏差后[0,72小时)产生RecoveryCompleted（恢复完成）的偏差占比；按偏差去重。",
            "recovery_selected_rate": "同一恢复队列中，用户确认过恢复方案的偏差占比；预览或推荐不计入。",
            "overload_rate_28d": "最近28天任务完成、跳过和改期事件中，跳过或改期事件的占比；它是维护负担代理，不等于用户主观感受。",
        },
        "measurement_policy": {
            "consent": "仅纳入product_analytics_enabled=true的当前授权用户",
            "interval": "所有时间窗左闭右开",
            "deduplication": "用户级指标每用户一次；恢复指标每偏差一次",
            "time_basis": "数据库naive UTC业务时间；生命周期周相对首个目标创建时间",
            "content_minimization": "指标事件不保存验收答案正文或模型推理内容",
            "threshold_status": "当前阈值为工程预设，尚未经过真实用户样本校准",
        },
    }
    db.add(
        ProductValidationSnapshot(
            schema_version=PMF_SCHEMA_VERSION,
            status=status,
            report=report,
            generated_at=now,
        )
    )
    await db.commit()
    return report


def _snapshot_report(row: ProductValidationSnapshot) -> dict[str, Any]:
    return {"snapshot_id": row.id, **row.report}


async def latest_product_validation(db: AsyncSession) -> dict[str, Any] | None:
    row = await db.scalar(
        select(ProductValidationSnapshot)
        .order_by(ProductValidationSnapshot.generated_at.desc())
        .limit(1)
    )
    return _snapshot_report(row) if row is not None else None


async def list_product_validation_snapshots(
    db: AsyncSession, *, limit: int = 30
) -> list[dict[str, Any]]:
    rows = list(
        (
            await db.execute(
                select(ProductValidationSnapshot)
                .order_by(ProductValidationSnapshot.generated_at.desc())
                .limit(limit)
            )
        ).scalars()
    )
    return [_snapshot_report(row) for row in rows]


async def evaluate_production_readiness(
    db: AsyncSession,
    *,
    actor: str,
    canary_release_id: str | None,
    personalization_experiment_id: str | None,
    window_days: int,
    enforce_rollback: bool = False,
) -> dict[str, Any]:
    core = await core_experiment_service.run_core_experiments(
        db,
        window_days=window_days,
        experiment_id=personalization_experiment_id,
    )
    product = await generate_product_validation(db)
    canary = (
        await canary_service.get_canary(db, canary_release_id)
        if canary_release_id
        else None
    )
    decision, reason_codes = readiness_decision(core=core, product=product, canary=canary)
    enforced = False
    if decision == "rollback" and enforce_rollback and canary_release_id and canary:
        if canary["status"] in {"running", "paused"}:
            await canary_service.rollback_canary(
                db,
                canary_release_id,
                actor,
                "自动发布决策触发：" + ", ".join(reason_codes),
            )
            enforced = True
    generated_at = utc_now()
    evidence = {
        "schema_version": READINESS_SCHEMA_VERSION,
        "core_experiments": core,
        "product_validation": product,
        "canary": canary,
        "rollback_enforced": enforced,
    }
    row = ProductionReadinessDecision(
        decision=decision,
        reason_codes=reason_codes,
        evidence=evidence,
        canary_release_id=canary_release_id,
        actor=actor,
        generated_at=generated_at,
    )
    db.add(row)
    await db.commit()
    return {
        "id": row.id,
        "decision": decision,
        "reason_codes": reason_codes,
        "evidence": evidence,
        "generated_at": generated_at.isoformat(),
    }


def readiness_decision(
    *, core: dict[str, Any], product: dict[str, Any], canary: dict[str, Any] | None
) -> tuple[str, list[str]]:
    """Pure precedence rule: safety rollback > evidence hold > go."""
    blockers: list[str] = []
    rollback_reasons: list[str] = []
    if not core["all_supported"]:
        blockers.append("core_experiments_not_supported")
    if product["status"] != "supported":
        blockers.append(f"product_validation_{product['status']}")
    if canary is None:
        blockers.append("canary_missing")
    else:
        canary_blockers = list(canary.get("advance_blockers") or [])
        rollback_reasons.extend(
            reason
            for reason in canary_blockers
            if reason in {"critical_safety_incident", "error_rate", "fallback_rate"}
        )
        if canary["status"] == "rolled_back":
            rollback_reasons.append("canary_already_rolled_back")
        if canary["status"] not in {"running", "completed"}:
            blockers.append(f"canary_status_{canary['status']}")
        if canary["current_stage"] != "100":
            blockers.append("canary_not_at_100_percent")
        blockers.extend(f"canary_{reason}" for reason in canary_blockers)

    decision = "rollback" if rollback_reasons else "hold" if blockers else "go"
    return decision, list(dict.fromkeys(rollback_reasons + blockers))


async def list_decisions(db: AsyncSession, *, limit: int = 30) -> list[dict[str, Any]]:
    rows = list(
        (
            await db.execute(
                select(ProductionReadinessDecision)
                .order_by(ProductionReadinessDecision.generated_at.desc())
                .limit(limit)
            )
        ).scalars()
    )
    return [
        {
            "id": row.id,
            "decision": row.decision,
            "reason_codes": row.reason_codes,
            "canary_release_id": row.canary_release_id,
            "actor": row.actor,
            "generated_at": row.generated_at.isoformat(),
        }
        for row in rows
    ]
