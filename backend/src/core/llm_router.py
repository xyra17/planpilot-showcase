"""PlanPilot generation-model roles and bounded, provider-neutral routing."""

import asyncio
import json
import logging
import threading
import time
from collections import Counter
from collections.abc import Sequence
from typing import Any
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.runnables import RunnableLambda
from langchain_openai import ChatOpenAI

from src.config import settings
from src.core.model_gateway import gateway_status
from src.services.runtime_model_config import RuntimeModelConfig, get_runtime_model_config

logger = logging.getLogger(__name__)


class ModelCircuitBreaker:
    """进程内熔断器：连续失败后暂时跳过对应模型。"""

    def __init__(self, *, failure_threshold_setting: str, cooldown_setting: str) -> None:
        self._lock = threading.Lock()
        self._consecutive_failures = 0
        self._opened_at: float | None = None
        self._failure_threshold_setting = failure_threshold_setting
        self._cooldown_setting = cooldown_setting

    @property
    def cooldown_seconds(self) -> float:
        return float(getattr(settings, self._cooldown_setting))

    @property
    def failure_threshold(self) -> int:
        return int(getattr(settings, self._failure_threshold_setting))

    def allow_request(self) -> bool:
        with self._lock:
            if self._opened_at is None:
                return True
            elapsed = time.monotonic() - self._opened_at
            if elapsed >= self.cooldown_seconds:
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
            if self._consecutive_failures >= self.failure_threshold:
                self._opened_at = time.monotonic()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            remaining = 0.0
            if self._opened_at is not None:
                remaining = max(
                    0.0,
                    self.cooldown_seconds - (time.monotonic() - self._opened_at),
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

    def record_quality_failure(self, route: str) -> None:
        with self._lock:
            self._counts[f"{route}.quality_failure"] += 1

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
                    "quality_failures": self._counts[f"{route}.quality_failure"],
                    "average_latency_ms": (
                        round(self._latency_total_ms[route] / total, 1) if total else None
                    ),
                }
            return routes

    def reset(self) -> None:
        with self._lock:
            self._counts.clear()
            self._latency_total_ms.clear()


local_circuit = ModelCircuitBreaker(
    failure_threshold_setting="local_model_failure_threshold",
    cooldown_setting="local_model_circuit_cooldown_seconds",
)
cloud_circuit = ModelCircuitBreaker(
    failure_threshold_setting="cloud_model_failure_threshold",
    cooldown_setting="cloud_model_circuit_cooldown_seconds",
)
model_metrics = ModelMetrics()
_route_semaphores: dict[tuple[str, int], asyncio.Semaphore] = {}


def _route_semaphore(route: str, limit: int) -> asyncio.Semaphore:
    """Return the limiter for new calls at the current runtime limit."""
    key = (route, limit)
    semaphore = _route_semaphores.get(key)
    if semaphore is None:
        semaphore = asyncio.Semaphore(limit)
        _route_semaphores[key] = semaphore
    return semaphore


