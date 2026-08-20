"""Phase 6.5 distributed runtime and timezone readiness tests."""

from __future__ import annotations

import asyncio
from datetime import datetime

import pytest

from src.config import settings
from src.core.model_gateway import _DistributedCircuit
from src.core.time import to_user_timezone
from src.tasks.runtime import run_async


class _FakeLock:
    def __init__(self, lock: asyncio.Lock) -> None:
        self.lock = lock

    async def __aenter__(self):
        await self.lock.acquire()
        return self

    async def __aexit__(self, *_args):
        self.lock.release()


class _SharedRedis:
    def __init__(self) -> None:
        self.hashes: dict[str, dict] = {}
        self.values: dict[str, str] = {}
        self.locks: dict[str, asyncio.Lock] = {}

    async def hgetall(self, key: str) -> dict:
        return dict(self.hashes.get(key, {}))

    async def hset(self, key: str, *, mapping: dict) -> None:
        self.hashes.setdefault(key, {}).update(mapping)

    async def expire(self, _key: str, _seconds: int) -> None:
        return None

    async def delete(self, *keys: str) -> None:
        for key in keys:
            self.hashes.pop(key, None)
            self.values.pop(key, None)

    async def set(self, key: str, value: str, *, nx: bool, ex: int) -> bool:
        del ex
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True

    def lock(self, key: str, **_kwargs) -> _FakeLock:
        return _FakeLock(self.locks.setdefault(key, asyncio.Lock()))


def test_celery_async_runtime_reuses_one_event_loop_per_worker_thread():
    async def loop_identity() -> int:
        return id(asyncio.get_running_loop())

    assert run_async(loop_identity()) == run_async(loop_identity())


@pytest.mark.asyncio
async def test_redis_circuit_is_shared_across_workers_and_half_open_is_single_probe(
    monkeypatch,
):
    shared = _SharedRedis()
    monkeypatch.setattr("src.core.model_gateway.get_redis", lambda: shared)
    monkeypatch.setattr(settings, "model_gateway_failure_threshold", 2)
    monkeypatch.setattr(settings, "model_gateway_circuit_cooldown_seconds", 30.0)

    worker_a = _DistributedCircuit("deepseek:phase65")
    worker_b = _DistributedCircuit("deepseek:phase65")
    await worker_a.failure()
    assert await worker_b.allow() is True
    await worker_b.failure()
    assert await worker_a.allow() is False

    shared.hashes[worker_a.state_key]["retry_after"] = 0
    probes = await asyncio.gather(worker_a.allow(), worker_b.allow())
    assert sorted(probes) == [False, True]
    assert (await worker_a.snapshot())["storage"] == "redis"


@pytest.mark.asyncio
async def test_user_timezone_update_validation_and_local_conversion(client, auth):
    updated = await client.patch("/api/v1/auth/me", json={"timezone": "Asia/Tokyo"}, headers=auth)
    assert updated.status_code == 200
    assert updated.json()["timezone"] == "Asia/Tokyo"

    invalid = await client.patch(
        "/api/v1/auth/me", json={"timezone": "Moon/SeaOfTranquility"}, headers=auth
    )
    assert invalid.status_code == 422

    event_time = datetime(2026, 8, 1, 1, 0)
    assert to_user_timezone(event_time, "Asia/Tokyo").hour == 10
    new_york = to_user_timezone(event_time, "America/New_York")
    assert new_york.hour == 21
    assert new_york.day == 31
