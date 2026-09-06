"""Object storage boundary shared by API and background workers.

Database rows store opaque ``object://`` references. Legacy filesystem paths
remain readable during a rolling migration, but every new write uses the
backend-independent reference format.
"""

from __future__ import annotations

import asyncio
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator, Literal, Protocol

from src.config import settings

OBJECT_PREFIX = "object://"
_SAFE_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$")


class ObjectStorageError(RuntimeError):
    pass


@dataclass(frozen=True)
class StoredObject:
    reference: str
    size: int
    modified_at: datetime


@dataclass(frozen=True)
class StorageRuntimeStatus:
    """Non-secret process-local result of selecting an object storage backend."""

    status: Literal["ready", "degraded", "unavailable"]
    configured_backend: Literal["local", "s3"]
    active_backend: Literal["local", "s3"] | None
    configured_backend_reachable: bool
    fallback_enabled: bool
    fallback_active: bool
    fallback_backend: Literal["local"] | None
    reason: str | None
    error_type: str | None
    checked_at: datetime

    def as_dict(self) -> dict[str, object]:
        return {
            "status": self.status,
            "configured_backend": self.configured_backend,
            "active_backend": self.active_backend,
            "configured_backend_reachable": self.configured_backend_reachable,
            "fallback_enabled": self.fallback_enabled,
            "fallback_active": self.fallback_active,
            "fallback_backend": self.fallback_backend,
            "reason": self.reason,
            "error_type": self.error_type,
            "checked_at": self.checked_at.isoformat(),
        }


class ObjectStorage(Protocol):
    async def put(self, key: str, data: bytes, content_type: str) -> str: ...
    async def put_file(self, key: str, path: str, content_type: str) -> str: ...
    async def read(self, reference: str) -> bytes: ...
    async def read_range(self, reference: str, start: int, end: int) -> bytes: ...
    async def download_to_file(self, reference: str, path: str) -> None: ...
    def iter_chunks(
        self, reference: str, chunk_size: int = 1024 * 1024
    ) -> AsyncIterator[bytes]: ...
    async def exists(self, reference: str) -> bool: ...
    async def copy(self, source: str, target_key: str) -> str: ...
    async def delete(self, reference: str) -> None: ...
    async def size(self, reference: str) -> int | None: ...
    async def list_objects(self, prefix: str) -> list[StoredObject]: ...
    async def healthcheck(self) -> None: ...


def object_reference(key: str) -> str:
    return f"{OBJECT_PREFIX}{_validate_key(key)}"


def reference_key(reference: str) -> str:
    if not reference.startswith(OBJECT_PREFIX):
        raise ObjectStorageError("not an object storage reference")
    return _validate_key(reference.removeprefix(OBJECT_PREFIX))


def extension_for_reference(reference: str) -> str:
    suffix = reference.rsplit(".", 1)[-1].lower() if "." in reference else ""
    return suffix.split("?", 1)[0]


def _validate_key(key: str) -> str:
    normalized = key.strip().lstrip("/")
    if not _SAFE_KEY.fullmatch(normalized) or ".." in Path(normalized).parts:
        raise ObjectStorageError("invalid object key")
    return normalized


