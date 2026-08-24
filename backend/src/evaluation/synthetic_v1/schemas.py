"""Frozen schemas for the first longitudinal synthetic-user evaluation.

Objects in this module are evaluation artifacts.  In particular, persona and
policy instances are hidden oracle data and must never be placed in an agent
prompt, learner profile, or other production context.
"""

from __future__ import annotations

import hashlib
import random
import uuid
from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

GENERATOR_VERSION = "SyntheticPersonaV1"
BEHAVIOR_VERSION = "BehaviorPolicyV1"


class GoalScenario(StrEnum):
    EXAM = "exam"
    CERTIFICATION = "certification"
    SKILL = "skill"
    READING = "reading"
    LANGUAGE = "language"
    HABIT = "habit"


class SyntheticPersonaV1(BaseModel):
    """Hidden ground truth used to generate one user's observable history."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    persona_id: str = Field(
        pattern=r"^syn-v1-(exam|certification|skill|reading|language|habit)-[1-5]$"
    )
    primary_scenario: GoalScenario
    secondary_scenarios: tuple[GoalScenario, ...] = ()
    proficiency: Literal["beginner", "intermediate", "advanced"]
    goal_clarity: float = Field(ge=0, le=1)
    motivation: float = Field(ge=0, le=1)
    procrastination: float = Field(ge=0, le=1)
    anxiety: float = Field(ge=0, le=1)
    change_mindedness: float = Field(ge=0, le=1)
    persistence: float = Field(ge=0, le=1)
    resilience: float = Field(ge=0, le=1)
    ai_trust: float = Field(ge=0, le=1)
    weekly_capacity_hours: float = Field(gt=0, le=80)
    estimation_ratio: float = Field(ge=0.5, le=2.5)
    preferred_time: Literal["morning", "afternoon", "evening", "late_night", "mixed"]
    communication_style: Literal["terse", "colloquial", "typo_prone", "long_form", "mixed"]
    discourse_features: tuple[
        Literal["multi_intent", "negation", "hypothetical", "rhetorical", "coreference"], ...
    ] = ()
    interaction_features: tuple[
        Literal[
            "edits_often",
            "rejects_often",
            "undoes_often",
            "distrusts_ai",
            "same_name_entities",
            "cross_goal_conflict",
        ],
        ...,
    ] = ()
    active_goal_count: int = Field(ge=1, le=3)
    historical_goal_count: int = Field(ge=7, le=8)
    personalization_consent: bool
    sensitive_inference_consent: bool

    @model_validator(mode="after")
    def validate_scenarios(self) -> "SyntheticPersonaV1":
        if self.primary_scenario in self.secondary_scenarios:
            raise ValueError("primary_scenario cannot also be secondary")
        if len(set(self.secondary_scenarios)) != len(self.secondary_scenarios):
            raise ValueError("secondary_scenarios must be unique")
        return self

    # Compatibility vocabulary used by the evaluation-only history importer.
    # These are derived views, not duplicate stored oracle fields.
    @property
    def primary_goal_type(self) -> str:
        return self.primary_scenario.value

    @property
    def secondary_goal_types(self) -> tuple[str, ...]:
        return tuple(item.value for item in self.secondary_scenarios)

    @property
    def level(self) -> str:
        return self.proficiency

    @property
    def communication_styles(self) -> tuple[str, ...]:
        styles = {
            "terse": "short",
            "colloquial": "colloquial",
            "typo_prone": "typos",
            "long_form": "long_form",
            "mixed": "multi_intent",
        }
        discourse = {
            "multi_intent": "multi_intent",
            "negation": "negative",
            "hypothetical": "hypothetical",
            "rhetorical": "rhetorical",
            "coreference": "referential",
        }
        return (
            styles[self.communication_style],
            *(discourse[item] for item in self.discourse_features),
        )

    @property
    def personalization_enabled(self) -> bool:
        return self.personalization_consent

    @property
    def sensitive_inference_enabled(self) -> bool:
        return self.sensitive_inference_consent

    @property
    def employed(self) -> bool:
        return self.weekly_capacity_hours <= 13

    @property
    def paused_goal_count(self) -> int:
        return 1

    @property
    def abandoned_goal_count(self) -> int:
        return 1

    @property
    def completed_goal_count(self) -> int:
        return self.historical_goal_count - self.active_goal_count - 2

    @property
    def policy(self) -> "BehaviorPolicyV1":
        return BehaviorPolicyV1.from_persona(self)


class BehaviorPolicyV1(BaseModel):
    """Causal transition probabilities derived from a hidden persona."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    persona_id: str
    base_activation: float = Field(ge=0, le=1)
    completion_given_start: float = Field(ge=0, le=1)
    skip_probability: float = Field(ge=0, le=1)
    reschedule_probability: float = Field(ge=0, le=1)
    checkin_probability: float = Field(ge=0, le=1)
    interruption_probability: float = Field(ge=0, le=1)
    recovery_probability: float = Field(ge=0, le=1)
    change_goal_probability: float = Field(ge=0, le=1)
    actual_to_estimated_ratio: float = Field(ge=0.5, le=2.5)
    preferred_hour: int = Field(ge=0, le=23)
    daily_capacity_minutes: int = Field(gt=0, le=24 * 60)
    deadline_sprint_days: int = Field(ge=1, le=14)
    low_ai_trust: bool = False

    @classmethod
    def from_persona(cls, persona: SyntheticPersonaV1) -> "BehaviorPolicyV1":
        preferred_hours = {
            "morning": 8,
            "afternoon": 14,
            "evening": 20,
            "late_night": 23,
            "mixed": 18,
        }
        # The equations are intentionally explicit and versioned.  Outcomes are
        # sampled daily; no final completion percentage is ever manufactured.
        activation = 0.12 + 0.44 * persona.motivation + 0.32 * persona.persistence
        activation -= 0.25 * persona.procrastination + 0.12 * persona.anxiety
        completion = 0.30 + 0.42 * persona.persistence + 0.18 * persona.goal_clarity
        completion -= 0.12 * persona.anxiety
        return cls(
            persona_id=persona.persona_id,
            base_activation=_clamp(activation),
            completion_given_start=_clamp(completion),
            skip_probability=_clamp(0.04 + 0.44 * persona.procrastination),
            reschedule_probability=_clamp(
                0.04 + 0.32 * persona.procrastination + 0.14 * persona.change_mindedness
            ),
            checkin_probability=_clamp(0.12 + 0.55 * persona.persistence),
            interruption_probability=_clamp(0.03 + 0.30 * persona.anxiety),
            recovery_probability=_clamp(0.08 + 0.72 * persona.resilience),
            change_goal_probability=_clamp(0.01 + 0.18 * persona.change_mindedness),
            actual_to_estimated_ratio=persona.estimation_ratio,
            preferred_hour=preferred_hours[persona.preferred_time],
            daily_capacity_minutes=max(15, round(persona.weekly_capacity_hours * 60 / 7)),
            deadline_sprint_days=3 if persona.procrastination >= 0.65 else 7,
            low_ai_trust=persona.ai_trust < 0.35,
        )

    @property
    def active_day_probability(self) -> float:
        return self.base_activation

    @property
    def completion_probability_when_started(self) -> float:
        return self.completion_given_start

    @property
    def weekly_capacity_minutes(self) -> int:
        return self.daily_capacity_minutes * 7

    @property
    def preferred_hours(self) -> tuple[int, ...]:
        return (self.preferred_hour,)

    @property
    def deadline_sprint_strength(self) -> float:
        return 0.9 if self.deadline_sprint_days <= 3 else 0.35

    @property
    def estimate_ratio_mean(self) -> float:
        return self.actual_to_estimated_ratio

    @property
    def estimate_ratio_jitter(self) -> float:
        return 0.15


