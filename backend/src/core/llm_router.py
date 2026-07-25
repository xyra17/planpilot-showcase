"""PlanPilot 的生成模型路由。

日常任务优先使用本地 MLX 模型，调用失败时自动回退 DeepSeek Flash；
复杂重规划与最终审核显式使用 DeepSeek Pro。
"""

import logging
import threading
import time
from collections import Counter
from collections.abc import Sequence
from typing import Any
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler
from langchain_openai import ChatOpenAI

from src.config import settings

logger = logging.getLogger(__name__)


class LocalModelCircuitBreaker:
    """进程内熔断器：连续失败后暂时跳过本地模型。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._consecutive_failures = 0
        self._opened_at: float | None = None

    def allow_request(self) -> bool:
        with self._lock:
            if self._opened_at is None:
                return True
            elapsed = time.monotonic() - self._opened_at
            if elapsed >= settings.local_model_circuit_cooldown_seconds:
                # 冷却结束后放行一次探测请求。
                self._opened_at = None
                self._consecutive_failures = 0
                return True
            return False

    def record_success(self) -> None:
        with self._lock:
            self._consecutive_failures = 0
            self._opened_at = None

    def record_failure(self) -> None:
        with self._lock:
            self._consecutive_failures += 1
            if self._consecutive_failures >= settings.local_model_failure_threshold:
                self._opened_at = time.monotonic()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            remaining = 0.0
            if self._opened_at is not None:
                remaining = max(
                    0.0,
                    settings.local_model_circuit_cooldown_seconds
                    - (time.monotonic() - self._opened_at),
                )
            return {
                "state": "open" if self._opened_at is not None else "closed",
                "consecutive_failures": self._consecutive_failures,
                "cooldown_remaining_seconds": round(remaining, 1),
            }

    def reset(self) -> None:
        with self._lock:
            self._consecutive_failures = 0
            self._opened_at = None


class ModelMetrics:
    """不记录 prompt/response 的轻量进程内指标。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counts: Counter[str] = Counter()
        self._latency_total_ms: Counter[str] = Counter()

    def record(self, route: str, outcome: str, elapsed_ms: float) -> None:
        with self._lock:
            self._counts[f"{route}.{outcome}"] += 1
            self._latency_total_ms[route] += elapsed_ms

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            routes: dict[str, Any] = {}
            for route in ("local", "flash", "pro"):
                success = self._counts[f"{route}.success"]
                failure = self._counts[f"{route}.failure"]
                total = success + failure
                routes[route] = {
                    "requests": total,
                    "successes": success,
                    "failures": failure,
                    "average_latency_ms": (
                        round(self._latency_total_ms[route] / total, 1) if total else None
                    ),
                }
            return routes

    def reset(self) -> None:
        with self._lock:
            self._counts.clear()
            self._latency_total_ms.clear()


local_circuit = LocalModelCircuitBreaker()
model_metrics = ModelMetrics()


class _RouteMetricsCallback(BaseCallbackHandler):
    def __init__(self, route: str) -> None:
        self.route = route
        self._started: dict[UUID, float] = {}
        self._lock = threading.Lock()

    def _start(self, run_id: UUID) -> None:
        with self._lock:
            self._started[run_id] = time.monotonic()

    def on_llm_start(
        self, serialized: dict[str, Any], prompts: list[str], *, run_id: UUID, **kwargs: Any
    ) -> None:
        self._start(run_id)

    def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[Any]],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        self._start(run_id)

    def _finish(self, run_id: UUID, outcome: str) -> None:
        with self._lock:
            started = self._started.pop(run_id, time.monotonic())
        elapsed_ms = (time.monotonic() - started) * 1000
        model_metrics.record(self.route, outcome, elapsed_ms)
        if self.route == "local":
            if outcome == "success":
                local_circuit.record_success()
            else:
                local_circuit.record_failure()
        logger.info(
            "llm_call route=%s outcome=%s elapsed_ms=%.1f",
            self.route,
            outcome,
            elapsed_ms,
        )

    def on_llm_end(self, response: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._finish(run_id, "success")

    def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._finish(run_id, "failure")


def _local_llm(**kwargs: Any) -> ChatOpenAI:
    return ChatOpenAI(
        model=settings.model_name,
        api_key=settings.openai_api_key or "local",
        base_url=settings.openai_base_url or None,
        timeout=settings.local_model_timeout_seconds,
        max_retries=0,
        extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        callbacks=[_RouteMetricsCallback("local")],
        **kwargs,
    )


def _flash_llm(**kwargs: Any) -> ChatOpenAI:
    return ChatOpenAI(
        model=settings.smart_model_name,
        api_key=settings.smart_api_key,
        base_url=settings.smart_base_url or None,
        callbacks=[_RouteMetricsCallback("flash")],
        **kwargs,
    )


def create_routine_llm(*, tools: Sequence[Any] | None = None, **kwargs: Any) -> Any:
    """创建“本地优先、Flash 回退”的日常任务模型。"""
    candidates: list[Any] = []
    if (
        settings.local_model_enabled
        and settings.openai_base_url
        and local_circuit.allow_request()
    ):
        candidates.append(_local_llm(**kwargs))
    if settings.smart_api_key and settings.smart_model_name:
        candidates.append(_flash_llm(**kwargs))
    if not candidates:
        raise RuntimeError("没有可用的日常模型：请配置本地模型或 DeepSeek Flash")

    if tools:
        candidates = [candidate.bind_tools(tools) for candidate in candidates]

    primary, *fallbacks = candidates
    return primary.with_fallbacks(fallbacks) if fallbacks else primary


def create_structured_routine_llm(**kwargs: Any) -> Any:
    """创建强制返回单个 JSON 对象的日常模型。"""
    model_kwargs = dict(kwargs.pop("model_kwargs", {}))
    model_kwargs["response_format"] = {"type": "json_object"}
    return create_routine_llm(model_kwargs=model_kwargs, **kwargs)


def create_pro_llm(**kwargs: Any) -> ChatOpenAI:
    """创建仅用于复杂重规划和最终质量审核的 DeepSeek Pro。"""
    if not settings.smart_api_key or not settings.smart_pro_model_name:
        raise RuntimeError("DeepSeek Pro 未配置")
    return ChatOpenAI(
        model=settings.smart_pro_model_name,
        api_key=settings.smart_api_key,
        base_url=settings.smart_base_url or None,
        callbacks=[_RouteMetricsCallback("pro")],
        **kwargs,
    )


def get_llm_runtime_status() -> dict[str, Any]:
    return {
        "local_enabled": settings.local_model_enabled,
        "local_base_url_configured": bool(settings.openai_base_url),
        "circuit": local_circuit.snapshot(),
        "metrics": model_metrics.snapshot(),
    }