def get_model_role_contracts(
    runtime: RuntimeModelConfig | None = None,
) -> dict[str, dict[str, Any]]:
    """Build the admin-facing routing map from the hot runtime configuration."""
    runtime = runtime or get_runtime_model_config()
    local_available = bool(
        runtime.local_enabled and runtime.local_base_url and runtime.local_model_name
    )
    cloud_available = bool(
        runtime.cloud_enabled
        and runtime.cloud_base_url
        and runtime.cloud_api_key
        and runtime.cloud_model_name
    )
    pro_available = bool(cloud_available and runtime.cloud_pro_model_name)
    embedding_available = bool(
        runtime.embedding_enabled and runtime.embedding_base_url and runtime.embedding_model_name
    )

    interactive_primary = (
        "cloud" if cloud_available else "local" if local_available else "unavailable"
    )
    interactive_model = (
        runtime.cloud_model_name
        if cloud_available
        else runtime.local_model_name
        if local_available
        else ""
    )
    interactive_fallback = "local" if local_available and cloud_available else None
    interactive_fallback_model = runtime.local_model_name if interactive_fallback else None
    interactive_limit = (
        runtime.cloud_routine_max_concurrency
        if cloud_available
        else runtime.local_max_concurrency
        if local_available
        else 0
    )

    structured_primary = (
        "cloud" if cloud_available else "local" if local_available else "unavailable"
    )
    structured_model = (
        runtime.cloud_model_name
        if cloud_available
        else runtime.local_model_name
        if local_available
        else ""
    )
    structured_fallback = "local" if cloud_available and local_available else None
    structured_fallback_model = runtime.local_model_name if structured_fallback else None
    structured_limit = (
        runtime.cloud_routine_max_concurrency
        if cloud_available
        else runtime.local_max_concurrency
        if local_available
        else 0
    )

    return {
        "interactive": {
            "purpose": "普通聊天、打卡回应、短解释和笔记辅助",
            "primary": interactive_primary,
            "primary_model": interactive_model,
            "fallback": interactive_fallback,
            "fallback_model": interactive_fallback_model,
            "fallback_policy": "云端模型断网、超时、限流、余额或服务异常时回退到本地模型",
            "result": "简短中文自然语言，可流式返回",
            "max_concurrency": interactive_limit,
        },
        "structured": {
            "purpose": "宏观计划、每日任务、验收出题、Agent 规划和建议 JSON",
            "primary": structured_primary,
            "primary_model": structured_model,
            "fallback": structured_fallback,
            "fallback_model": structured_fallback_model,
            "fallback_policy": "主模型不可用时回退；使用契约校验入口时，JSON 或业务契约失败也会换路重试一次",
            "result": "经过 JSON 或业务契约校验的结构化结果",
            "max_concurrency": structured_limit,
        },
        "critical": {
            "purpose": "学习答案评分和需要高质量终审的复杂决策",
            "primary": "cloud-pro" if pro_available else "unavailable",
            "primary_model": runtime.cloud_pro_model_name if pro_available else "",
            "fallback": None,
            "fallback_model": None,
            "fallback_policy": "不静默降级；调用失败时向上游返回明确错误",
            "result": "高质量判断；失败时显式报错，不静默降低模型等级",
            "max_concurrency": runtime.cloud_pro_max_concurrency if pro_available else 0,
        },
        "embedding": {
            "purpose": "知识库向量化和语义检索",
            "primary": "embedding-local" if embedding_available else "keyword-search",
            "primary_model": runtime.embedding_model_name if embedding_available else "",
            "fallback": "keyword-search" if embedding_available else None,
            "fallback_model": None,
            "fallback_policy": "Embedding 不可用或向量无有效结果时使用数据库原文包含匹配",
            "result": f"{runtime.embedding_dimensions} 维向量；不可用时退化为关键词检索",
            "max_concurrency": runtime.embedding_max_concurrency if embedding_available else 0,
        },
    }


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
        elif self.route in {"flash", "pro"}:
            if outcome == "success":
                cloud_circuit.record_success()
            else:
                cloud_circuit.record_failure()
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


def _local_llm(runtime: RuntimeModelConfig | None = None, **kwargs: Any) -> ChatOpenAI:
    runtime = runtime or get_runtime_model_config()
    return ChatOpenAI(
        model=runtime.local_model_name,
        api_key=runtime.local_api_key or "local",
        base_url=runtime.local_base_url or None,
        timeout=settings.local_model_timeout_seconds,
        max_retries=0,
        extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        callbacks=[_RouteMetricsCallback("local")],
        **kwargs,
    )


