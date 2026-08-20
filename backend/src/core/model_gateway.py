"""Bounded model invocation gateway used by the versioned Agent runtime."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from src.config import settings
from src.redis_client import get_redis

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class GatewayAttempt:
    route: str
    attempt: int
    outcome: str
    latency_ms: float
    error_category: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "route": self.route,
            "attempt": self.attempt,
            "outcome": self.outcome,
            "latency_ms": self.latency_ms,
            "error_category": self.error_category,
        }


@dataclass(frozen=True)
class GatewayResult:
    response: Any
    route: str
    fallback_used: bool
    latency_ms: float
    attempts: tuple[GatewayAttempt, ...]


class ModelGatewayError(RuntimeError):
    def __init__(self, message: str, attempts: list[GatewayAttempt]) -> None:
        super().__init__(message)
        self.attempts = tuple(attempts)


class _CircuitBreaker:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._failures = 0
        self._opened_at: float | None = None
        self._probe_in_flight = False

    def allow(self) -> bool:
        with self._lock:
            if self._opened_at is None:
                return True
            elapsed = time.monotonic() - self._opened_at
            if elapsed < settings.model_gateway_circuit_cooldown_seconds:
                return False
            if self._probe_in_flight:
                return False
            self._probe_in_flight = True
            return True

    def success(self) -> None:
        with self._lock:
            self._failures = 0
            self._opened_at = None
            self._probe_in_flight = False

    def failure(self) -> None:
        with self._lock:
            self._probe_in_flight = False
            self._failures += 1
            if self._failures >= settings.model_gateway_failure_threshold:
                self._opened_at = time.monotonic()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "state": "open" if self._opened_at is not None else "closed",
                "consecutive_failures": self._failures,
                "half_open_probe": self._probe_in_flight,
            }

    def reset(self) -> None:
        with self._lock:
            self._failures = 0
            self._opened_at = None
            self._probe_in_flight = False


_circuits: dict[str, _CircuitBreaker] = {}
_circuits_lock = threading.Lock()


def _circuit(route: str) -> _CircuitBreaker:
    with _circuits_lock:
        return _circuits.setdefault(route, _CircuitBreaker())


class _DistributedCircuit:
    """Redis-backed state with a local fail-open fallback for Redis outages."""

    def __init__(self, route: str) -> None:
        digest = hashlib.sha256(route.encode()).hexdigest()[:24]
        prefix = settings.model_gateway_redis_prefix
        self.route = route
        self.state_key = f"{prefix}:circuit_state:{digest}"
        self.lock_key = f"{prefix}:circuit_lock:{digest}"
        self.probe_key = f"{prefix}:circuit_probe:{digest}"
        self.local = _circuit(route)

    async def allow(self) -> bool:
        try:
            redis = get_redis()
            state = await redis.hgetall(self.state_key)
            if not state or state.get("status", "closed") == "closed":
                return True
            retry_after = float(state.get("retry_after") or 0)
            now = time.time()
            if now < retry_after:
                return False
            probe = await redis.set(
                self.probe_key,
                "1",
                nx=True,
                ex=max(1, round(settings.model_gateway_half_open_probe_seconds)),
            )
            if probe:
                await redis.hset(self.state_key, mapping={"status": "half_open"})
            return bool(probe)
        except Exception as exc:
            logger.warning(
                "model_gateway_redis_unavailable operation=allow error=%s", type(exc).__name__
            )
            return self.local.allow()

    async def success(self) -> None:
        try:
            redis = get_redis()
            await redis.delete(self.state_key, self.probe_key)
        except Exception as exc:
            logger.warning(
                "model_gateway_redis_unavailable operation=success error=%s", type(exc).__name__
            )
            self.local.success()

    async def failure(self) -> None:
        try:
            redis = get_redis()
            lock = redis.lock(self.lock_key, timeout=2, blocking_timeout=1)
            async with lock:
                state = await redis.hgetall(self.state_key)
                failures = int(state.get("failures") or 0) + 1
                mapping: dict[str, str | int | float] = {
                    "route": self.route,
                    "failures": failures,
                    "updated_at": time.time(),
                    "status": "closed",
                    "retry_after": 0,
                }
                if failures >= settings.model_gateway_failure_threshold:
                    mapping["status"] = "open"
                    mapping["opened_at"] = time.time()
                    mapping["retry_after"] = (
                        time.time() + settings.model_gateway_circuit_cooldown_seconds
                    )
                await redis.hset(self.state_key, mapping=mapping)
                await redis.expire(
                    self.state_key,
                    max(60, round(settings.model_gateway_circuit_cooldown_seconds * 4)),
                )
                await redis.delete(self.probe_key)
        except Exception as exc:
            logger.warning(
                "model_gateway_redis_unavailable operation=failure error=%s", type(exc).__name__
            )
            self.local.failure()

    async def snapshot(self) -> dict[str, Any]:
        try:
            state = await get_redis().hgetall(self.state_key)
            return {
                "route": self.route,
                "storage": "redis",
                "state": state.get("status", "closed") if state else "closed",
                "consecutive_failures": int(state.get("failures") or 0),
                "retry_after": float(state.get("retry_after") or 0) or None,
            }
        except Exception:
            return {"route": self.route, "storage": "local_fallback", **self.local.snapshot()}


def _category(exc: BaseException) -> str:
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return "model_timeout"
    name = type(exc).__name__.lower()
    if "rate" in name and "limit" in name:
        return "provider_rate_limit"
    if "connection" in name or "connect" in name:
        return "provider_connection"
    return type(exc).__name__


def _retryable(category: str) -> bool:
    return category in {"model_timeout", "provider_rate_limit", "provider_connection"}


class ModelGateway:
    """Apply a hard deadline, bounded retry, circuit breaker and model fallback."""

    @classmethod
    async def invoke(
        cls,
        messages: Any,
        *,
        primary: Any,
        primary_route: str,
        timeout_seconds: float,
        max_retries: int,
        fallback_factory: Callable[[], Any] | None = None,
        fallback_route: str = "configured-router",
    ) -> GatewayResult:
        started = time.monotonic()
        attempts: list[GatewayAttempt] = []
        candidates: list[tuple[str, Callable[[], Any], bool]] = [
            (primary_route, lambda: primary, False)
        ]
        if fallback_factory is not None and fallback_route != primary_route:
            candidates.append((fallback_route, fallback_factory, True))

        for route, factory, fallback_used in candidates:
            circuit = _DistributedCircuit(route)
            if not await circuit.allow():
                attempts.append(GatewayAttempt(route, 0, "circuit_open", 0.0, "circuit_open"))
                continue
            try:
                runnable = factory()
            except Exception as exc:
                await circuit.failure()
                attempts.append(GatewayAttempt(route, 0, "failure", 0.0, _category(exc)))
                continue

            for attempt_number in range(1, max(0, max_retries) + 2):
                attempt_started = time.monotonic()
                try:
                    response = await asyncio.wait_for(
                        runnable.ainvoke(messages), timeout=max(0.001, timeout_seconds)
                    )
                    elapsed = round((time.monotonic() - attempt_started) * 1000, 1)
                    await circuit.success()
                    attempts.append(GatewayAttempt(route, attempt_number, "success", elapsed))
                    logger.info(
                        "model_gateway route=%s outcome=success attempt=%d latency_ms=%.1f",
                        route,
                        attempt_number,
                        elapsed,
                    )
                    return GatewayResult(
                        response=response,
                        route=route,
                        fallback_used=fallback_used,
                        latency_ms=round((time.monotonic() - started) * 1000, 1),
                        attempts=tuple(attempts),
                    )
                except Exception as exc:
                    elapsed = round((time.monotonic() - attempt_started) * 1000, 1)
                    category = _category(exc)
                    attempts.append(
                        GatewayAttempt(route, attempt_number, "failure", elapsed, category)
                    )
                    logger.warning(
                        "model_gateway route=%s outcome=failure attempt=%d category=%s latency_ms=%.1f",
                        route,
                        attempt_number,
                        category,
                        elapsed,
                    )
                    if attempt_number <= max_retries and _retryable(category):
                        await asyncio.sleep(min(0.25 * attempt_number, 1.0))
                        continue
                    break
            await circuit.failure()

        raise ModelGatewayError("所有模型路由均不可用", attempts)


def gateway_status() -> dict[str, Any]:
    with _circuits_lock:
        return {
            "mode": "redis_distributed",
            "redis_prefix": settings.model_gateway_redis_prefix,
            "local_fallbacks": {route: circuit.snapshot() for route, circuit in _circuits.items()},
        }


async def distributed_gateway_status(routes: list[str]) -> list[dict[str, Any]]:
    return [await _DistributedCircuit(route).snapshot() for route in routes]


async def reset_gateway_state() -> None:
    """Reset local and distributed breaker state (primarily for deterministic drills)."""
    with _circuits_lock:
        for circuit in _circuits.values():
            circuit.reset()
    try:
        redis = get_redis()
        keys = [
            key
            async for key in redis.scan_iter(
                match=f"{settings.model_gateway_redis_prefix}:circuit_*"
            )
        ]
        if keys:
            await redis.delete(*keys)
    except Exception as exc:
        logger.warning(
            "model_gateway_redis_unavailable operation=reset error=%s", type(exc).__name__
        )
