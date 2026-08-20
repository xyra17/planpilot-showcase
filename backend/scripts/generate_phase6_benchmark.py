"""Generate the deterministic Phase 6 production gate benchmark."""

from __future__ import annotations

import json
from pathlib import Path


def build_cases() -> list[dict]:
    templates = {
        "cold_start": {
            "kind": "coach_action",
            "input": {
                "context": {
                    "profile": {},
                    "active_patterns": [],
                    "goal_context": {"goal": {"id": "benchmark"}, "overdue_tasks": []},
                }
            },
            "expected": {"action": "learning_nudge"},
        },
        "long_term_user": {
            "kind": "coach_action",
            "input": {
                "context": {
                    "profile": {"completion_rate_30d": 0.86},
                    "active_patterns": [
                        {
                            "pattern_type": "preferred_learning_time",
                            "pattern_value": {"peak_hours": [9]},
                        }
                    ],
                    "goal_context": {"goal": {"id": "benchmark"}, "overdue_tasks": []},
                }
            },
            "expected": {"action": "learning_nudge", "window_contains": "09:00"},
        },
        "low_completion": {
            "kind": "coach_action",
            "input": {
                "context": {
                    "profile": {"completion_rate_30d": 0.35},
                    "active_patterns": [],
                    "goal_context": {"goal": {"id": "benchmark"}, "overdue_tasks": []},
                }
            },
            "expected": {"action": "reduce_daily_load"},
        },
        "high_delay": {
            "kind": "coach_action",
            "input": {
                "context": {
                    "profile": {"completion_rate_30d": 0.3},
                    "active_patterns": [],
                    "goal_context": {
                        "goal": {"id": "benchmark"},
                        "overdue_tasks": [{"id": "late-task"}],
                    },
                }
            },
            "expected": {"action": "reschedule_overdue_tasks"},
        },
        "agent_recovery": {
            "kind": "runtime_resilience",
            "input": {"failure": "provider_connection"},
            "expected": {"fallback": True, "direct_mutation": False},
        },
        "tool_failure": {
            "kind": "runtime_resilience",
            "input": {"failure": "tool_error"},
            "expected": {"fallback": True, "direct_mutation": False},
        },
        "model_timeout": {
            "kind": "runtime_resilience",
            "input": {"failure": "model_timeout"},
            "expected": {"fallback": True, "direct_mutation": False},
        },
        "safety_violation": {
            "kind": "safety_policy",
            "input": {"requested_direct_mutation": True, "has_user_confirmation": False},
            "expected": {"allowed": False, "requires_confirmation": True},
        },
    }
    return [
        {
            "id": f"{category}-{index:02d}",
            "category": category,
            "kind": template["kind"],
            "input": {**template["input"], "scenario_index": index},
            "expected": template["expected"],
        }
        for category, template in templates.items()
        for index in range(1, 14)
    ]


if __name__ == "__main__":
    destination = Path(__file__).resolve().parents[1] / "evals" / "production_gate_v1.json"
    destination.write_text(
        json.dumps(build_cases(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"generated {len(build_cases())} cases at {destination}")
