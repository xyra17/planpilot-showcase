from __future__ import annotations

import pytest

from src.config import settings
from src.models import User
from src.services.object_storage import (
    LocalObjectStorage,
    ObjectStorageError,
    ProbedObjectStorage,
)


class SwitchableLocalStorage(LocalObjectStorage):
    def __init__(self, root: str, *, available: bool) -> None:
        super().__init__(root)
        self.available = available

    async def healthcheck(self) -> None:
        if not self.available:
            raise RuntimeError("simulated backend outage")
        await super().healthcheck()


@pytest.mark.asyncio
async def test_probe_selects_local_fallback_when_s3_is_unreachable(tmp_path) -> None:
    primary = SwitchableLocalStorage(str(tmp_path / "s3"), available=False)
    fallback = LocalObjectStorage(str(tmp_path / "uploads"))
    storage = ProbedObjectStorage(
        "s3",
        primary,
        local_fallback=fallback,
        probe_timeout_seconds=0.5,
    )

    status = await storage.probe()
    reference = await storage.put("knowledge/user/note.txt", b"offline", "text/plain")

    assert status.status == "degraded"
    assert status.configured_backend == "s3"
    assert status.active_backend == "local"
    assert status.configured_backend_reachable is False
    assert status.fallback_enabled is True
    assert status.fallback_active is True
    assert status.reason == "configured_backend_unreachable"
    assert status.error_type == "RuntimeError"
    assert await fallback.read(reference) == b"offline"
    assert not await primary.exists(reference)


@pytest.mark.asyncio
async def test_probe_without_fallback_reports_unavailable(tmp_path) -> None:
    primary = SwitchableLocalStorage(str(tmp_path / "s3"), available=False)
    storage = ProbedObjectStorage("s3", primary, probe_timeout_seconds=0.5)

    status = await storage.probe()

    assert status.status == "unavailable"
    assert status.active_backend is None
    assert status.fallback_enabled is False
    with pytest.raises(ObjectStorageError, match="no available object storage backend"):
        await storage.put("knowledge/user/note.txt", b"data", "text/plain")


@pytest.mark.asyncio
async def test_recovered_s3_does_not_silently_move_writes_between_backends(tmp_path) -> None:
    primary = SwitchableLocalStorage(str(tmp_path / "s3"), available=False)
    fallback = LocalObjectStorage(str(tmp_path / "uploads"))
    storage = ProbedObjectStorage(
        "s3",
        primary,
        local_fallback=fallback,
        probe_timeout_seconds=0.5,
    )
    await storage.probe()
    primary.available = True

    status = await storage.probe(refresh=True)
    reference = await storage.put("knowledge/user/still-local.txt", b"stable", "text/plain")

    assert status.status == "degraded"
    assert status.configured_backend_reachable is True
    assert status.active_backend == "local"
    assert status.reason == "failback_deferred_until_restart"
    assert await fallback.read(reference) == b"stable"
    assert not await primary.exists(reference)


@pytest.mark.asyncio
async def test_locked_fallback_never_switches_to_s3_when_local_temporarily_fails(
    tmp_path,
) -> None:
    primary = SwitchableLocalStorage(str(tmp_path / "s3"), available=False)
    fallback = SwitchableLocalStorage(str(tmp_path / "uploads"), available=True)
    storage = ProbedObjectStorage(
        "s3",
        primary,
        local_fallback=fallback,
        probe_timeout_seconds=0.5,
    )
    await storage.probe()
    primary.available = True
    fallback.available = False

    unavailable = await storage.probe(refresh=True)
    assert unavailable.status == "unavailable"
    assert unavailable.configured_backend_reachable is True
    assert unavailable.active_backend is None
    assert unavailable.reason == "locked_fallback_unavailable"

    fallback.available = True
    recovered = await storage.probe(refresh=True)
    reference = await storage.put("knowledge/user/stays-local.txt", b"local", "text/plain")
    assert recovered.status == "degraded"
    assert recovered.active_backend == "local"
    assert await fallback.read(reference) == b"local"
    assert not await primary.exists(reference)


@pytest.mark.asyncio
async def test_s3_selection_reads_objects_created_during_an_earlier_local_fallback(
    tmp_path,
) -> None:
    primary = SwitchableLocalStorage(str(tmp_path / "s3"), available=True)
    fallback = LocalObjectStorage(str(tmp_path / "uploads"))
    reference = await fallback.put(
        "knowledge/user/earlier-fallback.txt",
        b"preserved",
        "text/plain",
    )
    storage = ProbedObjectStorage(
        "s3",
        primary,
        local_fallback=fallback,
        probe_timeout_seconds=0.5,
    )

    status = await storage.probe()

    assert status.status == "ready"
    assert status.active_backend == "s3"
    assert await storage.read(reference) == b"preserved"
    assert await storage.exists(reference) is True
    assert await storage.size(reference) == len(b"preserved")


@pytest.mark.asyncio
async def test_storage_status_endpoint_is_admin_only_and_omits_secrets(
    client, auth, db, tmp_path, monkeypatch
) -> None:
    forbidden = await client.get("/api/v1/admin/storage/status", headers=auth)
    assert forbidden.status_code == 403

    me = await client.get("/api/v1/auth/me", headers=auth)
    user = await db.get(User, me.json()["id"])
    assert user is not None
    user.is_admin = True
    await db.commit()

    monkeypatch.setattr(settings, "storage_backend", "local")
    monkeypatch.setattr(settings, "storage_local_root", str(tmp_path / "uploads"))
    response = await client.get("/api/v1/admin/storage/status", headers=auth)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload == {
        "status": "ready",
        "configured_backend": "local",
        "active_backend": "local",
        "configured_backend_reachable": True,
        "fallback_enabled": False,
        "fallback_active": False,
        "fallback_backend": None,
        "reason": None,
        "error_type": None,
        "checked_at": payload["checked_at"],
    }
    serialized = response.text.lower()
    assert "access_key" not in serialized
    assert "secret" not in serialized
    assert "endpoint" not in serialized


@pytest.mark.asyncio
async def test_readiness_identifies_the_effective_storage_backend(
    client, tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(settings, "storage_backend", "local")
    monkeypatch.setattr(settings, "storage_local_root", str(tmp_path / "uploads"))

    response = await client.get("/ready")

    assert response.status_code == 200, response.text
    assert response.json()["storage"] == "ok"
    assert response.json()["storage_backend"] == "local"