def _flash_llm(runtime: RuntimeModelConfig | None = None, **kwargs: Any) -> ChatOpenAI:
    runtime = runtime or get_runtime_model_config()
    return ChatOpenAI(
        model=runtime.cloud_model_name,
        api_key=runtime.cloud_api_key,
        base_url=runtime.cloud_base_url or None,
        timeout=settings.cloud_routine_timeout_seconds,
        max_retries=settings.cloud_model_max_retries,
        callbacks=[_RouteMetricsCallback("flash")],
        **kwargs,
    )


def _limit_concurrency(
    runnable: Any,
    *,
    semaphore: asyncio.Semaphore,
    queue_timeout_seconds: float,
    route: str,
) -> Any:
    """Bound one model role per process while preserving fallback semantics."""

    def invoke_sync(value: Any, config: Any = None) -> Any:
        return runnable.invoke(value, config=config)

    async def invoke_async(value: Any, config: Any = None) -> Any:
        try:
            await asyncio.wait_for(
                semaphore.acquire(),
                timeout=queue_timeout_seconds,
            )
        except TimeoutError:
            logger.warning(
                "llm_queue_timeout route=%s timeout_seconds=%.1f",
                route,
                queue_timeout_seconds,
            )
            raise
        try:
            return await runnable.ainvoke(value, config=config)
        finally:
            semaphore.release()

    return RunnableLambda(invoke_sync, afunc=invoke_async)


def _limit_local_concurrency(runnable: Any, limit: int | None = None) -> Any:
    return _limit_concurrency(
        runnable,
        semaphore=_route_semaphore(
            "local",
            limit if limit is not None else get_runtime_model_config().local_max_concurrency,
        ),
        queue_timeout_seconds=settings.local_model_queue_timeout_seconds,
        route="local",
    )


def _limit_flash_concurrency(runnable: Any, limit: int | None = None) -> Any:
    return _limit_concurrency(
        runnable,
        semaphore=_route_semaphore(
            "flash",
            limit
            if limit is not None
            else get_runtime_model_config().cloud_routine_max_concurrency,
        ),
        queue_timeout_seconds=settings.cloud_model_queue_timeout_seconds,
        route="flash",
    )


def _limit_pro_concurrency(runnable: Any, limit: int | None = None) -> Any:
    return _limit_concurrency(
        runnable,
        semaphore=_route_semaphore(
            "pro",
            limit if limit is not None else get_runtime_model_config().cloud_pro_max_concurrency,
        ),
        queue_timeout_seconds=settings.cloud_model_queue_timeout_seconds,
        route="pro",
    )


def create_interactive_llm(*, tools: Sequence[Any] | None = None, **kwargs: Any) -> Any:
    """DeepSeek Flash first for user-facing conversation; local Qwen is fallback."""
    candidates: list[Any] = []
    runtime = get_runtime_model_config()
    if (
        runtime.cloud_enabled
        and runtime.cloud_api_key
        and runtime.cloud_model_name
        and cloud_circuit.allow_request()
    ):
        flash = _flash_llm(runtime, **kwargs)
        if tools:
            flash = flash.bind_tools(tools)
        candidates.append(_limit_flash_concurrency(flash, runtime.cloud_routine_max_concurrency))
    local_added = runtime.local_enabled and runtime.local_base_url and local_circuit.allow_request()
    if local_added:
        local = _local_llm(runtime, **kwargs)
        if tools:
            local = local.bind_tools(tools)
        candidates.append(_limit_local_concurrency(local, runtime.local_max_concurrency))
    if not candidates:
        raise RuntimeError("没有可用的日常模型：请配置本地模型或云端模型")

    primary, *fallbacks = candidates
    return primary.with_fallbacks(fallbacks) if fallbacks else primary


def create_routine_llm(*, tools: Sequence[Any] | None = None, **kwargs: Any) -> Any:
    """Backward-compatible alias for the interactive role."""
    return create_interactive_llm(tools=tools, **kwargs)


