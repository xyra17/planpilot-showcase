"""Judge frozen v20 inputs with nullable, applicability-aware dimensions."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.core.llm_router import create_json_llm
from src.evaluation.synthetic_v1.artifacts import read_jsonl, utc_iso
from src.evaluation.synthetic_v1.v19 import _judge_response_text
from src.evaluation.synthetic_v1.v20 import (
    DIMENSIONS,
    V20_JUDGE_PROMPT_HASH,
    V20_JUDGE_PROMPT_VERSION,
    V20_JUDGE_SYSTEM_PROMPT,
    parse_v20_judge_payload,
    privacy_findings,
)


def dump(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--provider", choices=("local", "smart"), default="local")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--max-tokens", type=int, default=260)
    parser.add_argument("--retry-failures", action="store_true")
    args = parser.parse_args()
    inputs = read_jsonl(args.input / "judge_inputs.v20.jsonl")
    if privacy_findings(inputs):
        raise RuntimeError("v20 judge input privacy scan failed")
    output = args.input / "judge-v20.jsonl"
    existing = read_jsonl(output)
    if args.retry_failures:
        failed = [row for row in existing if row.get("status") != "completed"]
        if failed:
            archive = args.input / "judge-v20-retry-archive.jsonl"
            with archive.open("a", encoding="utf-8") as handle:
                for row in failed:
                    handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
            existing = [row for row in existing if row.get("status") == "completed"]
            output.write_text(
                "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in existing),
                encoding="utf-8",
            )
    completed = {str(row["case_id"]) for row in existing if row.get("status") == "completed"}
    pending = [row for row in inputs if str(row["case_id"]) not in completed]
    semaphore = asyncio.Semaphore(max(1, args.concurrency))
    lock = asyncio.Lock()

    async def one(judge_input: dict[str, Any]) -> None:
        failures = []
        result: dict[str, Any] | None = None
        async with semaphore:
            for attempt in range(1, 4):
                try:
                    llm = create_json_llm(
                        provider=args.provider,
                        timeout_ms=120_000,
                        temperature=0,
                        max_tokens=args.max_tokens,
                    )
                    response = await llm.ainvoke(
                        [
                            SystemMessage(content=V20_JUDGE_SYSTEM_PROMPT),
                            HumanMessage(content=json.dumps(judge_input, ensure_ascii=False)),
                        ]
                    )
                    payload = parse_v20_judge_payload(
                        _judge_response_text(response.content),
                        judge_input["dimension_applicability"],
                    )
                    metadata = dict(response.response_metadata or {})
                    result = {
                        "case_id": judge_input["case_id"],
                        "status": "completed",
                        "judge_model": metadata.get("model_name") or metadata.get("model") or "unknown",
                        "judge_provider": args.provider,
                        "prompt_version": V20_JUDGE_PROMPT_VERSION,
                        "prompt_hash": V20_JUDGE_PROMPT_HASH,
                        "input_hash": hashlib.sha256(json.dumps(judge_input, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
                        "attempts": attempt,
                        "retry_failures": failures,
                        "scores": payload["scores"],
                        "reasons": payload["reasons"],
                        "overall_reason": payload["overall_reason"],
                        "usage": dict(getattr(response, "usage_metadata", None) or {}),
                    }
                    break
                except Exception as exc:
                    failures.append({"attempt": attempt, "kind": type(exc).__name__, "detail": str(exc)[:500]})
            if result is None:
                result = {
                    "case_id": judge_input["case_id"], "status": "failed",
                    "judge_provider": args.provider, "attempts": 3, "retry_failures": failures,
                }
            async with lock:
                with output.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(result, ensure_ascii=False, sort_keys=True) + "\n")

    await asyncio.gather(*(one(row) for row in pending))
    latest = {str(row["case_id"]): row for row in read_jsonl(output)}
    final = [latest[str(row["case_id"])] for row in inputs]
    done = [row for row in final if row.get("status") == "completed"]
    dimensions: dict[str, list[int]] = defaultdict(list)
    applicability_counts = Counter()
    for row in done:
        for name in DIMENSIONS:
            score = (row.get("scores") or {}).get(name)
            if score is not None:
                dimensions[name].append(int(score))
                applicability_counts[name] += 1
    summary = {
        "schema_version": "synthetic-v20-judge-summary.v1",
        "generated_at": utc_iso(),
        "coverage": len(done),
        "failures": len(final) - len(done),
        "prompt_version": V20_JUDGE_PROMPT_VERSION,
        "prompt_hash": V20_JUDGE_PROMPT_HASH,
        "models": dict(Counter(row.get("judge_model") for row in done)),
        "attempts": sum(int(row.get("attempts") or 0) for row in final),
        "retry_count": sum(max(0, int(row.get("attempts") or 0) - 1) for row in final),
        "applicable_counts": dict(applicability_counts),
        "dimension_means": {
            name: round(sum(values) / len(values), 3) for name, values in dimensions.items()
        },
        "usage": {
            key: sum(int((row.get("usage") or {}).get(key) or 0) for row in done)
            for key in ("input_tokens", "output_tokens", "total_tokens")
        },
    }
    dump(args.input / "judge-v20-summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
