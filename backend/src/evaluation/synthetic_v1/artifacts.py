"""Durable, resumable artifacts for the synthetic-v1 black-box evaluation.

The artifact layer deliberately knows nothing about PlanPilot's database.  A case is
complete only after its final JSONL record is fsynced; a separate checkpoint makes an
external outage actionable without pretending that the remaining cases ran.
"""

from __future__ import annotations

import json
import os
import tempfile
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

FINAL_CASE_STATUSES = {"completed", "failed", "skipped"}


def utc_iso() -> str:
    return datetime.now(UTC).isoformat()


def read_jsonl(path: str | Path) -> list[dict[str, Any]]:
    source = Path(path)
    if not source.exists():
        return []
    rows: list[dict[str, Any]] = []
    with source.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSONL at {source}:{number}: {exc.msg}") from exc
            if not isinstance(value, dict):
                raise ValueError(f"JSONL record at {source}:{number} must be an object")
            rows.append(value)
    return rows


class JsonlArtifactStore:
    """Append-only case store with crash-safe checkpoints and resume semantics."""

    def __init__(self, output_dir: str | Path, run_id: str) -> None:
        self.output_dir = Path(output_dir)
        self.run_id = run_id
        self.cases_path = self.output_dir / "cases.jsonl"
        self.failures_path = self.output_dir / "failures.jsonl"
        self.checkpoint_path = self.output_dir / "checkpoint.json"
        self.summary_path = self.output_dir / "summary.json"

    def append_case(self, record: dict[str, Any]) -> None:
        if record.get("run_id") != self.run_id:
            raise ValueError("artifact run_id does not match store run_id")
        if not record.get("case_id"):
            raise ValueError("case_id is required")
        self._append(self.cases_path, record)
        if record.get("status") in {"failed", "blocked"} or record.get("hard_gate_pass") is False:
            self._append(self.failures_path, record)

    def completed_case_ids(self) -> set[str]:
        return {
            str(row["case_id"])
            for row in read_jsonl(self.cases_path)
            if row.get("status") in FINAL_CASE_STATUSES and row.get("case_id")
        }

    def prepare_retry(self, case_ids: Iterable[str]) -> int:
        """Archive and remove selected records before a real rerun."""
        ids = set(case_ids)
        if not ids:
            return 0
        rows = read_jsonl(self.cases_path)
        selected = [row for row in rows if row.get("case_id") in ids]
        if selected:
            archive = self.output_dir / "retry_archive.jsonl"
            archived_ids = {row.get("case_id") for row in read_jsonl(archive)}
            for row in selected:
                if row.get("case_id") in archived_ids:
                    continue
                self._append(archive, row)
        kept = [row for row in rows if row.get("case_id") not in ids]
        self.cases_path.write_text(
            "".join(
                json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
                for row in kept
            ),
            encoding="utf-8",
        )
        failures = [row for row in read_jsonl(self.failures_path) if row.get("case_id") not in ids]
        self.failures_path.write_text(
            "".join(
                json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
                for row in failures
            ),
            encoding="utf-8",
        )
        return len(selected)

    def write_checkpoint(
        self,
        *,
        next_case_id: str | None,
        completed: int,
        blocker: dict[str, Any] | None = None,
        resume_command: str | None = None,
    ) -> dict[str, Any]:
        payload = {
            "schema_version": "synthetic-blackbox-checkpoint.v1",
            "run_id": self.run_id,
            "updated_at": utc_iso(),
            "completed_cases": completed,
            "next_case_id": next_case_id,
            "blocker": blocker,
            "resume_command": resume_command,
        }
        self._atomic_json(self.checkpoint_path, payload)
        return payload

    def finalize(self, expected_case_ids: Iterable[str]) -> dict[str, Any]:
        expected = list(expected_case_ids)
        latest: dict[str, dict[str, Any]] = {}
        for row in read_jsonl(self.cases_path):
            latest[str(row.get("case_id"))] = row
        rows = [latest[item] for item in expected if item in latest]
        by_intent: dict[str, Counter[str]] = defaultdict(Counter)
        statuses: Counter[str] = Counter()
        hard_gate_failures = 0
        scores: list[float] = []
        for row in rows:
            status = str(row.get("status", "unknown"))
            intent = str(row.get("intent_id", "unknown"))
            statuses[status] += 1
            by_intent[intent][status] += 1
            if row.get("hard_gate_pass") is False:
                hard_gate_failures += 1
            if isinstance(row.get("score"), (int, float)):
                scores.append(float(row["score"]))
        summary = {
            "schema_version": "synthetic-blackbox-summary.v1",
            "run_id": self.run_id,
            "generated_at": utc_iso(),
            "expected_cases": len(expected),
            "recorded_cases": len(rows),
            "missing_case_ids": [item for item in expected if item not in latest],
            "status_counts": dict(statuses),
            "hard_gate_failures": hard_gate_failures,
            "mean_score": round(sum(scores) / len(scores), 4) if scores else None,
            "by_intent": {key: dict(value) for key, value in sorted(by_intent.items())},
        }
        self._atomic_json(self.summary_path, summary)
        return summary

    @staticmethod
    def _append(path: Path, value: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with path.open("a", encoding="utf-8") as handle:
            handle.write(data + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    @staticmethod
    def _atomic_json(path: Path, value: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