class LocalObjectStorage:
    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, reference: str) -> Path:
        if reference.startswith(OBJECT_PREFIX):
            candidate = (self.root / reference_key(reference)).resolve()
            if self.root not in candidate.parents:
                raise ObjectStorageError("object path escapes storage root")
            return candidate
        # Rolling-deployment compatibility for rows written before object://.
        return Path(reference).resolve()

    async def put(self, key: str, data: bytes, content_type: str) -> str:
        del content_type
        reference = object_reference(key)
        path = self._path(reference)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.tmp")

        def write() -> None:
            temporary.write_bytes(data)
            temporary.replace(path)

        await asyncio.to_thread(write)
        return reference

    async def put_file(self, key: str, path: str, content_type: str) -> str:
        del content_type
        reference = object_reference(key)
        target = self._path(reference)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.tmp")

        def copy() -> None:
            shutil.copyfile(path, temporary)
            temporary.replace(target)

        await asyncio.to_thread(copy)
        return reference

    async def read(self, reference: str) -> bytes:
        try:
            return await asyncio.to_thread(self._path(reference).read_bytes)
        except FileNotFoundError as exc:
            raise ObjectStorageError("object not found") from exc

    async def read_range(self, reference: str, start: int, end: int) -> bytes:
        if start < 0 or end < start:
            raise ObjectStorageError("invalid byte range")

        def read() -> bytes:
            with self._path(reference).open("rb") as handle:
                handle.seek(start)
                return handle.read(end - start + 1)

        try:
            return await asyncio.to_thread(read)
        except FileNotFoundError as exc:
            raise ObjectStorageError("object not found") from exc

    async def download_to_file(self, reference: str, path: str) -> None:
        try:
            await asyncio.to_thread(shutil.copyfile, self._path(reference), path)
        except FileNotFoundError as exc:
            raise ObjectStorageError("object not found") from exc

    async def iter_chunks(
        self, reference: str, chunk_size: int = 1024 * 1024
    ) -> AsyncIterator[bytes]:
        try:
            handle = await asyncio.to_thread(self._path(reference).open, "rb")
        except FileNotFoundError as exc:
            raise ObjectStorageError("object not found") from exc
        try:
            while chunk := await asyncio.to_thread(handle.read, chunk_size):
                yield chunk
        finally:
            await asyncio.to_thread(handle.close)

    async def exists(self, reference: str) -> bool:
        return await asyncio.to_thread(self._path(reference).is_file)

    async def copy(self, source: str, target_key: str) -> str:
        return await self.put(target_key, await self.read(source), "application/octet-stream")

    async def delete(self, reference: str) -> None:
        await asyncio.to_thread(self._path(reference).unlink, missing_ok=True)

    async def size(self, reference: str) -> int | None:
        try:
            return (await asyncio.to_thread(self._path(reference).stat)).st_size
        except FileNotFoundError:
            return None

    async def list_objects(self, prefix: str) -> list[StoredObject]:
        normalized = _validate_key(prefix).rstrip("/")
        base = (self.root / normalized).resolve()
        if self.root not in base.parents and base != self.root:
            raise ObjectStorageError("object prefix escapes storage root")

        def collect() -> list[StoredObject]:
            if not base.exists():
                return []
            objects: list[StoredObject] = []
            for path in base.rglob("*"):
                if not path.is_file() or path.name.startswith("."):
                    continue
                stat = path.stat()
                key = path.relative_to(self.root).as_posix()
                objects.append(
                    StoredObject(
                        reference=object_reference(key),
                        size=stat.st_size,
                        modified_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
                    )
                )
            return objects

        return await asyncio.to_thread(collect)

    async def healthcheck(self) -> None:
        await asyncio.to_thread(self.root.mkdir, parents=True, exist_ok=True)


