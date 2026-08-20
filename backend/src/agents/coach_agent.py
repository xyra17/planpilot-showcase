"""LLM-backed coach runtime with deterministic action guardrails."""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any, Literal

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from src.config import settings
from src.core.llm_router import create_structured_routine_llm
from src.core.model_gateway import ModelGateway, ModelGatewayError

logger = logging.getLogger(__name__)
PROMPT_VERSION = "coach-v2"


class CoachNarrative(BaseModel):
    proposal_type: Literal["reschedule_overdue_tasks", "reduce_daily_load", "learning_nudge"]
    title: str = Field(min_length=1, max_length=200)
    summary: str = Field(min_length=1, max_length=2000)
    reasoning: list[str] = Field(min_length=1, max_length=5)


@dataclass(frozen=True)
class CoachAgentResult:
    title: str
    summary: str
    reasoning: list[str]
    model_name: str | None
    trace: dict[str, Any]


class CoachAgent:
    """Generates user-facing reasoning while deterministic code owns mutations."""

    @staticmethod
    def recommend_action(context: dict[str, Any]) -> str:
        goal_context = context.get("goal_context") or {}
        if goal_context.get("overdue_tasks"):
            return "reschedule_overdue_tasks"
        profile = context.get("profile") or {}
        if (
            goal_context.get("goal")
            and isinstance(profile.get("completion_rate_30d"), (int, float))
            and profile["completion_rate_30d"] < 0.7
        ):
            return "reduce_daily_load"
        return "learning_nudge"

    @staticmethod
    def preferred_window(context: dict[str, Any]) -> str | None:
        for pattern in context.get("active_patterns", []):
            if pattern.get("pattern_type") != "preferred_learning_time":
                continue
            hours = (pattern.get("pattern_value") or {}).get("peak_hours", [])
            if hours and isinstance(hours[0], (int, float)):
                return f"{int(hours[0]):02d}:00 左右"
        return None

    @classmethod
    async def generate(
        cls,
        context: dict[str, Any],
        *,
        expected_type: str,
        fallback_title: str,
        fallback_summary: str,
        fallback_reasoning: list[str],
        system_template: str | None = None,
        prompt_version: str = PROMPT_VERSION,
        model_provider: str = "configured-router",
        model_name: str | None = None,
        temperature: float = 0.2,
        max_tokens: int = 700,
        timeout_ms: int | None = None,
        retry_policy: dict[str, Any] | None = None,
    ) -> CoachAgentResult:
        trace_id = uuid.uuid4().hex
        started = time.monotonic()
        if not settings.coach_agent_enabled:
            return cls._fallback(
                trace_id,
                started,
                fallback_title,
                fallback_summary,
                fallback_reasoning,
                reason="disabled",
                prompt_version=prompt_version,
            )

        safe_context = {
            "profile": context.get("profile"),
            "cognitive_profile": context.get("cognitive_profile"),
            "memories": context.get("memories"),
            "knowledge_gaps": context.get("knowledge_gaps"),
            "active_patterns": context.get("active_patterns", []),
            "recent_events": context.get("recent_events", [])[:10],
            "goal_context": context.get("goal_context"),
            "data_quality": context.get("data_quality"),
        }
        system_content = (
            system_template
            or (
                "你是 PlanPilot 学习伙伴。只根据提供的行为证据解释建议，"
                "不得编造数据，不得声称已经修改计划。只输出一个 JSON 对象，字段为 "
                "proposal_type、title、summary、reasoning。proposal_type 必须严格等于 "
                "{expected_type}；reasoning 为 1 到 5 条简短中文理由。"
            )
        ).replace("{expected_type}", expected_type)
        messages = [
            SystemMessage(content=system_content),
            HumanMessage(content=json.dumps(safe_context, ensure_ascii=False, default=str)),
        ]
        prompt_render_hash = hashlib.sha256(
            json.dumps(
                [message.content for message in messages],
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        try:
            llm = create_structured_routine_llm(
                provider=model_provider,
                model_name=model_name,
                timeout_ms=timeout_ms,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            timeout_seconds = (timeout_ms or 60000) / 1000
            gateway_result = await ModelGateway.invoke(
                messages,
                primary=llm,
                primary_route=f"{model_provider}:{model_name or 'default'}",
                timeout_seconds=timeout_seconds,
                max_retries=int(
                    (retry_policy or {}).get(
                        "gateway_max_retries", settings.model_gateway_max_retries
                    )
                ),
                fallback_factory=(
                    (
                        lambda: create_structured_routine_llm(
                            provider="configured-router",
                            temperature=temperature,
                            max_tokens=max_tokens,
                        )
                    )
                    if model_provider not in {"configured-router", None}
                    else None
                ),
            )
            response = gateway_result.response
            raw = response.content
            if not isinstance(raw, str):
                raise ValueError("coach response content is not text")
            start = raw.find("{")
            end = raw.rfind("}") + 1
            if start < 0 or end <= start:
                raise ValueError("coach response does not contain JSON")
            narrative = CoachNarrative.model_validate_json(raw[start:end])
            if narrative.proposal_type != expected_type:
                raise ValueError("coach proposed an action outside deterministic policy")
            metadata = response.response_metadata or {}
            usage = getattr(response, "usage_metadata", None) or metadata.get("token_usage") or {}
            model_name = str(metadata.get("model_name") or metadata.get("model") or "") or None
            trace = {
                "trace_id": trace_id,
                "prompt_version": prompt_version,
                "prompt_render_hash": prompt_render_hash,
                "runtime": "llm",
                "success": True,
                "fallback": gateway_result.fallback_used,
                "gateway_route": gateway_result.route,
                "gateway_attempts": [row.to_dict() for row in gateway_result.attempts],
                "expected_type": expected_type,
                "model_name": model_name,
                "latency_ms": round((time.monotonic() - started) * 1000, 1),
                "token_usage": {
                    "input_tokens": usage.get("input_tokens") or usage.get("prompt_tokens"),
                    "output_tokens": usage.get("output_tokens") or usage.get("completion_tokens"),
                    "total_tokens": usage.get("total_tokens"),
                },
            }
            logger.info("coach_agent_completed trace=%s", trace)
            return CoachAgentResult(
                title=narrative.title,
                summary=narrative.summary,
                reasoning=narrative.reasoning,
                model_name=model_name,
                trace=trace,
            )
        except Exception as exc:
            logger.warning(
                "coach_agent_fallback trace_id=%s error_type=%s",
                trace_id,
                type(exc).__name__,
            )
            return cls._fallback(
                trace_id,
                started,
                fallback_title,
                fallback_summary,
                fallback_reasoning,
                reason=(
                    exc.attempts[-1].error_category
                    if isinstance(exc, ModelGatewayError) and exc.attempts
                    else type(exc).__name__
                ),
                prompt_version=prompt_version,
                prompt_render_hash=prompt_render_hash,
            )

    @staticmethod
    def _fallback(
        trace_id: str,
        started: float,
        title: str,
        summary: str,
        reasoning: list[str],
        *,
        reason: str,
        prompt_version: str = PROMPT_VERSION,
        prompt_render_hash: str | None = None,
    ) -> CoachAgentResult:
        return CoachAgentResult(
            title=title,
            summary=summary,
            reasoning=reasoning,
            model_name=None,
            trace={
                "trace_id": trace_id,
                "prompt_version": prompt_version,
                "prompt_render_hash": prompt_render_hash,
                "runtime": "deterministic_fallback",
                "success": False,
                "fallback": True,
                "fallback_reason": reason,
                "latency_ms": round((time.monotonic() - started) * 1000, 1),
            },
        )
