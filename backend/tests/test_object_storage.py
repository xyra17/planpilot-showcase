from datetime import datetime, timedelta, timezone

import pytest

from src.services.object_storage import (
    LocalObjectStorage,
    ObjectStorageError,
    StoredObject,
    extension_for_reference,
    object_reference,
    reference_key,
)
from src.services.storage_gc_service import select_orphaned_objects


@pytest.mark.asyncio
async def test_local_object_storage_crud_and_copy(tmp_path) -> None:
    storage = LocalObjectStorage(str(tmp_path))
    reference = await storage.put("knowledge/user/file.txt", b"hello", "text/plain")

    assert reference == "object://knowledge/user/file.txt"
    assert await storage.exists(reference)
    assert await storage.read(reference) == b"hello"
    assert await storage.read_range(reference, 1, 3) == b"ell"
    chunks = [chunk async for chunk in storage.iter_chunks(reference, 2)]
    assert chunks == [b"he", b"ll", b"o"]
    assert await storage.size(reference) == 5
    source = tmp_path / "source.bin"
    source.write_bytes(b"streamed")
    streamed = await storage.put_file("knowledge/user/streamed.bin", str(source), "application/octet-stream")
    target = tmp_path / "download.bin"
    await storage.download_to_file(streamed, str(target))
    assert target.read_bytes() == b"streamed"
    copied = await storage.copy(reference, "knowledge/versions/copy.txt")
    assert await storage.read(copied) == b"hello"
    await storage.delete(reference)
    assert not await storage.exists(reference)


@pytest.mark.asyncio
async def test_local_storage_reads_legacy_paths_during_migration(tmp_path) -> None:
    legacy = tmp_path / "legacy.pdf"
    legacy.write_bytes(b"%PDF")
    storage = LocalObjectStorage(str(tmp_path / "new"))

    assert await storage.read(str(legacy)) == b"%PDF"
    migrated = await storage.copy(str(legacy), "knowledge/migrated.pdf")
    assert await storage.read(migrated) == b"%PDF"


def test_object_reference_rejects_path_traversal() -> None:
    with pytest.raises(ObjectStorageError):
        object_reference("knowledge/../secret")
    with pytest.raises(ObjectStorageError):
        reference_key("/not-an-object")
    assert extension_for_reference("object://knowledge/file.PDF") == "pdf"


def test_storage_gc_keeps_referenced_and_recent_objects() -> None:
    now = datetime.now(timezone.utc)
    objects = [
        StoredObject("object://knowledge/keep.txt", 10, now - timedelta(days=3)),
        StoredObject("object://knowledge/orphan.txt", 20, now - timedelta(days=3)),
        StoredObject("object://knowledge/recent.txt", 30, now - timedelta(hours=1)),
    ]
    result = select_orphaned_objects(
        objects,
        {"object://knowledge/keep.txt"},
        cutoff=now - timedelta(days=2),
    )
    assert [item.reference for item in result] == ["object://knowledge/orphan.txt"]