class RunManifest(BaseModel):
    """Reproducibility and exact-cleanup boundary for one evaluation run."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    run_id: str = Field(min_length=1)
    generator_version: Literal["SyntheticPersonaV1"] = GENERATOR_VERSION
    behavior_version: Literal["BehaviorPolicyV1"] = BEHAVIOR_VERSION
    seed: int = Field(ge=0)
    created_at: datetime
    persona_ids: tuple[str, ...] = ()
    user_ids: tuple[str, ...] = ()

    @model_validator(mode="after")
    def validate_identity_sets(self) -> "RunManifest":
        for name, values in (("persona_ids", self.persona_ids), ("user_ids", self.user_ids)):
            if len(values) != len(set(values)):
                raise ValueError(f"{name} must contain exact, unique identifiers")
        if self.user_ids and len(self.user_ids) != 30:
            raise ValueError("a completed SyntheticPersonaV1 run must contain exactly 30 user_ids")
        if self.persona_ids and len(self.persona_ids) != 30:
            raise ValueError(
                "a completed SyntheticPersonaV1 run must contain exactly 30 persona_ids"
            )
        return self

    @classmethod
    def create(cls, *, seed: int, created_at: datetime, run_id: str | None = None) -> "RunManifest":
        return cls(run_id=run_id or str(uuid.uuid4()), seed=seed, created_at=created_at)


def _clamp(value: float) -> float:
    return round(max(0.0, min(1.0, value)), 6)


def stable_seed(seed: int, *parts: object) -> int:
    """Derive a platform-independent seed without Python's randomized hash()."""

    payload = "\x1f".join([str(seed), *(str(part) for part in parts)]).encode("utf-8")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big", signed=False)