def create_structured_llm(*, tools: Sequence[Any] | None = None, **kwargs: Any) -> Any:
    """Flash first for contract-bound JSON; local Qwen is availability fallback."""
    candidates: list[Any] = []
    runtime = get_runtime_model_config()
    if (
        runtime.cloud_enabled
        and runtime.cloud_api_key
        and runtime.cloud_model_name
        and cloud_circuit.allow_request()
    ):
        flash = _flash_llm(runtime, **kwargs)
        if tools:
            flash = flash.bind_tools(tools)
        candidates.append(_limit_flash_concurrency(flash, runtime.cloud_routine_max_concurrency))
    local_added = runtime.local_enabled and runtime.local_base_url and local_circuit.allow_request()
    if local_added:
        local = _local_llm(runtime, **kwargs)
        if tools:
            local = local.bind_tools(tools)
        candidates.append(_limit_local_concurrency(local, runtime.local_max_concurrency))
    if not candidates:
        raise RuntimeError("没有可用的结构化生成模型：请配置云端模型或本地模型")
    primary, *fallbacks = candidates
    return primary.with_fallbacks(fallbacks) if fallbacks else primary


def create_structured_routine_llm(
    *,
    provider: str | None = None,
    model_name: str | None = None,
    timeout_ms: int | None = None,
    **kwargs: Any,
) -> Any:
    """创建强制 JSON 输出的版本化模型或兼容日常路由。"""
    model_kwargs = dict(kwargs.pop("model_kwargs", {}))
    model_kwargs["response_format"] = {"type": "json_object"}
    if provider in {None, "configured-router", "structured"}:
        return create_structured_llm(model_kwargs=model_kwargs, **kwargs)
    runtime = get_runtime_model_config()
    timeout = timeout_ms / 1000 if timeout_ms else None
    if provider == "local":
        if not runtime.local_base_url:
            raise RuntimeError("本地模型 Provider 未配置")
        model = ChatOpenAI(
            model=model_name or runtime.local_model_name,
            api_key=runtime.local_api_key or "local",
            base_url=runtime.local_base_url,
            timeout=timeout or settings.local_model_timeout_seconds,
            max_retries=0,
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            callbacks=[_RouteMetricsCallback("local")],
            model_kwargs=model_kwargs,
            **kwargs,
        )
        return _limit_local_concurrency(model, runtime.local_max_concurrency)
    if provider == "smart":
        if not runtime.cloud_enabled or not runtime.cloud_api_key:
            raise RuntimeError("云端模型 Provider 未配置")
        return _limit_flash_concurrency(
            ChatOpenAI(
                model=model_name or runtime.cloud_model_name,
                api_key=runtime.cloud_api_key,
                base_url=runtime.cloud_base_url or None,
                timeout=timeout or settings.cloud_routine_timeout_seconds,
                max_retries=settings.cloud_model_max_retries,
                callbacks=[_RouteMetricsCallback("flash")],
                model_kwargs=model_kwargs,
                **kwargs,
            ),
            runtime.cloud_routine_max_concurrency,
        )
    raise ValueError(f"不支持的模型 Provider: {provider}")


def create_json_llm(**kwargs: Any) -> Any:
    """Explicit public factory for the structured JSON role."""
    return create_structured_routine_llm(**kwargs)


def create_local_json_llm(**kwargs: Any) -> Any:
    """Local-only JSON route for private sources; intentionally no cloud fallback."""
    kwargs.setdefault("temperature", 0.1)
    kwargs.setdefault("model_kwargs", {"response_format": {"type": "json_object"}})
    return _local_llm(**kwargs)


def _json_payload(content: str, opening: str, closing: str) -> Any:
    start = content.find(opening)
    end = content.rfind(closing) + 1
    if start < 0 or end <= start:
        raise ValueError("模型输出不包含完整 JSON")
    return json.loads(content[start:end])


def require_json_object(content: str) -> None:
    value = _json_payload(content, "{", "}")
    if not isinstance(value, dict) or not value:
        raise ValueError("模型输出不是非空 JSON 对象")