class S3ObjectStorage:
    def __init__(self) -> None:
        import boto3

        self.bucket = settings.storage_s3_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.storage_s3_endpoint_url or None,
            region_name=settings.storage_s3_region,
            aws_access_key_id=settings.storage_s3_access_key,
            aws_secret_access_key=settings.storage_s3_secret_key,
            use_ssl=settings.storage_s3_secure,
        )
        self.legacy = LocalObjectStorage(settings.storage_local_root)

    async def put(self, key: str, data: bytes, content_type: str) -> str:
        normalized = _validate_key(key)
        options = {
            "Bucket": self.bucket,
            "Key": normalized,
            "Body": data,
            "ContentType": content_type or "application/octet-stream",
        }
        if settings.storage_s3_server_side_encryption:
            options["ServerSideEncryption"] = settings.storage_s3_server_side_encryption
        try:
            await asyncio.to_thread(self.client.put_object, **options)
        except Exception as exc:
            raise ObjectStorageError("object write failed") from exc
        return object_reference(normalized)

    async def put_file(self, key: str, path: str, content_type: str) -> str:
        normalized = _validate_key(key)
        options: dict[str, str] = {"ContentType": content_type or "application/octet-stream"}
        if settings.storage_s3_server_side_encryption:
            options["ServerSideEncryption"] = settings.storage_s3_server_side_encryption
        try:
            await asyncio.to_thread(
                self.client.upload_file,
                path,
                self.bucket,
                normalized,
                ExtraArgs=options,
            )
        except Exception as exc:
            raise ObjectStorageError("object write failed") from exc
        return object_reference(normalized)

    async def read(self, reference: str) -> bytes:
        if not reference.startswith(OBJECT_PREFIX):
            return await self.legacy.read(reference)
        try:
            response = await asyncio.to_thread(
                self.client.get_object, Bucket=self.bucket, Key=reference_key(reference)
            )
            return await asyncio.to_thread(response["Body"].read)
        except Exception as exc:
            raise ObjectStorageError("object read failed") from exc

    async def read_range(self, reference: str, start: int, end: int) -> bytes:
        if not reference.startswith(OBJECT_PREFIX):
            return await self.legacy.read_range(reference, start, end)
        if start < 0 or end < start:
            raise ObjectStorageError("invalid byte range")
        try:
            response = await asyncio.to_thread(
                self.client.get_object,
                Bucket=self.bucket,
                Key=reference_key(reference),
                Range=f"bytes={start}-{end}",
            )
            return await asyncio.to_thread(response["Body"].read)
        except Exception as exc:
            raise ObjectStorageError("object read failed") from exc

    async def download_to_file(self, reference: str, path: str) -> None:
        if not reference.startswith(OBJECT_PREFIX):
            await self.legacy.download_to_file(reference, path)
            return
        try:
            await asyncio.to_thread(
                self.client.download_file,
                self.bucket,
                reference_key(reference),
                path,
            )
        except Exception as exc:
            raise ObjectStorageError("object read failed") from exc

    async def iter_chunks(
        self, reference: str, chunk_size: int = 1024 * 1024
    ) -> AsyncIterator[bytes]:
        if not reference.startswith(OBJECT_PREFIX):
            async for chunk in self.legacy.iter_chunks(reference, chunk_size):
                yield chunk
            return
        try:
            response = await asyncio.to_thread(
                self.client.get_object, Bucket=self.bucket, Key=reference_key(reference)
            )
            body = response["Body"]
            try:
                while chunk := await asyncio.to_thread(body.read, chunk_size):
                    yield chunk
            finally:
                await asyncio.to_thread(body.close)
        except Exception as exc:
            raise ObjectStorageError("object read failed") from exc

    async def exists(self, reference: str) -> bool:
        if not reference.startswith(OBJECT_PREFIX):
            return await self.legacy.exists(reference)
        try:
            await asyncio.to_thread(
                self.client.head_object, Bucket=self.bucket, Key=reference_key(reference)
            )
            return True
        except Exception:
            return False

    async def copy(self, source: str, target_key: str) -> str:
        if not source.startswith(OBJECT_PREFIX):
            return await self.put(
                target_key, await self.legacy.read(source), "application/octet-stream"
            )
        normalized = _validate_key(target_key)
        options = {
            "Bucket": self.bucket,
            "Key": normalized,
            "CopySource": {"Bucket": self.bucket, "Key": reference_key(source)},
        }
        if settings.storage_s3_server_side_encryption:
            options["ServerSideEncryption"] = settings.storage_s3_server_side_encryption
        try:
            await asyncio.to_thread(self.client.copy_object, **options)
        except Exception as exc:
            raise ObjectStorageError("object copy failed") from exc
        return object_reference(normalized)

    async def delete(self, reference: str) -> None:
        if not reference.startswith(OBJECT_PREFIX):
            await self.legacy.delete(reference)
            return
        try:
            await asyncio.to_thread(
                self.client.delete_object, Bucket=self.bucket, Key=reference_key(reference)
            )
        except Exception as exc:
            raise ObjectStorageError("object delete failed") from exc

    async def size(self, reference: str) -> int | None:
        if not reference.startswith(OBJECT_PREFIX):
            return await self.legacy.size(reference)
        try:
            result = await asyncio.to_thread(
                self.client.head_object, Bucket=self.bucket, Key=reference_key(reference)
            )
            return int(result["ContentLength"])
        except Exception:
            return None

    async def list_objects(self, prefix: str) -> list[StoredObject]:
        normalized = _validate_key(prefix).rstrip("/") + "/"

        def collect() -> list[StoredObject]:
            paginator = self.client.get_paginator("list_objects_v2")
            objects: list[StoredObject] = []
            for page in paginator.paginate(Bucket=self.bucket, Prefix=normalized):
                for row in page.get("Contents", []):
                    modified = row["LastModified"]
                    if modified.tzinfo is None:
                        modified = modified.replace(tzinfo=timezone.utc)
                    objects.append(
                        StoredObject(
                            reference=object_reference(row["Key"]),
                            size=int(row.get("Size", 0)),
                            modified_at=modified.astimezone(timezone.utc),
                        )
                    )
            return objects

        try:
            return await asyncio.to_thread(collect)
        except Exception as exc:
            raise ObjectStorageError("object listing failed") from exc

    async def healthcheck(self) -> None:
        try:
            await asyncio.to_thread(self.client.head_bucket, Bucket=self.bucket)
        except Exception as exc:
            raise ObjectStorageError("object storage healthcheck failed") from exc


def _root_error_type(exc: Exception) -> str:
    if isinstance(exc, TimeoutError):
        return "TimeoutError"
    current: BaseException = exc
    seen: set[int] = set()
    while current.__cause__ is not None and id(current) not in seen:
        seen.add(id(current))
        current = current.__cause__
    return type(current).__name__