def seeded_random(seed: int, *parts: object) -> random.Random:
    return random.Random(stable_seed(seed, *parts))


def build_personas(seed: int) -> tuple[SyntheticPersonaV1, ...]:
    """Build the frozen, balanced set of 30 distinct personas.

    Seed changes individual combinations while the coverage matrix remains
    invariant: six primary scenarios, five users each, both consent outcomes,
    1--3 active goals, 7--8 historical goals, and all language/interaction axes.
    """

    scenarios = list(GoalScenario)
    proficiencies = ("beginner", "intermediate", "advanced", "beginner", "intermediate")
    styles = ("terse", "colloquial", "typo_prone", "long_form", "mixed")
    times = ("morning", "evening", "late_night", "afternoon", "mixed")
    discourse = ("multi_intent", "negation", "hypothetical", "rhetorical", "coreference")
    interaction = (
        "edits_often",
        "rejects_often",
        "undoes_often",
        "distrusts_ai",
        "same_name_entities",
        "cross_goal_conflict",
    )
    personas: list[SyntheticPersonaV1] = []
    for scenario_index, scenario in enumerate(scenarios):
        for slot in range(5):
            rng = seeded_random(seed, scenario.value, slot + 1)
            idx = scenario_index * 5 + slot
            # Rotating anchors guarantee extremes, while small seeded jitter
            # avoids six copies of the same five archetypes.
            anchors = (0.15, 0.32, 0.52, 0.73, 0.90)

            def jitter(value: float) -> float:
                return _clamp(value + rng.uniform(-0.045, 0.045))

            secondary = scenarios[(scenario_index + slot + 1) % len(scenarios)]
            capacity = (3.5, 6.0, 9.0, 13.0, 20.0)[(slot + scenario_index) % 5]
            trust = jitter(anchors[(slot + 3) % 5])
            personas.append(
                SyntheticPersonaV1(
                    persona_id=f"syn-v1-{scenario.value}-{slot + 1}",
                    primary_scenario=scenario,
                    secondary_scenarios=(secondary,),
                    proficiency=proficiencies[(slot + scenario_index) % 5],
                    goal_clarity=jitter(anchors[(slot + 1) % 5]),
                    motivation=jitter(anchors[(slot + 2) % 5]),
                    procrastination=jitter(anchors[(4 - slot + scenario_index) % 5]),
                    anxiety=jitter(anchors[(slot * 2 + scenario_index) % 5]),
                    change_mindedness=jitter(anchors[(slot + 3 + scenario_index) % 5]),
                    persistence=jitter(anchors[(slot + 2 * scenario_index) % 5]),
                    resilience=jitter(anchors[(slot + 4) % 5]),
                    ai_trust=trust,
                    weekly_capacity_hours=capacity,
                    estimation_ratio=(0.65, 0.9, 1.1, 1.45, 1.9)[(slot + scenario_index) % 5],
                    preferred_time=times[(slot + scenario_index) % 5],
                    communication_style=styles[(slot + scenario_index) % 5],
                    discourse_features=(discourse[idx % len(discourse)], discourse[(idx + 2) % 5]),
                    interaction_features=(
                        interaction[idx % len(interaction)],
                        interaction[(idx + 3) % len(interaction)],
                        *(("distrusts_ai",) if trust < 0.35 else ()),
                    ),
                    active_goal_count=1 + idx % 3,
                    historical_goal_count=7 + idx % 2,
                    personalization_consent=idx % 4 != 0,
                    sensitive_inference_consent=idx % 3 == 0,
                )
            )
    return tuple(personas)


# Explicit name retained for callers that treat the builder as a versioned artifact.
build_synthetic_personas_v1 = build_personas
