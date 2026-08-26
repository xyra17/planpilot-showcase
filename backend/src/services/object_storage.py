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
from typing import AsyncIterator, Protocol

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


class ObjectStorage(Protocol):
    async def put(self, key: str, data: bytes, content_type: str) -> str: ...
    async def put_file(self, key: str, path: str, content_type: str) -> str: ...
    async def read(self, reference: str) -> bytes: ...
    async def read_range(self, reference: str, start: int, end: int) -> bytes: ...
    async def download_to_file(self, reference: str, path: str) -> None: ...
    def iter_chunks(self, reference: str, chunk_size: int = 1024 * 1024) -> AsyncIterator[bytes]: ...
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


def get_object_storage() -> ObjectStorage:
    if settings.storage_backend == "s3":
        return S3ObjectStorage()
    return LocalObjectStorage(settings.storage_local_root)