class ProbedObjectStorage:
    """Select S3 once, then conservatively fall back to local managed storage.

    The initial selection is process-local.  A refresh may move from S3 to the
    local fallback after an outage, but it deliberately does not move back to
    S3 in the same process.  This avoids sending writes to two backends during
    an unstable probe window.  On a later process start, local fallback objects
    remain readable through the read-through lookup below.
    """

    def __init__(
        self,
        configured_backend: Literal["local", "s3"],
        primary: ObjectStorage,
        *,
        local_fallback: ObjectStorage | None = None,
        probe_timeout_seconds: float = 3.0,
    ) -> None:
        self.configured_backend = configured_backend
        self.primary = primary
        self.local_fallback = local_fallback
        self.probe_timeout_seconds = probe_timeout_seconds
        self._active: ObjectStorage | None = None
        self._active_backend: Literal["local", "s3"] | None = None
        self._status: StorageRuntimeStatus | None = None
        self._selection_lock = asyncio.Lock()
        self._fallback_locked = False

    async def _probe_backend(self, backend: ObjectStorage) -> tuple[bool, str | None]:
        try:
            await asyncio.wait_for(
                backend.healthcheck(),
                timeout=self.probe_timeout_seconds,
            )
            return True, None
        except Exception as exc:
            return False, _root_error_type(exc)

    def _result(
        self,
        *,
        status: Literal["ready", "degraded", "unavailable"],
        configured_reachable: bool,
        reason: str | None,
        error_type: str | None,
    ) -> StorageRuntimeStatus:
        result = StorageRuntimeStatus(
            status=status,
            configured_backend=self.configured_backend,
            active_backend=self._active_backend,
            configured_backend_reachable=configured_reachable,
            fallback_enabled=self.local_fallback is not None,
            fallback_active=self._active_backend == "local" and self.configured_backend == "s3",
            fallback_backend="local" if self.local_fallback is not None else None,
            reason=reason,
            error_type=error_type,
            checked_at=datetime.now(timezone.utc),
        )
        self._status = result
        return result

    async def probe(self, *, refresh: bool = False) -> StorageRuntimeStatus:
        if self._status is not None and not refresh:
            return self._status

        async with self._selection_lock:
            if self._status is not None and not refresh:
                return self._status

            primary_ok, primary_error = await self._probe_backend(self.primary)

            # Do not automatically fail back in a running process.  Local
            # fallback writes use the same opaque object references, so a
            # stable selection is safer than oscillating after each probe.
            if self._fallback_locked and self.local_fallback is not None:
                fallback_ok, fallback_error = await self._probe_backend(self.local_fallback)
                if fallback_ok:
                    self._active = self.local_fallback
                    self._active_backend = "local"
                    return self._result(
                        status="degraded",
                        configured_reachable=primary_ok,
                        reason=(
                            "failback_deferred_until_restart"
                            if primary_ok
                            else "configured_backend_unreachable"
                        ),
                        error_type=None if primary_ok else primary_error,
                    )
                self._active = None
                self._active_backend = None
                return self._result(
                    status="unavailable",
                    configured_reachable=primary_ok,
                    reason="locked_fallback_unavailable",
                    error_type=fallback_error,
                )

            if primary_ok:
                self._active = self.primary
                self._active_backend = self.configured_backend
                return self._result(
                    status="ready",
                    configured_reachable=True,
                    reason=None,
                    error_type=None,
                )

            if self.local_fallback is not None:
                fallback_ok, fallback_error = await self._probe_backend(self.local_fallback)
                if fallback_ok:
                    self._active = self.local_fallback
                    self._active_backend = "local"
                    self._fallback_locked = True
                    return self._result(
                        status="degraded",
                        configured_reachable=False,
                        reason="configured_backend_unreachable",
                        error_type=primary_error,
                    )
                primary_error = primary_error or fallback_error

            self._active = None
            self._active_backend = None
            return self._result(
                status="unavailable",
                configured_reachable=False,
                reason=(
                    "no_available_backend"
                    if self.local_fallback is not None
                    else "configured_backend_unreachable"
                ),
                error_type=primary_error,
            )

    async def _active_storage(self) -> ObjectStorage:
        status = await self.probe()
        if self._active is None:
            raise ObjectStorageError(
                f"no available object storage backend ({status.reason or 'probe failed'})"
            )
        return self._active

    async def _source_storage(self, reference: str) -> ObjectStorage:
        active = await self._active_storage()
        if (
            self._active_backend == "s3"
            and self.local_fallback is not None
            and reference.startswith(OBJECT_PREFIX)
            and not await active.exists(reference)
            and await self.local_fallback.exists(reference)
        ):
            return self.local_fallback
        return active

    async def put(self, key: str, data: bytes, content_type: str) -> str:
        return await (await self._active_storage()).put(key, data, content_type)

    async def put_file(self, key: str, path: str, content_type: str) -> str:
        return await (await self._active_storage()).put_file(key, path, content_type)

    async def read(self, reference: str) -> bytes:
        return await (await self._source_storage(reference)).read(reference)

    async def read_range(self, reference: str, start: int, end: int) -> bytes:
        return await (await self._source_storage(reference)).read_range(reference, start, end)

    async def download_to_file(self, reference: str, path: str) -> None:
        await (await self._source_storage(reference)).download_to_file(reference, path)

    async def iter_chunks(
        self, reference: str, chunk_size: int = 1024 * 1024
    ) -> AsyncIterator[bytes]:
        storage = await self._source_storage(reference)
        async for chunk in storage.iter_chunks(reference, chunk_size):
            yield chunk

    async def exists(self, reference: str) -> bool:
        active = await self._active_storage()
        if await active.exists(reference):
            return True
        return bool(
            self._active_backend == "s3"
            and self.local_fallback is not None
            and await self.local_fallback.exists(reference)
        )

    async def copy(self, source: str, target_key: str) -> str:
        active = await self._active_storage()
        source_storage = await self._source_storage(source)
        if source_storage is active:
            return await active.copy(source, target_key)
        return await active.put(
            target_key,
            await source_storage.read(source),
            "application/octet-stream",
        )

    async def delete(self, reference: str) -> None:
        active = await self._active_storage()
        await active.delete(reference)
        if self._active_backend == "s3" and self.local_fallback is not None:
            await self.local_fallback.delete(reference)

    async def size(self, reference: str) -> int | None:
        source = await self._source_storage(reference)
        return await source.size(reference)

    async def list_objects(self, prefix: str) -> list[StoredObject]:
        active = await self._active_storage()
        objects = await active.list_objects(prefix)
        if self._active_backend != "s3" or self.local_fallback is None:
            return objects
        merged = {item.reference: item for item in await self.local_fallback.list_objects(prefix)}
        merged.update({item.reference: item for item in objects})
        return list(merged.values())

    async def healthcheck(self) -> None:
        status = await self.probe(refresh=True)
        if status.status == "unavailable":
            raise ObjectStorageError(
                f"no available object storage backend ({status.reason or 'probe failed'})"
            )


