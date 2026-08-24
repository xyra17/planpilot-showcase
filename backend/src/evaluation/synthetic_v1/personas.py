"""Frozen, balanced 30-person SyntheticPersonaV1 cohort.

This module is evaluator-only oracle data. Callers must derive observable events
from ``POLICIES_BY_ID`` and must not expose persona objects to Pilo or persist them
in business/profile tables.
"""

from __future__ import annotations

from collections import Counter

from .schemas import BehaviorPolicyV1, GoalScenario, SyntheticPersonaV1, build_personas

PERSONA_SEED = 20260823

# Canonical v1 cohort. Changing this seed requires a generator-version change.
PERSONAS: tuple[SyntheticPersonaV1, ...] = build_personas(PERSONA_SEED)
PERSONAS_BY_ID: dict[str, SyntheticPersonaV1] = {
    persona.persona_id: persona for persona in PERSONAS
}
POLICIES_BY_ID: dict[str, BehaviorPolicyV1] = {
    persona.persona_id: BehaviorPolicyV1.from_persona(persona) for persona in PERSONAS
}


def _validate_frozen_cohort() -> None:
    if len(PERSONAS) != 30 or len(PERSONAS_BY_ID) != 30:
        raise RuntimeError("SyntheticPersonaV1 requires 30 unique personas")
    primary_counts = Counter(persona.primary_scenario for persona in PERSONAS)
    expected = {scenario: 5 for scenario in GoalScenario}
    if primary_counts != expected:
        raise RuntimeError(f"invalid primary-scenario coverage: {primary_counts}")
    if not all(7 <= p.historical_goal_count <= 8 for p in PERSONAS):
        raise RuntimeError("every persona must have seven or eight historical goals")
    if not all(1 <= p.active_goal_count <= 3 for p in PERSONAS):
        raise RuntimeError("every persona must have one to three active goals")
    if {p.proficiency for p in PERSONAS} != {"beginner", "intermediate", "advanced"}:
        raise RuntimeError("cohort must cover all proficiency levels")
    if {p.personalization_consent for p in PERSONAS} != {True, False}:
        raise RuntimeError("personalization consent must cover allow and deny")
    if {p.sensitive_inference_consent for p in PERSONAS} != {True, False}:
        raise RuntimeError("sensitive inference consent must cover allow and deny")
    discourse = {feature for p in PERSONAS for feature in p.discourse_features}
    expected_discourse = {"multi_intent", "negation", "hypothetical", "rhetorical", "coreference"}
    if discourse != expected_discourse:
        raise RuntimeError(f"incomplete discourse coverage: {discourse}")
    interactions = {feature for p in PERSONAS for feature in p.interaction_features}
    expected_interactions = {
        "edits_often",
        "rejects_often",
        "undoes_often",
        "distrusts_ai",
        "same_name_entities",
        "cross_goal_conflict",
    }
    if not expected_interactions <= interactions:
        raise RuntimeError(f"incomplete interaction coverage: {interactions}")


_validate_frozen_cohort()

__all__ = ["PERSONA_SEED", "PERSONAS", "PERSONAS_BY_ID", "POLICIES_BY_ID"]
