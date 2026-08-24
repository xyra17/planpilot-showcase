"""Run the versioned 120-case SyntheticPersona v19 real Pilo preflight."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import shlex
import sys
import time
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import func, select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import AsyncSessionLocal
from src.evaluation.synthetic_v1.artifacts import JsonlArtifactStore, read_jsonl, utc_iso
from src.evaluation.synthetic_v1.pilo_blackbox import (
    BlackboxCase,
    BlackboxRunner,
    PiloHttpClient,
    load_intents,
)
from src.evaluation.synthetic_v1.v19 import (
    ACTION_PROJECTION_HASH,
    ACTION_PROJECTION_VERSION,
    JUDGE_V3_PROMPT_HASH,
    JUDGE_V3_PROMPT_VERSION,
    JUDGE_V3_SYSTEM_PROMPT,
    aggregate_v19,
    build_judge_input,
    compact_observable_context,
    judge_case,
    outcome_contract,
    score_v19_case,
)
from src.models import AgentRun, Goal, LearningEvent, Task, User
from src.services.auth_session_service import issue_session

BACKEND_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_ROOT.parent
EVAL_ROOT = PROJECT_ROOT / "documents/evaluations/synthetic-v1-20260823"
SOURCE_MANIFEST = EVAL_ROOT / "manifest.json"
INTENTS_PATH = BACKEND_ROOT / "evals/synthetic-v1-intents.json"
DEFAULT_OUTPUT = EVAL_ROOT / "v19-preflight-120"
HOLDOUT_PATH = BACKEND_ROOT / "evals/synthetic-v19-holdout.json"
DIFFICULTIES = ("direct", "natural", "challenging")
SEEDS = (20260823, 20260824)
TASK_SCOPED = {"move_task", "complete_task", "delete_task_high_risk"}
OVERDUE_FIXTURE_REQUIRED = {
    "replan_overdue",
    "reduce_load",
    "reject_preview",
    "cancel_action",
    "edit_preview",
    "batch_reschedule",
}
OVERDUE_CONSUMING = {"replan_overdue", "reduce_load", "edit_preview", "batch_reschedule"}
EVALUATION_FIXTURE_GOAL_PREFIXES = ("route-regression-",)


def _json_dump(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def _jsonl_dump(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows)
    )


def _hash_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _merge_usage(rows: list[dict[str, Any]]) -> dict[str, Any]:
    def merge(values: list[Any]) -> Any:
        mappings = [value for value in values if isinstance(value, dict)]
        if mappings:
            keys = {key for mapping in mappings for key in mapping}
            return {key: merge([mapping.get(key) for mapping in mappings]) for key in sorted(keys)}
        return sum(value for value in values if isinstance(value, (int, float)))

    return merge([row.get("usage") or {} for row in rows])


def _difficulty_prompt(prompt: str, difficulty: str) -> str:
    if difficulty == "direct":
        return prompt
    if difficulty == "natural":
        return f"我说得口语一点：{prompt}"
    return f"我可能没把对象和条件说得很顺；信息不足就先问清楚，别猜。我的意思是：{prompt}"


def _pick_context(goals: list[dict[str, Any]], tasks: list[dict[str, Any]]) -> dict[str, Any]:
    active = [goal for goal in goals if goal.get("status") == "active"]
    longitudinal_active = [
        goal
        for goal in active
        if not str(goal.get("title") or "").startswith(EVALUATION_FIXTURE_GOAL_PREFIXES)
    ]
    goal = (longitudinal_active or active or goals or [{}])[0]
    goal_id = goal.get("id")
    scoped = [task for task in tasks if task.get("goalId") == goal_id]
    title_counts = Counter(str(task.get("title")) for task in tasks)
    candidates = (
        [
            task
            for task in scoped
            if task.get("status") not in {"completed", "skipped"}
            and title_counts[str(task.get("title"))] == 1
        ]
        or [task for task in scoped if title_counts[str(task.get("title"))] == 1]
        or scoped
        or tasks
    )
    task = candidates[0] if candidates else {}
    duplicate_titles = Counter(
        str(item.get("title")) for item in tasks if str(item.get("title") or "").strip()
    )
    ambiguous_title = next(
        (
            title
            for title, count in sorted(
                duplicate_titles.items(), key=lambda pair: (-pair[1], pair[0])
            )
            if count > 1
        ),
        None,
    )
    return {
        "active_goal_id": goal_id,
        "active_goal_title": goal.get("title") or "当前目标",
        "visible_task_title": task.get("title") or "今天的任务",
        "ambiguous_task_title": ambiguous_title,
        "ambiguous_task_match_count": duplicate_titles.get(ambiguous_title, 0),
        "excluded_evaluation_fixture_goal_count": len(active) - len(longitudinal_active),
        "goal_selection_policy": "latest_active_non_route_regression_fixture",
    }


def _fixture_audit(
    cases: list[BlackboxCase],
    public_context: dict[str, dict[str, Any]],
    case_users: list[dict[str, Any]],
) -> dict[str, Any]:
    today = date.today().isoformat()
    rows: list[dict[str, Any]] = []
    by_user: dict[str, list[BlackboxCase]] = {}
    for case in cases:
        by_user.setdefault(case.user_id, []).append(case)
        tasks = list(public_context[case.user_id].get("tasks") or [])
        scoped = [task for task in tasks if not case.goal_id or task.get("goalId") == case.goal_id]
        overdue = [
            task
            for task in scoped
            if task.get("status") not in {"completed", "skipped", "abandoned"}
            and str(task.get("date") or task.get("scheduledDate") or "") < today
        ]
        matches = [
            task
            for task in tasks
            if case.target_task_title
            and task.get("title") == case.target_task_title
            and (not case.goal_id or task.get("goalId") == case.goal_id)
        ]
        fixture_ready = True
        reason = None
        if case.intent_id in OVERDUE_FIXTURE_REQUIRED and not overdue:
            fixture_ready, reason = False, "selected goal has no observable overdue open task"
        elif case.intent_id in TASK_SCOPED and len(matches) != 1:
            fixture_ready, reason = False, f"task-scoped target match count is {len(matches)}"
        elif case.intent_id == "ambiguous_same_name" and len(matches) < 2:
            fixture_ready, reason = False, f"ambiguous target match count is {len(matches)}"
        rows.append(
            {
                "case_id": case.case_id,
                "user_id": case.user_id,
                "intent_id": case.intent_id,
                "goal_id": case.goal_id,
                "target_task_title": case.target_task_title,
                "overdue_open_task_count": len(overdue),
                "target_task_match_count": len(matches) if case.target_task_title else None,
                "fixture_ready": fixture_ready,
                "reason": reason,
            }
        )
    dependency_hazards = []
    for user_id, user_cases in by_user.items():
        prior_consumers: list[str] = []
        for case in user_cases:
            if case.intent_id in OVERDUE_FIXTURE_REQUIRED and prior_consumers:
                dependency_hazards.append(
                    {
                        "user_id": user_id,
                        "case_id": case.case_id,
                        "intent_id": case.intent_id,
                        "prior_overdue_consumers": list(prior_consumers),
                    }
                )
            if case.intent_id in OVERDUE_CONSUMING:
                prior_consumers.append(case.intent_id)
    selected = {str(item["user_id"]): item for item in case_users}
    return {
        "schema_version": "synthetic-v20-holdout-fixture-audit.v1",
        "evaluated_on": today,
        "goal_selection_policy": "latest active longitudinal goal; route-regression fixtures excluded",
        "excluded_evaluation_fixture_goals": sum(
            int(item.get("excluded_evaluation_fixture_goal_count") or 0)
            for item in selected.values()
        ),
        "cases": rows,
        "fixture_failures": [row for row in rows if not row["fixture_ready"]],
        "inter_case_dependency_hazards": dependency_hazards,
        "pass": not any(not row["fixture_ready"] for row in rows)
        and not dependency_hazards,
    }


def _build_cases(
    users: list[dict[str, Any]], intents: list[dict[str, Any]], *, run_id: str
) -> list[BlackboxCase]:
    cases: list[BlackboxCase] = []
    for intent_index, intent in enumerate(intents):
        for difficulty_index, difficulty in enumerate(DIFFICULTIES):
            for seed_index, seed in enumerate(SEEDS):
                user = users[(intent_index * 6 + difficulty_index * 2 + seed_index) % len(users)]
                template = str(intent["prompts"][seed_index % len(intent["prompts"])])
                prompt = _difficulty_prompt(
                    template.format(
                        goal_title=user["active_goal_title"],
                        task_title=user["visible_task_title"],
                    ),
                    difficulty,
                )
                contract = outcome_contract(intent, prompt)
                digest = hashlib.sha256(
                    f"{run_id}:{intent['id']}:{difficulty}:{seed}:{user['user_id']}".encode()
                ).hexdigest()[:16]
                paths = list(intent.get("readback_paths") or [])
                if intent["id"] == "natural_checkin":
                    paths.append(f"/api/v1/checkin/{user['active_goal_id']}/today")
                if (
                    intent["id"] in TASK_SCOPED | {"ambiguous_same_name"}
                    and "/api/v1/tasks" not in paths
                ):
                    paths.append("/api/v1/tasks")
                target_title = None
                if intent["id"] in TASK_SCOPED:
                    target_title = user["visible_task_title"]
                elif intent["id"] == "ambiguous_same_name":
                    target_title = "复习" if "复习" in prompt else "练习"
                cases.append(
                    BlackboxCase(
                        case_id=f"v19-{digest}",
                        user_id=user["user_id"],
                        intent_id=str(intent["id"]),
                        repetition=difficulty_index,
                        variant=seed_index,
                        prompt=prompt,
                        goal_id=user["active_goal_id"] if intent.get("goal_scoped") else None,
                        decision=str(intent.get("decision", "observe")),
                        expected=dict(intent.get("expected") or {}),
                        readback_paths=tuple(paths),
                        follow_up_rules=tuple(intent.get("follow_up_rules") or ()),
                        edit_patch=intent.get("edit_patch"),
                        difficulty=difficulty,
                        seed=seed,
                        outcome_contract=contract,
                        target_task_title=target_title,
                    )
                )
    if len(cases) != 120 or len({case.case_id for case in cases}) != 120:
        raise RuntimeError("v19 matrix must contain 120 unique cases")
    if set(Counter(case.user_id for case in cases).values()) != {4}:
        raise RuntimeError("v19 matrix must assign exactly four cases to every user")
    return cases


def _build_holdout_cases(
    users: list[dict[str, Any]], intents: list[dict[str, Any]], *, run_id: str,
    holdout_path: Path = HOLDOUT_PATH,
) -> list[BlackboxCase]:
    dataset = json.loads(holdout_path.read_text())
    expressions = dataset["expressions"]
    contract_overrides = dataset.get("contracts") or {}
    user_index_overrides = dataset.get("user_index_overrides") or {}
    cases: list[BlackboxCase] = []
    for intent_index, intent in enumerate(intents):
        intent_id = str(intent["id"])
        for variant, template in enumerate(expressions[intent_id]):
            user_index = (intent_index * 3 + variant) % len(users)
            if intent_id in user_index_overrides:
                user_index = int(user_index_overrides[intent_id][variant])
            user = users[user_index]
            if intent_id == "ambiguous_same_name" and int(
                user.get("ambiguous_task_match_count") or 0
            ) < 2:
                raise RuntimeError(
                    f"ambiguous fixture lacks duplicate task facts: user={user['user_id']}"
                )
            prompt = str(template).format(
                goal_title=user["active_goal_title"],
                task_title=user["visible_task_title"],
                ambiguous_task_title=user.get("ambiguous_task_title") or "复习",
            )
            digest = hashlib.sha256(
                f"{run_id}:{intent_id}:holdout:{variant}:{user['user_id']}".encode()
            ).hexdigest()[:16]
            paths = list(intent.get("readback_paths") or [])
            if intent_id == "natural_checkin":
                paths.append(f"/api/v1/checkin/{user['active_goal_id']}/today")
            if intent_id in TASK_SCOPED | {"ambiguous_same_name"} and "/api/v1/tasks" not in paths:
                paths.append("/api/v1/tasks")
            contract = outcome_contract(intent, prompt)
            override = dict(contract_overrides.get(intent_id) or {})
            if override:
                contract.update(
                    {
                        "allowed_outcomes": list(override.get("allowed_outcomes") or []),
                        "write_expected": bool(override.get("write_expected")),
                        "undo_expected": bool(override.get("undo_expected")),
                        "clarification_allowed": bool(
                            override.get("clarification_allowed")
                        ),
                        "explicit_action_intent": bool(
                            override.get("action_run_required")
                        ),
                        "v3_contract": override,
                    }
                )
            target_title = None
            if intent_id in TASK_SCOPED:
                target_title = user["visible_task_title"]
            elif intent_id == "ambiguous_same_name":
                target_title = user["ambiguous_task_title"]
            cases.append(BlackboxCase(
                case_id=f"v19h-{digest}", user_id=user["user_id"], intent_id=intent_id,
                repetition=variant, variant=0, prompt=prompt,
                goal_id=user["active_goal_id"] if intent.get("goal_scoped") else None,
                decision=str(override.get("decision") or intent.get("decision", "observe")), expected=dict(intent.get("expected") or {}),
                readback_paths=tuple(paths), follow_up_rules=tuple(intent.get("follow_up_rules") or ()),
                edit_patch=intent.get("edit_patch"), difficulty=f"holdout-{variant + 1}", seed=20260825,
                outcome_contract=contract,
                target_task_title=target_title,
            ))
    if len(cases) != 60 or set(Counter(case.user_id for case in cases).values()) != {2}:
        raise RuntimeError("holdout matrix must contain 60 cases and two cases per user")
    return cases


async def _database_snapshot(
    user_ids: list[str], run_owner_map: dict[str, str] | None = None
) -> dict[str, Any]:
    async with AsyncSessionLocal() as db:
        admin = await db.scalar(select(User).where(User.email.like("%@qq.com")))
        users = int(await db.scalar(select(func.count(User.id))) or 0)
        goals = int(await db.scalar(select(func.count(Goal.id))) or 0)
        tasks = int(await db.scalar(select(func.count(Task.id))) or 0)
        learning_events = int(await db.scalar(select(func.count(LearningEvent.id))) or 0)
        agent_runs = int(await db.scalar(select(func.count(AgentRun.id))) or 0)
        synthetic_present = int(
            await db.scalar(select(func.count(User.id)).where(User.id.in_(user_ids))) or 0
        )
        orphan_tasks = int(
            await db.scalar(select(func.count(Task.id)).outerjoin(Goal).where(Goal.id.is_(None)))
            or 0
        )
        cross_user_runs = 0
        if run_owner_map:
            stored_runs = list(
                (
                    await db.execute(
                        select(AgentRun.id, AgentRun.user_id).where(AgentRun.id.in_(run_owner_map))
                    )
                ).all()
            )
            cross_user_runs = sum(
                str(user_id) != str(run_owner_map[str(run_id)]) for run_id, user_id in stored_runs
            ) + (len(run_owner_map) - len(stored_runs))
        return {
            "captured_at": utc_iso(),
            "users": users,
            "goals": goals,
            "tasks": tasks,
            "learning_events": learning_events,
            "agent_runs": agent_runs,
            "synthetic_users_present": synthetic_present,
            "orphan_tasks": orphan_tasks,
            "cross_user_runs": cross_user_runs,
            "administrator": {
                "id": admin.id if admin else None,
                "email": admin.email if admin else None,
                "is_admin": admin.is_admin if admin else None,
                "email_verified": admin.email_verified if admin else None,
                "is_active": admin.is_active if admin else None,
            },
        }


async def _judge_all(
    cases: list[dict[str, Any]],
    contexts: dict[str, dict[str, Any]],
    *,
    concurrency: int,
    output: Path,
    provider: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    semaphore = asyncio.Semaphore(max(1, concurrency))
    lock = asyncio.Lock()

    def compact_context(case: dict[str, Any]) -> dict[str, Any]:
        return compact_observable_context(case, contexts[case["user_id"]])

    input_path = output / "judge_inputs.jsonl"
    if input_path.exists():
        inputs = read_jsonl(input_path)
        if {row.get("case_id") for row in inputs} != {case.get("case_id") for case in cases}:
            raise RuntimeError("frozen judge inputs do not match v19 cases")
        case_contexts = {
            str(row["case_id"]): dict(row.get("pilo_observable_context") or {})
            for row in inputs
        }
    else:
        case_contexts = {case["case_id"]: compact_context(case) for case in cases}
        inputs = [build_judge_input(case, case_contexts[case["case_id"]]) for case in cases]
        _jsonl_dump(input_path, inputs)
    judge_path = output / "judge.jsonl"
    existing = read_jsonl(judge_path)
    recorded_ids = {row.get("case_id") for row in existing}
    pending = [case for case in cases if case.get("case_id") not in recorded_ids]

    async def one(case: dict[str, Any]) -> dict[str, Any]:
        async with semaphore:
            result = await judge_case(
                case,
                case_contexts[case["case_id"]],
                provider=provider,
                system_prompt=JUDGE_V3_SYSTEM_PROMPT,
                prompt_version=JUDGE_V3_PROMPT_VERSION,
                prompt_hash=JUDGE_V3_PROMPT_HASH,
                max_tokens=220,
            )
            async with lock:
                with judge_path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(result, ensure_ascii=False, sort_keys=True) + "\n")
                    handle.flush()
            return result

    await asyncio.gather(*(one(case) for case in pending))
    return inputs, read_jsonl(judge_path)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-url", default="http://127.0.0.1:8000")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--run-id", default="synthetic-v19-preflight-120")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--judge-concurrency", type=int, default=3)
    parser.add_argument("--judge-provider", choices=("smart", "local"), default="smart")
    parser.add_argument("--skip-judge", action="store_true")
    parser.add_argument("--retry-failed-judge", action="store_true")
    parser.add_argument("--retry-infrastructure-failures", action="store_true")
    parser.add_argument("--matrix", choices=("preflight", "holdout"), default="preflight")
    parser.add_argument("--holdout-path", type=Path, default=HOLDOUT_PATH)
    parser.add_argument("--intent-filter", help="comma-separated targeted regression intents")
    parser.add_argument(
        "--prepare-only",
        action="store_true",
        help="freeze materialized case contracts and fixture audit without running Pilo",
    )
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    source_manifest = json.loads(SOURCE_MANIFEST.read_text())
    user_ids = list(source_manifest["user_ids"])
    if len(user_ids) != 30 or len(set(user_ids)) != 30:
        raise RuntimeError("source manifest must contain 30 unique users")

    before_db = await _database_snapshot(user_ids)
    if before_db["users"] < 31 or before_db["synthetic_users_present"] != 30:
        raise RuntimeError(f"main database baseline mismatch: {before_db}")
    admin_before = before_db["administrator"]
    if not all(
        [admin_before["is_admin"], admin_before["email_verified"], admin_before["is_active"]]
    ):
        raise RuntimeError("administrator baseline mismatch")

    async with AsyncSessionLocal() as db:
        tokens: dict[str, str] = {}
        for user_id in user_ids:
            user = await db.get(User, user_id)
            if user is None:
                raise RuntimeError(f"synthetic user missing: {user_id}")
            tokens[user_id] = (await issue_session(db, user, remember_me=False)).access_token
        await db.commit()

    started = time.monotonic()
    async with httpx.AsyncClient(base_url=args.api_url, timeout=180, trust_env=False) as client:
        ready = await client.get("/ready")
        ready.raise_for_status()
        api = PiloHttpClient(client, tokens)
        public_context: dict[str, dict[str, Any]] = {}
        case_users: list[dict[str, Any]] = []
        for user_id in user_ids:
            goals = await api.request("GET", "/api/v1/goals", user_id)
            tasks = await api.request("GET", "/api/v1/tasks", user_id)
            try:
                profile = await api.request("GET", "/api/v1/learner/profile", user_id)
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code not in {403, 404}:
                    raise
                profile = {
                    "available": False,
                    "status_code": exc.response.status_code,
                    "reason": "not authorized or not built",
                }
            selected = _pick_context(goals, tasks)
            case_users.append({"user_id": user_id, **selected})
            public_context[user_id] = {
                "profile": profile,
                "goals": goals,
                "tasks": tasks,
            }

        manifest_path = args.output / "manifest.json"
        intents = load_intents(INTENTS_PATH)
        existing_manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
        if existing_manifest:
            cases = [
                BlackboxCase(
                    case_id=row["case_id"],
                    user_id=row["user_id"],
                    intent_id=row["intent_id"],
                    repetition=int(row.get("repetition", 0)),
                    variant=int(row.get("variant", 0)),
                    prompt=row["prompt"],
                    goal_id=row.get("goal_id"),
                    decision=row["decision"],
                    expected=row["expected"],
                    readback_paths=tuple(row.get("readback_paths") or ()),
                    follow_up_rules=tuple(row.get("follow_up_rules") or ()),
                    edit_patch=row.get("edit_patch"),
                    difficulty=row["difficulty"],
                    seed=row["seed"],
                    outcome_contract=row["outcome_contract"],
                    target_task_title=row.get("target_task_title"),
                )
                for row in existing_manifest["case_contracts"]
            ]
        else:
            cases = (
                _build_holdout_cases(case_users, intents, run_id=args.run_id, holdout_path=args.holdout_path)
                if args.matrix == "holdout"
                else _build_cases(case_users, intents, run_id=args.run_id)
            )
            if args.intent_filter:
                selected_intents = {item.strip() for item in args.intent_filter.split(",") if item.strip()}
                cases = [case for case in cases if case.intent_id in selected_intents]
        frozen_created_at = existing_manifest.get("created_at") if existing_manifest else utc_iso()
        manifest = {
            "schema_version": "synthetic-v19-manifest.v1",
            "run_id": args.run_id,
            "created_at": frozen_created_at,
            "source_manifest": str(SOURCE_MANIFEST),
            "source_manifest_hash": _hash_file(SOURCE_MANIFEST),
            "intent_dataset": str(INTENTS_PATH),
            "intent_dataset_hash": _hash_file(INTENTS_PATH),
            "judge_prompt_version": JUDGE_V3_PROMPT_VERSION,
            "judge_prompt_hash": JUDGE_V3_PROMPT_HASH,
            "action_projection_version": ACTION_PROJECTION_VERSION,
            "action_projection_hash": ACTION_PROJECTION_HASH,
            "judge_provider": args.judge_provider,
            "difficulties": list(DIFFICULTIES),
            "seeds": list(SEEDS),
            "case_count": len(cases),
            "context_selection_policy": "latest_active_non_route_regression_fixture",
            "matrix": args.matrix,
            "intent_filter": args.intent_filter,
            "holdout_dataset": str(args.holdout_path) if args.matrix == "holdout" else None,
            "holdout_dataset_hash": _hash_file(args.holdout_path) if args.matrix == "holdout" else None,
            "user_ids": user_ids,
            "case_contracts": [
                {
                    "case_id": case.case_id,
                    "user_id": case.user_id,
                    "intent_id": case.intent_id,
                    "difficulty": case.difficulty,
                    "repetition": case.repetition,
                    "variant": case.variant,
                    "seed": case.seed,
                    "prompt": case.prompt,
                    "goal_id": case.goal_id,
                    "decision": case.decision,
                    "expected": case.expected,
                    "readback_paths": list(case.readback_paths),
                    "follow_up_rules": list(case.follow_up_rules),
                    "edit_patch": case.edit_patch,
                    "target_task_title": case.target_task_title,
                    "outcome_contract": case.outcome_contract,
                }
                for case in cases
            ],
        }
        manifest_hash = hashlib.sha256(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()
        manifest["manifest_hash"] = manifest_hash
        if manifest_path.exists():
            existing = json.loads(manifest_path.read_text())
            if existing.get("manifest_hash") != manifest_hash:
                raise RuntimeError("existing v19 manifest differs; use a new versioned directory")
        else:
            _json_dump(manifest_path, manifest)

        fixture_audit_path = args.output / "fixture_audit.json"
        fixture_audit = _fixture_audit(cases, public_context, case_users)
        if fixture_audit_path.exists():
            existing_fixture_audit = json.loads(fixture_audit_path.read_text())
            if existing_fixture_audit != fixture_audit:
                raise RuntimeError("frozen fixture audit differs; use a new versioned directory")
        else:
            _json_dump(fixture_audit_path, fixture_audit)
        if not fixture_audit["pass"]:
            raise RuntimeError(
                "holdout fixture audit failed: "
                f"failures={len(fixture_audit['fixture_failures'])}, "
                f"dependency_hazards={len(fixture_audit['inter_case_dependency_hazards'])}"
            )

        if args.prepare_only:
            snapshot_path = args.output / "pre_run_database_snapshot.json"
            if snapshot_path.exists():
                raise RuntimeError("pre-run database snapshot already exists; refusing to overwrite")
            _json_dump(snapshot_path, before_db)
            print(
                json.dumps(
                    {
                        "prepared": True,
                        "manifest_hash": manifest_hash,
                        "case_count": len(cases),
                        "fixture_audit_pass": True,
                        "database_snapshot": before_db,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return

        runtime_dir = args.output / "runtime"
        artifacts = JsonlArtifactStore(runtime_dir, manifest["run_id"])
        if args.retry_infrastructure_failures and artifacts.cases_path.exists():
            retry_ids = {
                row["case_id"]
                for row in read_jsonl(artifacts.cases_path)
                if row.get("status") != "completed"
                or not score_v19_case(row)["infrastructure_pass"]
            }
            artifacts.prepare_retry(retry_ids)
        resume_parts = [
            "python",
            "scripts/run_synthetic_v19_preflight.py",
            "--api-url",
            args.api_url,
            "--output",
            str(args.output),
            "--run-id",
            args.run_id,
            "--concurrency",
            str(args.concurrency),
            "--judge-concurrency",
            str(args.judge_concurrency),
            "--judge-provider",
            args.judge_provider,
            "--matrix",
            args.matrix,
            "--holdout-path",
            str(args.holdout_path),
        ]
        if args.skip_judge:
            resume_parts.append("--skip-judge")
        if args.intent_filter:
            resume_parts.extend(["--intent-filter", args.intent_filter])
        resume = f"cd {shlex.quote(str(BACKEND_ROOT))} && " + " ".join(
            shlex.quote(item) for item in resume_parts
        )
        runner = BlackboxRunner(
            api,
            artifacts,
            run_id=manifest["run_id"],
            resume_command=resume,
            max_conversation_turns=4,
            concurrency=args.concurrency,
        )
        runtime_result = await runner.run(cases)

    raw_cases = read_jsonl(args.output / "runtime/cases.jsonl")
    final_cases = []
    for case in raw_cases:
        case["manifest_hash"] = manifest_hash
        if case.get("status") == "completed":
            case["v19_scoring"] = score_v19_case(case)
        final_cases.append(case)
    _jsonl_dump(args.output / "cases.jsonl", final_cases)

    frozen_inputs = [
        build_judge_input(
            case,
            compact_observable_context(case, public_context[str(case["user_id"])]),
        )
        for case in final_cases
    ]
    judge_inputs_path = args.output / "judge_inputs.jsonl"
    if judge_inputs_path.exists():
        existing_inputs = read_jsonl(judge_inputs_path)
        if {row.get("case_id") for row in existing_inputs} != {
            row.get("case_id") for row in frozen_inputs
        }:
            archive = args.output / "judge_inputs.partial_archive.jsonl"
            if not archive.exists():
                judge_inputs_path.replace(archive)
                _jsonl_dump(judge_inputs_path, frozen_inputs)
        elif existing_inputs != frozen_inputs:
            raise RuntimeError("frozen judge inputs differ; use a new versioned directory")
    else:
        _jsonl_dump(judge_inputs_path, frozen_inputs)
    from run_synthetic_v19_audit_v2 import projection_quality, rejection_rows

    _json_dump(
        args.output / "projection_quality.json",
        projection_quality(final_cases, frozen_inputs, public_context),
    )
    _jsonl_dump(args.output / "rejection_analysis.jsonl", rejection_rows(final_cases))

    judges: list[dict[str, Any]] = []
    if not args.skip_judge:
        judge_path = args.output / "judge.jsonl"
        if args.retry_failed_judge and judge_path.exists():
            existing_judges = read_jsonl(judge_path)
            failed_judges = [row for row in existing_judges if row.get("status") != "completed"]
            completed_judges = [row for row in existing_judges if row.get("status") == "completed"]
            if failed_judges:
                archive_path = args.output / "judge_retry_archive.jsonl"
                with archive_path.open("a", encoding="utf-8") as handle:
                    for row in failed_judges:
                        handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
                _jsonl_dump(judge_path, completed_judges)
        _, judges = await _judge_all(
            final_cases,
            public_context,
            concurrency=args.judge_concurrency,
            output=args.output,
            provider=args.judge_provider,
        )

    run_owner_map = {
        str(run.get("id")): str(case["user_id"])
        for case in final_cases
        for turn in case.get("turns", [])
        for run in [turn.get("run") or {}]
        if run.get("id")
    }
    after_db = await _database_snapshot(user_ids, run_owner_map)
    invariants = {
        "before": before_db,
        "after": after_db,
        "checks": {
            "user_count_unchanged": before_db["users"] == after_db["users"],
            "all_synthetic_users_preserved": after_db["synthetic_users_present"] == 30,
            "administrator_unchanged": before_db["administrator"] == after_db["administrator"],
            "no_orphan_tasks": after_db["orphan_tasks"] == 0,
            "no_cross_user_runs": after_db["cross_user_runs"] == 0,
        },
    }
    _json_dump(args.output / "database_invariants.json", invariants)
    summary = aggregate_v19(final_cases, judges)
    summary.update(
        {
            "manifest_hash": manifest_hash,
            "runtime_result": runtime_result,
            "database_invariants_pass": all(invariants["checks"].values()),
            "elapsed_seconds": round(time.monotonic() - started, 3),
        }
    )
    _json_dump(args.output / "deterministic_summary.json", summary)
    judge_summary = {
        "coverage": summary["judge_coverage"],
        "failures": summary["judge_failures"],
        "dimensions": summary["judge_dimensions"],
        "models": dict(Counter(row.get("judge_model") for row in judges)),
        "attempts": sum(int(row.get("attempts") or 0) for row in judges),
        "retry_count": sum(max(0, int(row.get("attempts") or 0) - 1) for row in judges),
        "usage": _merge_usage(judges),
    }
    _json_dump(args.output / "judge_summary.json", judge_summary)
    _json_dump(args.output / "failure_clusters.json", summary["failure_clusters"])
    _json_dump(
        args.output / "run_stats.json",
        {
            "elapsed_seconds": summary["elapsed_seconds"],
            "case_count": len(final_cases),
            "judge_attempts": judge_summary["attempts"],
            "judge_retries": judge_summary["retry_count"],
            "model_usage": judge_summary["usage"],
            "resume_command": resume,
        },
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