def require_json_array(content: str) -> None:
    value = _json_payload(content, "[", "]")
    if not isinstance(value, list):
        raise ValueError("模型输出不是 JSON 数组")


async def ainvoke_structured_checked(
    messages: Any,
    *,
    validator: Any,
    tools: Sequence[Any] | None = None,
    **kwargs: Any,
) -> Any:
    """Invoke the structured role and retry a quality failure on the other provider."""
    routed = create_structured_llm(tools=tools, **kwargs)
    runtime = get_runtime_model_config()
    response = await routed.ainvoke(messages)
    try:
        validator(response.content)
        return response
    except Exception:
        used_model = str((response.response_metadata or {}).get("model_name", ""))
        used_local = bool(runtime.local_base_url) and used_model != runtime.cloud_model_name
        route = "local" if used_local else "flash"
        model_metrics.record_quality_failure(route)
        logger.warning(
            "llm_quality_failure route=%s model=%s",
            route,
            used_model or "unknown",
        )
        if used_local:
            if (
                not runtime.cloud_enabled
                or not runtime.cloud_api_key
                or not runtime.cloud_model_name
            ):
                raise
            retry = _flash_llm(runtime, **kwargs)
            if tools:
                retry = retry.bind_tools(tools)
            retry = _limit_flash_concurrency(retry, runtime.cloud_routine_max_concurrency)
        else:
            if not runtime.local_enabled or not runtime.local_base_url:
                raise
            retry = _local_llm(runtime, **kwargs)
            if tools:
                retry = retry.bind_tools(tools)
            retry = _limit_local_concurrency(retry, runtime.local_max_concurrency)
    response = await retry.ainvoke(messages)
    validator(response.content)
    return response


async def ainvoke_routine_checked(
    messages: Any,
    *,
    validator: Any,
    tools: Sequence[Any] | None = None,
    **kwargs: Any,
) -> Any:
    """Backward-compatible alias for structured, contract-checked generation."""
    return await ainvoke_structured_checked(
        messages,
        validator=validator,
        tools=tools,
        **kwargs,
    )


def create_pro_llm(**kwargs: Any) -> Any:
    """Create the critical role; it intentionally has no lower-quality fallback."""
    runtime = get_runtime_model_config()
    if not runtime.cloud_enabled or not runtime.cloud_api_key or not runtime.cloud_pro_model_name:
        raise RuntimeError("高质量云端模型未配置")
    if not cloud_circuit.allow_request():
        raise RuntimeError("高质量云端模型暂时不可用，请稍后重试")
    return _limit_pro_concurrency(
        ChatOpenAI(
            model=runtime.cloud_pro_model_name,
            api_key=runtime.cloud_api_key,
            base_url=runtime.cloud_base_url or None,
            timeout=settings.cloud_pro_timeout_seconds,
            max_retries=settings.cloud_model_max_retries,
            callbacks=[_RouteMetricsCallback("pro")],
            **kwargs,
        ),
        runtime.cloud_pro_max_concurrency,
    )


def create_critical_llm(**kwargs: Any) -> Any:
    """Explicit public factory for critical judgments."""
    return create_pro_llm(**kwargs)


def get_llm_runtime_status() -> dict[str, Any]:
    runtime = get_runtime_model_config()
    return {
        "local_enabled": runtime.local_enabled,
        "local_base_url_configured": bool(runtime.local_base_url),
        "local_model": runtime.local_model_name,
        "cloud_provider": runtime.cloud_provider,
        "cloud_routine_model": runtime.cloud_model_name,
        "cloud_pro_model": runtime.cloud_pro_model_name,
        "circuit": local_circuit.snapshot(),
        "local_circuit": local_circuit.snapshot(),
        "cloud_circuit": cloud_circuit.snapshot(),
        "metrics": model_metrics.snapshot(),
        "gateway_circuits": gateway_status(),
        "roles": get_model_role_contracts(runtime),
    }
