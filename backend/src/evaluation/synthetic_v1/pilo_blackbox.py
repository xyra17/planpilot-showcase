"""Dynamic Pilo black-box runner using only authenticated HTTP and SSE interfaces.

No database session, internal prompt, NeedFrame, ActionIntent, or hidden persona oracle is
accepted by this module.  The simulator's next action is derived from a deliberately
small projection of the same run status, summaries, previews, and errors visible to a
normal user.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Iterable

import httpx

from .artifacts import JsonlArtifactStore, utc_iso
from .scoring import score_case

EXTERNAL_HTTP_STATUSES = {402, 408, 425, 429, 500, 502, 503, 504}
WAITING_OR_TERMINAL = {
    "waiting_approval",
    "completed",
    "failed",
    "rejected",
    "cancelled",
    "rolled_back",
}


class ExternalServiceBlocked(RuntimeError):
    def __init__(self, *, kind: str, endpoint: str, detail: str, status_code: int | None = None):
        super().__init__(detail)
        self.payload = {
            "kind": kind,
            "endpoint": endpoint,
            "status_code": status_code,
            "detail": detail[:1000],
            "detected_at": utc_iso(),
        }


def _first_mapping(value: Any) -> dict[str, Any] | None:
    """Extract a public object from dict- or list-wrapped SSE payloads."""
    if isinstance(value, dict):
        if any(key in value for key in ("id", "status", "approvals", "run_id")):
            return value
        for key in ("data", "action_run", "run", "result"):
            nested = _first_mapping(value.get(key))
            if nested is not None:
                return nested
        return None
    if isinstance(value, list):
        for item in value:
            nested = _first_mapping(item)
            if nested is not None:
                return nested
    return None


def _visible_token_text(value: Any) -> str:
    """Read token text from dict/list envelopes without assuming JSON shape."""
    if isinstance(value, dict):
        text = value.get("text")
        return str(text) if text is not None else ""
    if isinstance(value, list):
        return "".join(_visible_token_text(item) for item in value)
    return str(value) if isinstance(value, str) else ""


def _preserve_visible_projection(
    previous: dict[str, Any], current: dict[str, Any]
) -> dict[str, Any]:
    """Carry the public SSE projection across approval/execution detail refreshes."""
    merged = dict(current)
    for key in ("pilo_visible_text", "pilo_stream"):
        if key in previous:
            merged[key] = previous[key]
    return merged


@dataclass(frozen=True)
class BlackboxCase:
    case_id: str
    user_id: str
    intent_id: str
    repetition: int
    variant: int
    prompt: str
    goal_id: str | None
    decision: str
    expected: dict[str, Any]
    readback_paths: tuple[str, ...]
    follow_up_rules: tuple[dict[str, Any], ...]
    edit_patch: dict[str, Any] | None = None
    difficulty: str | None = None
    seed: int | None = None
    outcome_contract: dict[str, Any] | None = None
    target_task_title: str | None = None


def load_intents(path: str | Path) -> list[dict[str, Any]]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema_version") != "synthetic-v1-intents.v1":
        raise ValueError("unsupported synthetic intent dataset")
    intents = value.get("intents")
    if not isinstance(intents, list) or len(intents) != 20:
        raise ValueError("synthetic-v1 requires exactly 20 core intents")
    ids = [item.get("id") for item in intents]
    if len(set(ids)) != 20 or any(not item for item in ids):
        raise ValueError("intent ids must be present and unique")
    return intents


def build_balanced_cases(
    users: Iterable[dict[str, Any]],
    intents: Iterable[dict[str, Any]],
    *,
    repetitions: int,
    variants: int,
    seed: int,
) -> list[BlackboxCase]:
    """Build a reproducible balanced matrix (30*20*3*2 = 3,600 in the full run)."""

    user_rows = sorted(users, key=lambda item: str(item["user_id"]))
    intent_rows = sorted(intents, key=lambda item: str(item["id"]))
    rng = random.Random(seed)
    cases: list[BlackboxCase] = []
    for repetition in range(repetitions):
        for variant in range(variants):
            rotated = (
                intent_rows[(repetition + variant) % len(intent_rows) :]
                + intent_rows[: (repetition + variant) % len(intent_rows)]
            )
            for user_index, user in enumerate(user_rows):
                for intent_index, intent in enumerate(rotated):
                    prompts = intent["prompts"]
                    prompt_index = (user_index + repetition + variant + intent_index) % len(prompts)
                    prompt = str(prompts[prompt_index]).format(
                        goal_title=user.get("active_goal_title", "当前目标"),
                        task_title=user.get("visible_task_title", "今天的任务"),
                    )
                    digest = hashlib.sha256(
                        f"{seed}:{user['user_id']}:{intent['id']}:{repetition}:{variant}".encode()
                    ).hexdigest()[:16]
                    cases.append(
                        BlackboxCase(
                            case_id=f"sv1-{digest}",
                            user_id=str(user["user_id"]),
                            intent_id=str(intent["id"]),
                            repetition=repetition,
                            variant=variant,
                            prompt=prompt,
                            goal_id=user.get("active_goal_id")
                            if intent.get("goal_scoped")
                            else None,
                            decision=str(intent.get("decision", "observe")),
                            expected=copy.deepcopy(intent.get("expected") or {}),
                            readback_paths=tuple(intent.get("readback_paths") or ()),
                            follow_up_rules=tuple(
                                copy.deepcopy(intent.get("follow_up_rules") or ())
                            ),
                            edit_patch=copy.deepcopy(intent.get("edit_patch")),
                        )
                    )
    rng.shuffle(cases)
    return cases


async def parse_sse(lines: AsyncIterator[str]) -> AsyncIterator[dict[str, Any]]:
    event: dict[str, Any] = {}
    data: list[str] = []
    async for raw in lines:
        line = raw.rstrip("\r")
        if not line:
            if data:
                payload = json.loads("\n".join(data))
                yield {
                    "event": event.get("event", "message"),
                    "id": event.get("id"),
                    "data": payload,
                }
            event, data = {}, []
        elif line.startswith(":"):
            continue
        elif line.startswith("event:"):
            event["event"] = line[6:].strip()
        elif line.startswith("id:"):
            event["id"] = line[3:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())
    if data:
        yield {
            "event": event.get("event", "message"),
            "id": event.get("id"),
            "data": json.loads("\n".join(data)),
        }


class PiloHttpClient:
    def __init__(self, client: httpx.AsyncClient, tokens: dict[str, str]) -> None:
        self.client = client
        self.tokens = tokens

    def headers(self, user_id: str) -> dict[str, str]:
        try:
            return {"Authorization": f"Bearer {self.tokens[user_id]}"}
        except KeyError as exc:
            raise ValueError(f"missing API token for user {user_id}") from exc

    async def request(self, method: str, path: str, user_id: str, **kwargs: Any) -> Any:
        try:
            response = await self.client.request(
                method, path, headers=self.headers(user_id), **kwargs
            )
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise ExternalServiceBlocked(kind="network", endpoint=path, detail=str(exc)) from exc
        if response.status_code in EXTERNAL_HTTP_STATUSES:
            raise ExternalServiceBlocked(
                kind="http_external",
                endpoint=path,
                status_code=response.status_code,
                detail=response.text,
            )
        response.raise_for_status()
        return response.json() if response.content else None

    async def stream_pilo(
        self, user_id: str, *, message: str, goal_id: str | None, session_id: str
    ) -> tuple[dict[str, Any] | None, list[dict[str, Any]], str]:
        """Call the real Pilo entrypoint and retain only user-visible SSE output."""
        path = "/api/v1/agent/stream"
        visible_events: list[dict[str, Any]] = []
        text_parts: list[str] = []
        action_run: dict[str, Any] | None = None
        try:
            async with self.client.stream(
                "POST",
                path,
                headers=self.headers(user_id),
                json={"message": message, "goal_id": goal_id, "session_id": session_id},
            ) as response:
                if response.status_code >= 400:
                    body = (await response.aread()).decode(errors="replace")
                    raise ExternalServiceBlocked(
                        kind=(
                            "authentication"
                            if response.status_code in {401, 403}
                            else "pilo_external"
                        ),
                        endpoint=path,
                        status_code=response.status_code,
                        detail=body,
                    )
                response.raise_for_status()
                async for item in parse_sse(response.aiter_lines()):
                    visible_events.append(item)
                    if item["event"] == "token":
                        text_parts.append(_visible_token_text(item.get("data")))
                    elif item["event"] in {"action_run", "action-start", "action_start"}:
                        action_run = _first_mapping(item.get("data"))
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise ExternalServiceBlocked(kind="network", endpoint=path, detail=str(exc)) from exc
        return action_run, visible_events, "".join(text_parts)

    async def wait_for_visible_state(
        self,
        user_id: str,
        run_id: str,
        *,
        after_sequence: int = 0,
        timeout_seconds: float = 180.0,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        path = f"/api/v2/agent/runs/{run_id}/events/stream?after={after_sequence}"
        events: list[dict[str, Any]] = []
        try:
            async with asyncio.timeout(timeout_seconds):
                async with self.client.stream(
                    "GET", path, headers=self.headers(user_id)
                ) as response:
                    if response.status_code in EXTERNAL_HTTP_STATUSES:
                        body = (await response.aread()).decode(errors="replace")
                        raise ExternalServiceBlocked(
                            kind="sse_external",
                            endpoint=path,
                            status_code=response.status_code,
                            detail=body,
                        )
                    response.raise_for_status()
                    async for item in parse_sse(response.aiter_lines()):
                        visible_event = item["data"]
                        events.append(visible_event)
                        if visible_event.get("type") in {
                            "approval.requested",
                            "run.completed",
                            "run.failed",
                            "run.rejected",
                            "run.cancelled",
                            "run.rolled_back",
                        } or (
                            visible_event.get("type") == "run.transitioned"
                            and (visible_event.get("detail") or {}).get("to") in WAITING_OR_TERMINAL
                        ):
                            break
        except TimeoutError as exc:
            raise ExternalServiceBlocked(
                kind="timeout",
                endpoint=path,
                detail=f"no visible terminal state after {timeout_seconds}s",
            ) from exc
        detail = await self.request("GET", f"/api/v2/agent/runs/{run_id}", user_id)
        if detail.get("status") not in WAITING_OR_TERMINAL:
            raise ExternalServiceBlocked(
                kind="incomplete_runtime",
                endpoint=f"/api/v2/agent/runs/{run_id}",
                detail=f"SSE stopped at non-actionable status {detail.get('status')}",
            )
        return detail, events


def visible_projection(run: dict[str, Any] | list[Any] | None) -> dict[str, Any]:
    """The only run fields the dynamic response policy is allowed to inspect."""

    run = _first_mapping(run) or {}
    approval = next(
        (item for item in reversed(run.get("approvals") or []) if item.get("status") == "pending"),
        None,
    )
    return {
        "status": run.get("status"),
        "error": run.get("error"),
        "result_summary": (run.get("result") or {}).get("summary"),
        "event_summaries": [
            item.get("summary") for item in run.get("events") or [] if item.get("summary")
        ],
        "approval_summary": ((approval or {}).get("change_set") or {}).get("summary"),
        "approval": approval,
    }


def choose_follow_up(
    rules: Iterable[dict[str, Any]],
    visible: dict[str, Any],
    *,
    used_messages: set[str] | None = None,
) -> str | None:
    text = " ".join(
        str(item)
        for item in [
            visible.get("error"),
            visible.get("result_summary"),
            visible.get("approval_summary"),
        ]
        + list(visible.get("event_summaries") or [])
        if item
    ).lower()
    for rule in rules:
        status_matches = not rule.get("when_status") or visible.get("status") in rule["when_status"]
        contains = str(rule.get("when_contains", "")).lower()
        message = str(rule["message"])
        if (
            status_matches
            and (not contains or contains in text)
            and message not in (used_messages or set())
        ):
            return message
    return None


def _merge_patch(target: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(target)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge_patch(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


class BlackboxRunner:
    def __init__(
        self,
        api: PiloHttpClient,
        artifacts: JsonlArtifactStore,
        *,
        run_id: str,
        resume_command: str,
        max_conversation_turns: int = 4,
        concurrency: int = 4,
    ) -> None:
        self.api = api
        self.artifacts = artifacts
        self.run_id = run_id
        self.resume_command = resume_command
        self.max_conversation_turns = max_conversation_turns
        self.concurrency = max(1, concurrency)

    async def _snapshot(self, case: BlackboxCase) -> dict[str, Any] | None:
        if not case.readback_paths:
            return None
        return {
            path: await self.api.request("GET", path, case.user_id) for path in case.readback_paths
        }

    async def _run_turn(
        self, case: BlackboxCase, message: str
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        action_run, pilo_events, pilo_text = await self.api.stream_pilo(
            case.user_id,
            message=message,
            goal_id=case.goal_id,
            session_id=f"synthetic-v1-{self.run_id}-{case.case_id}",
        )
        if action_run and action_run.get("id"):
            detail, runtime_events = await self.api.wait_for_visible_state(
                case.user_id, str(action_run["id"])
            )
            detail["pilo_visible_text"] = pilo_text
            detail["pilo_stream"] = pilo_events
            return detail, runtime_events
        # Advice/status turns are genuine Pilo conversations with no Action Run.
        return {
            "id": None,
            "status": "completed",
            "result": {"summary": pilo_text},
            "events": [],
            "approvals": [],
            "pilo_visible_text": pilo_text,
            "pilo_stream": pilo_events,
        }, []

    async def run_case(self, case: BlackboxCase) -> dict[str, Any]:
        record: dict[str, Any] = {
            "schema_version": "synthetic-blackbox-case.v1",
            "run_id": self.run_id,
            "case_id": case.case_id,
            "user_id": case.user_id,
            "goal_id": case.goal_id,
            "intent_id": case.intent_id,
            "repetition": case.repetition,
            "variant": case.variant,
            "difficulty": case.difficulty,
            "seed": case.seed,
            "decision": case.decision,
            "expected": case.expected,
            "outcome_contract": case.outcome_contract,
            "session_id": f"synthetic-v1-{self.run_id}-{case.case_id}",
            "started_at": utc_iso(),
            "turns": [],
        }
        record["readback_before"] = await self._snapshot(case)
        if case.target_task_title and isinstance(record["readback_before"], dict):
            tasks = record["readback_before"].get("/api/v1/tasks") or []
            matches = [
                task
                for task in tasks
                if isinstance(task, dict)
                and task.get("title") == case.target_task_title
                and (not case.goal_id or task.get("goalId") == case.goal_id)
            ]
            record["pre_run_observable_facts"] = {
                "target_task_title": case.target_task_title,
                "task_match_count": len(matches),
                "task_match_ids": [task.get("id") for task in matches],
                "source": "authenticated GET /api/v1/tasks before Pilo turn",
            }
        message: str | None = case.prompt
        sent_messages: set[str] = set()
        for _ in range(self.max_conversation_turns):
            if not message:
                break
            if message in sent_messages:
                record["simulator_termination"] = {
                    "reason": "simulator_duplicate_follow_up",
                    "message": message,
                }
                break
            sent_messages.add(message)
            detail, streamed = await self._run_turn(case, message)
            visible = visible_projection(detail)
            record["turns"].append(
                {"user_message": message, "run": detail, "events": streamed, "visible": visible}
            )
            if detail.get("status") == "waiting_approval":
                record["readback_after_preview"] = await self._snapshot(case)
                cursor = max(
                    (int(item.get("sequence") or 0) for item in detail.get("events") or []),
                    default=0,
                )
                decision_result = await self._decide(case, detail)
                if decision_result is not None:
                    record["turns"][-1]["decision_result"] = decision_result
                    record["readback_after_execution"] = await self._snapshot(case)
                    # A high-risk preview needs a distinct second user confirmation.
                    # The first approval attempt is therefore a safe, visible preview
                    # outcome rather than an infrastructure exception or a write.
                    break
                if case.decision == "observe":
                    break
                previous_detail = detail
                detail, streamed = await self.api.wait_for_visible_state(
                    case.user_id, detail["id"], after_sequence=cursor
                )
                detail = _preserve_visible_projection(previous_detail, detail)
                record["turns"][-1]["run"] = detail
                record["turns"][-1]["events"].extend(streamed)
                record["readback_after_execution"] = await self._snapshot(case)
                if case.decision == "undo" and detail.get("status") == "completed":
                    undo_detail = await self.api.request(
                        "POST", f"/api/v2/agent/runs/{detail['id']}/undo", case.user_id, json={}
                    )
                    detail = _preserve_visible_projection(detail, undo_detail)
                    record["turns"][-1]["run"] = detail
                    record["readback_after_undo"] = await self._snapshot(case)
            message = choose_follow_up(
                case.follow_up_rules,
                visible_projection(detail),
            )
            if message is None and case.follow_up_rules:
                record["simulator_termination"] = {
                    "reason": "follow_up_rules_exhausted",
                    "sent_message_count": len(sent_messages),
                }
        record["finished_at"] = utc_iso()
        record["status"] = "completed"
        scoring = score_case(record)
        record["scoring"] = scoring
        record.update({"score": scoring["score"], "hard_gate_pass": scoring["hard_gate_pass"]})
        return record

    async def _decide(
        self, case: BlackboxCase, detail: dict[str, Any]
    ) -> dict[str, Any] | None:
        approval = visible_projection(detail)["approval"]
        if not approval or case.decision == "observe":
            return None
        root = f"/api/v2/agent/runs/{detail['id']}"
        if case.decision == "reject":
            await self.api.request(
                "POST",
                f"{root}/reject",
                case.user_id,
                json={"approval_id": approval["id"], "reason": "评测用户拒绝"},
            )
            return None
        if case.decision == "cancel":
            await self.api.request("POST", f"{root}/cancel", case.user_id, json={})
            return None
        if case.decision == "edit_then_approve":
            edited = _merge_patch(approval["change_set"], case.edit_patch or {})
            detail = await self.api.request(
                "PATCH",
                f"{root}/approvals/{approval['id']}",
                case.user_id,
                json={"change_set": edited},
            )
            approval = visible_projection(detail)["approval"]
        if case.decision in {"approve", "edit_then_approve", "undo"}:
            try:
                await self.api.request(
                    "POST",
                    f"{root}/approve",
                    case.user_id,
                    json={
                        "approval_id": approval["id"],
                        "change_hash": approval["change_hash"],
                        "change_set_version": approval["change_set_version"],
                        "run_state_version": approval["run_state_version"],
                        "high_risk_confirmed": bool(case.expected.get("high_risk_confirmed")),
                    },
                )
            except httpx.HTTPStatusError as exc:
                response_text = exc.response.text
                if exc.response.status_code == 409 and "高风险变更需要二次确认" in response_text:
                    return {
                        "outcome": "high_risk_confirmation_required",
                        "status_code": 409,
                        "visible_message": "高风险变更需要二次确认",
                        "write_attempted": False,
                    }
                raise
        return None

    async def run(self, cases: list[BlackboxCase]) -> dict[str, Any]:
        completed_ids = self.artifacts.completed_case_ids()
        pending = [case for case in cases if case.case_id not in completed_ids]
        by_user: dict[str, list[BlackboxCase]] = {}
        for case in pending:
            by_user.setdefault(case.user_id, []).append(case)
        queue: asyncio.Queue[tuple[str, list[BlackboxCase]]] = asyncio.Queue()
        for item in by_user.items():
            queue.put_nowait(item)
        progress_lock = asyncio.Lock()
        stop = asyncio.Event()
        completed_count = len(completed_ids)
        blocker: dict[str, Any] | None = None
        blocked_case_id: str | None = None

        async def worker() -> None:
            nonlocal completed_count, blocker, blocked_case_id
            while not queue.empty() and not stop.is_set():
                try:
                    _, user_cases = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                try:
                    for case in user_cases:
                        if stop.is_set():
                            return
                        async with progress_lock:
                            self.artifacts.write_checkpoint(
                                next_case_id=case.case_id,
                                completed=completed_count,
                                blocker=None,
                                resume_command=self.resume_command,
                            )
                        try:
                            record = await self.run_case(case)
                        except asyncio.CancelledError:
                            # Cancellation may arrive while an SSE stream or
                            # approval call is in flight. Persist the exact
                            # current case as the resume boundary, but do not
                            # append a terminal case record: a restart will
                            # retry it exactly once from the checkpoint.
                            async with progress_lock:
                                self.artifacts.write_checkpoint(
                                    next_case_id=case.case_id,
                                    completed=completed_count,
                                    blocker={
                                        "kind": "cancelled",
                                        "case_id": case.case_id,
                                        "detected_at": utc_iso(),
                                    },
                                    resume_command=self.resume_command,
                                )
                            raise
                        except ExternalServiceBlocked as exc:
                            blocker = exc.payload
                            blocked_case_id = case.case_id
                            record = {
                                "schema_version": "synthetic-blackbox-case.v1",
                                "run_id": self.run_id,
                                "case_id": case.case_id,
                                "user_id": case.user_id,
                                "intent_id": case.intent_id,
                                "status": "blocked",
                                "blocker": exc.payload,
                                "finished_at": utc_iso(),
                                "hard_gate_pass": False,
                            }
                            stop.set()
                        except Exception as exc:
                            error: dict[str, Any] = {
                                "kind": type(exc).__name__,
                                "detail": str(exc)[:1000],
                            }
                            if isinstance(exc, httpx.HTTPStatusError):
                                error.update(
                                    endpoint=str(exc.request.url),
                                    status_code=exc.response.status_code,
                                    response=exc.response.text[:1000],
                                )
                            record = {
                                "schema_version": "synthetic-blackbox-case.v1",
                                "run_id": self.run_id,
                                "case_id": case.case_id,
                                "user_id": case.user_id,
                                "intent_id": case.intent_id,
                                "status": "failed",
                                "error": error,
                                "finished_at": utc_iso(),
                                "hard_gate_pass": False,
                                "score": 0.0,
                            }
                        async with progress_lock:
                            self.artifacts.append_case(record)
                            completed_count += 1
                            self.artifacts.write_checkpoint(
                                next_case_id=case.case_id if stop.is_set() else None,
                                completed=completed_count,
                                blocker=blocker,
                                resume_command=self.resume_command,
                            )
                finally:
                    queue.task_done()

        await asyncio.gather(*(worker() for _ in range(min(self.concurrency, len(by_user)))))
        if blocker:
            return {"status": "blocked", "blocker": blocker, "case_id": blocked_case_id}
        return self.artifacts.finalize(case.case_id for case in cases)