_storage_runtime: ProbedObjectStorage | None = None
_storage_runtime_signature: tuple[object, ...] | None = None


def _runtime_signature() -> tuple[object, ...]:
    return (
        settings.storage_backend,
        settings.storage_local_root,
        settings.storage_s3_bucket,
        settings.storage_s3_endpoint_url,
        settings.storage_s3_region,
        settings.storage_s3_access_key,
        settings.storage_s3_secret_key,
        settings.storage_s3_secure,
        settings.storage_s3_server_side_encryption,
        settings.storage_s3_fallback_to_local,
        settings.storage_probe_timeout_seconds,
    )


def get_object_storage() -> ObjectStorage:
    global _storage_runtime, _storage_runtime_signature

    signature = _runtime_signature()
    if _storage_runtime is not None and _storage_runtime_signature == signature:
        return _storage_runtime

    if settings.storage_backend == "s3":
        primary: ObjectStorage = S3ObjectStorage()
        fallback: ObjectStorage | None = (
            LocalObjectStorage(settings.storage_local_root)
            if settings.storage_s3_fallback_to_local
            else None
        )
    else:
        primary = LocalObjectStorage(settings.storage_local_root)
        fallback = None

    _storage_runtime = ProbedObjectStorage(
        settings.storage_backend,
        primary,
        local_fallback=fallback,
        probe_timeout_seconds=settings.storage_probe_timeout_seconds,
    )
    _storage_runtime_signature = signature
    return _storage_runtime


async def probe_object_storage(*, refresh: bool = False) -> StorageRuntimeStatus:
    storage = get_object_storage()
    if not isinstance(storage, ProbedObjectStorage):  # pragma: no cover - defensive boundary
        raise ObjectStorageError("storage runtime does not support availability probes")
    return await storage.probe(refresh=refresh)


async def initialize_object_storage() -> StorageRuntimeStatus:
    """Probe and freeze the initial backend choice for the current process."""

    return await probe_object_storage()
