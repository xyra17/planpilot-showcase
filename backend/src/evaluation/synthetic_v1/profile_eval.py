"""Three-layer profile restoration evaluation for synthetic-v1."""

from __future__ import annotations

from collections import Counter
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.privacy_fields import SENSITIVE_INFERENCE_FIELDS
from src.evaluation.synthetic_v1.schemas import BehaviorPolicyV1, SyntheticPersonaV1
from src.intelligence.cognitive_model import (
    CognitiveProfileBuilder,
    cognitive_profile_to_dict,
)
from src.intelligence.profile_builder import ProfileBuilder, profile_to_dict
from src.models import Goal, LearnerPattern, LearnerProfile, LearningEvent, UserDataConsent


async def evaluate_profile_restoration(
    db: AsyncSession,
    *,
    personas_by_user: dict[str, SyntheticPersonaV1],
) -> dict[str, Any]:
    cases: list[dict[str, Any]] = []
    for user_id, persona in personas_by_user.items():
        consent = await db.get(UserDataConsent, user_id)
        profile = await ProfileBuilder.get_profile(db, user_id, None)
        cognitive = await CognitiveProfileBuilder.get_profile(db, user_id, None)
        active_goal_ids = list(
            (
                await db.execute(
                    select(Goal.id).where(Goal.user_id == user_id, Goal.status == "active")
                )
            ).scalars()
        )
        goal_profile_count = int(
            await db.scalar(
                select(func.count())
                .select_from(LearnerProfile)
                .where(
                    LearnerProfile.user_id == user_id,
                    LearnerProfile.goal_id.is_not(None),
                )
            )
            or 0
        )
        events = int(
            await db.scalar(
                select(func.count(LearningEvent.id)).where(LearningEvent.user_id == user_id)
            )
            or 0
        )
        patterns = int(
            await db.scalar(
                select(func.count(LearnerPattern.id)).where(LearnerPattern.user_id == user_id)
            )
            or 0
        )

        checks: dict[str, bool] = {
            "personalization_boundary": (
                profile is None and cognitive is None
                if not consent.personalization_enabled
                else profile is not None and cognitive is not None
            ),
            "active_goal_scope": (
                goal_profile_count == len(active_goal_ids)
                if consent.personalization_enabled
                else goal_profile_count == 0
            ),
            "event_evidence_present": events > 0,
            "pattern_traceable": patterns > 0 if consent.personalization_enabled else patterns == 0,
        }
        if cognitive is not None:
            sensitive_values = [getattr(cognitive, field) for field in SENSITIVE_INFERENCE_FIELDS]
            allowed = bool(consent.personalization_enabled and consent.sensitive_inference_enabled)
            checks["sensitive_boundary"] = allowed or all(
                value is None for value in sensitive_values
            )
            checks["ninety_day_calibration"] = cognitive.confidence <= 0.67
            checks["unsupported_not_forced"] = not (
                cognitive.sample_count == 0 and cognitive.forgetting_rate is not None
            )
        else:
            checks["sensitive_boundary"] = True
            checks["ninety_day_calibration"] = True
            checks["unsupported_not_forced"] = True

        direction_checks: dict[str, bool | None] = {
            "activity_direction": None,
            "time_direction": None,
            "estimation_direction": None,
        }
        if profile is not None and profile.event_count >= 8:
            policy = BehaviorPolicyV1.from_persona(persona)
            if policy.base_activation >= 0.7:
                direction_checks["activity_direction"] = bool(
                    profile.consistency_score is not None and profile.consistency_score >= 0.28
                )
            elif policy.base_activation <= 0.35:
                direction_checks["activity_direction"] = bool(
                    profile.consistency_score is None or profile.consistency_score <= 0.65
                )
            expected_hour = policy.preferred_hour
            direction_checks["time_direction"] = bool(
                profile.preferred_hour_start is not None
                and min(
                    (profile.preferred_hour_start - expected_hour) % 24,
                    (expected_hour - profile.preferred_hour_start) % 24,
                )
                <= 3
            )
            if profile.estimation_accuracy is not None:
                direction_checks["estimation_direction"] = (
                    abs(profile.estimation_accuracy - persona.estimation_ratio) <= 0.4
                )
        scored = list(checks.values()) + [v for v in direction_checks.values() if v is not None]
        cases.append(
            {
                "user_id": user_id,
                "persona_id": persona.persona_id,
                "observable": {"event_count": events, "pattern_count": patterns},
                "derived": {
                    "profile": profile_to_dict(profile),
                    "cognitive": cognitive_profile_to_dict(cognitive),
                },
                "checks": checks,
                "direction_checks": direction_checks,
                "score": round(sum(scored) / len(scored), 4),
                "evidence_limited": events < 8,
            }
        )

    failures = [
        {
            "user_id": case["user_id"],
            "persona_id": case["persona_id"],
            "failed": [
                key
                for group in (case["checks"], case["direction_checks"])
                for key, value in group.items()
                if value is False
            ],
        }
        for case in cases
        if any(
            value is False
            for group in (case["checks"], case["direction_checks"])
            for value in group.values()
        )
    ]
    categories = Counter(key for failure in failures for key in failure["failed"])
    return {
        "schema_version": "synthetic-profile-eval-v1",
        "case_count": len(cases),
        "mean_score": round(sum(case["score"] for case in cases) / len(cases), 4),
        "hard_boundary_pass": all(
            case["checks"][key]
            for case in cases
            for key in ("personalization_boundary", "sensitive_boundary", "active_goal_scope")
        ),
        "failure_clusters": dict(categories),
        "failures": failures,
        "cases": cases,
    }
