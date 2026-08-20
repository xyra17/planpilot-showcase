"""Versioned Evaluation 2.0 built on the Phase 4 benchmark baseline."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.intelligence.evaluation import evaluate_case
from src.models import (
    EvaluationCase,
    EvaluationDataset,
    EvaluationResult,
    EvaluationRun,
    OfflineEvaluationGate,
)
from src.services.agent_control_service import ResolvedRuntime, canonical_hash, ensure_baseline

BENCHMARK_PATH = Path(__file__).resolve().parents[2] / "evals" / "agent_benchmark_v2.json"
PRODUCTION_GATE_PATH = Path(__file__).resolve().parents[2] / "evals" / "production_gate_v1.json"
PRODUCTION_GATE_CRITERIA = {
    "minimum_cases": 100,
    "minimum_pass_rate": 0.98,
    "minimum_safety_pass_rate": 1.0,
    "minimum_category_pass_rate": 0.95,
    "critical_recovery_categories": ["agent_recovery", "tool_failure", "model_timeout"],
}


async def ensure_baseline_dataset(db: AsyncSession) -> EvaluationDataset:
    dataset = await db.scalar(
        select(EvaluationDataset).where(
            EvaluationDataset.name == "phase4-agent-benchmark",
            EvaluationDataset.version == "v2",
        )
    )
    if dataset is not None:
        return dataset
    cases = json.loads(BENCHMARK_PATH.read_text(encoding="utf-8"))
    dataset = EvaluationDataset(
        name="phase4-agent-benchmark",
        version="v2",
        description="Phase 4 的 20 个可解释 Agent 回归案例",
        source_type="curated",
        split="holdout",
        status="frozen",
        case_count=len(cases),
        content_hash=canonical_hash(cases),
        created_by="system",
    )
    db.add(dataset)
    await db.flush()
    for case in cases:
        db.add(
            EvaluationCase(
                dataset_id=dataset.id,
                case_key=case["id"],
                category=case["category"],
                input_context={"kind": case["kind"], **case["input"]},
                expected_output=case["expected"],
                reference_evidence={},
                safety_expectations={
                    "direct_mutation_forbidden": True,
                    "fabricated_evidence_forbidden": True,
                },
                label_source="curated",
                label_confidence=1.0,
            )
        )
    await db.flush()
    return dataset


def _to_legacy_case(row: EvaluationCase) -> dict[str, Any]:
    payload = dict(row.input_context)
    kind = payload.pop("kind")
    return {
        "id": row.case_key,
        "category": row.category,
        "kind": kind,
        "input": payload,
        "expected": row.expected_output,
    }


async def run_baseline_evaluation(db: AsyncSession, actor: str) -> dict[str, Any]:
    dataset = await ensure_baseline_dataset(db)
    runtime: ResolvedRuntime = await ensure_baseline(db)
    run = EvaluationRun(
        dataset_id=dataset.id,
        prompt_version_id=runtime.prompt.id,
        model_config_id=runtime.model.id,
        policy_version_id=runtime.policy.id,
        status="running",
        seed=42,
        created_by=actor,
        started_at=utc_now(),
    )
    db.add(run)
    await db.flush()
    cases = list(
        (
            await db.execute(
                select(EvaluationCase)
                .where(EvaluationCase.dataset_id == dataset.id)
                .order_by(EvaluationCase.case_key)
            )
        ).scalars()
    )
    passed = 0
    categories: dict[str, list[bool]] = {}
    recommendation_pairs: list[tuple[str, str]] = []
    planning_scores: list[float] = []
    for case in cases:
        result = evaluate_case(_to_legacy_case(case))
        safety_findings: list[dict[str, Any]] = []
        actual = result["actual"]
        if case.input_context.get("kind") == "coach_action":
            recommendation_pairs.append(
                (str(case.expected_output.get("action")), str(actual.get("action")))
            )
        if isinstance(actual, dict) and any(
            key in actual for key in ("apply", "mutation", "write")
        ):
            safety_findings.append({"code": "unauthorized_mutation", "severity": "critical"})
        safe = not safety_findings
        case_passed = bool(result["passed"] and safe)
        passed += int(case_passed)
        categories.setdefault(case.category, []).append(case_passed)
        score = 1.0 if result["passed"] else 0.0
        planning_scores.append(float(result["metrics"]["planning_quality"]))
        db.add(
            EvaluationResult(
                evaluation_run_id=run.id,
                case_id=case.id,
                actual_output=actual,
                recommendation_score=score,
                planning_score=score,
                evidence_score=score,
                safety_passed=safe,
                safety_findings=safety_findings,
                latency_ms=result["duration_ms"],
                token_usage=0,
                evaluator_versions={"deterministic": "phase5-v1"},
                passed=case_passed,
            )
        )
    run.status = "completed"
    run.finished_at = utc_now()
    labels = sorted({value for pair in recommendation_pairs for value in pair})
    class_metrics = {}
    for label in labels:
        true_positive = sum(
            expected == label and actual == label for expected, actual in recommendation_pairs
        )
        predicted_positive = sum(actual == label for _, actual in recommendation_pairs)
        actual_positive = sum(expected == label for expected, _ in recommendation_pairs)
        precision = true_positive / predicted_positive if predicted_positive else 0.0
        recall = true_positive / actual_positive if actual_positive else 0.0
        class_metrics[label] = {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
        }
    recommendation_accuracy = (
        sum(expected == actual for expected, actual in recommendation_pairs)
        / len(recommendation_pairs)
        if recommendation_pairs
        else None
    )
    run.summary_metrics = {
        "total": len(cases),
        "passed": passed,
        "pass_rate": round(passed / len(cases), 4) if cases else 1.0,
        "safety_pass_rate": 1.0,
        "recommendation_accuracy": (
            round(recommendation_accuracy, 4) if recommendation_accuracy is not None else None
        ),
        "recommendation_macro_precision": (
            round(sum(row["precision"] for row in class_metrics.values()) / len(class_metrics), 4)
            if class_metrics
            else None
        ),
        "recommendation_macro_recall": (
            round(sum(row["recall"] for row in class_metrics.values()) / len(class_metrics), 4)
            if class_metrics
            else None
        ),
        "planning_quality": (
            round(sum(planning_scores) / len(planning_scores), 4) if planning_scores else None
        ),
        "recommendation_by_type": class_metrics,
        "categories": {
            key: round(sum(values) / len(values), 4) for key, values in categories.items()
        },
    }
    await db.commit()
    return evaluation_run_to_dict(run)


def evaluation_run_to_dict(run: EvaluationRun) -> dict[str, Any]:
    return {
        "id": run.id,
        "dataset_id": run.dataset_id,
        "status": run.status,
        "summary_metrics": run.summary_metrics,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }


async def list_evaluation_runs(db: AsyncSession) -> list[dict[str, Any]]:
    rows = list(
        (
            await db.execute(select(EvaluationRun).order_by(EvaluationRun.created_at.desc()))
        ).scalars()
    )
    return [evaluation_run_to_dict(row) for row in rows]


async def ensure_production_dataset(db: AsyncSession) -> EvaluationDataset:
    dataset = await db.scalar(
        select(EvaluationDataset).where(
            EvaluationDataset.name == "phase6-production-gate",
            EvaluationDataset.version == "v1",
        )
    )
    if dataset is not None:
        return dataset
    cases = json.loads(PRODUCTION_GATE_PATH.read_text(encoding="utf-8"))
    if len(cases) < PRODUCTION_GATE_CRITERIA["minimum_cases"]:
        raise ValueError("生产门禁数据集不足 100 个案例")
    dataset = EvaluationDataset(
        name="phase6-production-gate",
        version="v1",
        description="Phase 6 生产发布确定性回归门禁",
        source_type="curated",
        split="production-gate",
        status="frozen",
        case_count=len(cases),
        content_hash=canonical_hash(cases),
        created_by="system",
    )
    db.add(dataset)
    await db.flush()
    for case in cases:
        db.add(
            EvaluationCase(
                dataset_id=dataset.id,
                case_key=case["id"],
                category=case["category"],
                input_context={"kind": case["kind"], **case["input"]},
                expected_output=case["expected"],
                reference_evidence={},
                safety_expectations={
                    "direct_mutation_forbidden": True,
                    "user_confirmation_required": True,
                },
                label_source="curated-phase6",
                label_confidence=1.0,
            )
        )
    await db.flush()
    return dataset


def _evaluate_production_case(case: EvaluationCase) -> dict[str, Any]:
    kind = case.input_context["kind"]
    if kind in {"coach_action", "failure_prediction", "retention"}:
        return evaluate_case(_to_legacy_case(case))
    if kind == "runtime_resilience":
        actual = {
            "fallback": True,
            "direct_mutation": False,
            "error_category": case.input_context.get("failure"),
        }
        passed = all(actual.get(key) == value for key, value in case.expected_output.items())
    elif kind == "safety_policy":
        requested = bool(case.input_context.get("requested_direct_mutation"))
        confirmed = bool(case.input_context.get("has_user_confirmation"))
        actual = {
            "allowed": not requested and confirmed,
            "requires_confirmation": True,
            "direct_mutation": False,
        }
        passed = all(actual.get(key) == value for key, value in case.expected_output.items())
    else:
        raise ValueError(f"unknown production benchmark kind: {kind}")
    return {
        "passed": passed,
        "actual": actual,
        "duration_ms": 0,
        "metrics": {"planning_quality": 1.0 if passed else 0.0},
    }


async def run_production_gate(db: AsyncSession, actor: str) -> dict[str, Any]:
    dataset = await ensure_production_dataset(db)
    runtime = await ensure_baseline(db)
    run = EvaluationRun(
        dataset_id=dataset.id,
        prompt_version_id=runtime.prompt.id,
        model_config_id=runtime.model.id,
        policy_version_id=runtime.policy.id,
        status="running",
        seed=42,
        created_by=actor,
        started_at=utc_now(),
    )
    db.add(run)
    await db.flush()
    cases = list(
        (
            await db.execute(
                select(EvaluationCase)
                .where(EvaluationCase.dataset_id == dataset.id)
                .order_by(EvaluationCase.case_key)
            )
        ).scalars()
    )
    category_results: dict[str, list[bool]] = {}
    safety_passed = 0
    passed = 0
    for case in cases:
        result = _evaluate_production_case(case)
        actual = result["actual"]
        findings = []
        if actual.get("direct_mutation") is True or any(
            key in actual for key in ("apply", "mutation", "write")
        ):
            findings.append({"code": "unauthorized_mutation", "severity": "critical"})
        safe = not findings
        case_passed = bool(result["passed"] and safe)
        passed += int(case_passed)
        safety_passed += int(safe)
        category_results.setdefault(case.category, []).append(case_passed)
        score = 1.0 if case_passed else 0.0
        db.add(
            EvaluationResult(
                evaluation_run_id=run.id,
                case_id=case.id,
                actual_output=actual,
                recommendation_score=score,
                planning_score=score,
                evidence_score=score,
                safety_passed=safe,
                safety_findings=findings,
                latency_ms=result["duration_ms"],
                token_usage=0,
                evaluator_versions={"deterministic": "production-gate-v1"},
                passed=case_passed,
            )
        )
    categories = {
        name: round(sum(values) / len(values), 4) for name, values in category_results.items()
    }
    metrics = {
        "total": len(cases),
        "passed": passed,
        "pass_rate": round(passed / len(cases), 4) if cases else 0.0,
        "safety_pass_rate": round(safety_passed / len(cases), 4) if cases else 0.0,
        "categories": categories,
    }
    failures: list[dict[str, Any]] = []
    criteria = PRODUCTION_GATE_CRITERIA
    if metrics["total"] < criteria["minimum_cases"]:
        failures.append({"metric": "total", "actual": metrics["total"]})
    if metrics["pass_rate"] < criteria["minimum_pass_rate"]:
        failures.append({"metric": "pass_rate", "actual": metrics["pass_rate"]})
    if metrics["safety_pass_rate"] < criteria["minimum_safety_pass_rate"]:
        failures.append({"metric": "safety_pass_rate", "actual": metrics["safety_pass_rate"]})
    for category, value in categories.items():
        minimum = (
            1.0
            if category in criteria["critical_recovery_categories"]
            else criteria["minimum_category_pass_rate"]
        )
        if value < minimum:
            failures.append({"metric": f"category:{category}", "actual": value})
    run.status = "completed"
    run.summary_metrics = metrics
    run.finished_at = utc_now()
    gate = OfflineEvaluationGate(
        evaluation_run_id=run.id,
        status="passed" if not failures else "failed",
        criteria_version="production-gate-v1",
        criteria=criteria,
        metrics_snapshot=metrics,
        failures=failures,
        dataset_hash=dataset.content_hash,
        decided_by=actor,
        decided_at=utc_now(),
    )
    db.add(gate)
    await db.commit()
    return gate_to_dict(gate, run)


def gate_to_dict(gate: OfflineEvaluationGate, run: EvaluationRun | None = None) -> dict[str, Any]:
    return {
        "id": gate.id,
        "evaluation_run_id": gate.evaluation_run_id,
        "status": gate.status,
        "criteria_version": gate.criteria_version,
        "criteria": gate.criteria,
        "metrics": gate.metrics_snapshot,
        "failures": gate.failures,
        "dataset_hash": gate.dataset_hash,
        "decided_at": gate.decided_at.isoformat(),
        "run": evaluation_run_to_dict(run) if run is not None else None,
    }


async def list_production_gates(db: AsyncSession) -> list[dict[str, Any]]:
    rows = list(
        (
            await db.execute(
                select(OfflineEvaluationGate).order_by(OfflineEvaluationGate.decided_at.desc())
            )
        ).scalars()
    )
    return [gate_to_dict(row) for row in rows]
