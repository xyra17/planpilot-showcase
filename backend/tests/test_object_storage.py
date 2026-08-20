import pytest

from src.services.object_storage import (
    LocalObjectStorage,
    ObjectStorageError,
    extension_for_reference,
    object_reference,
    reference_key,
)


@pytest.mark.asyncio
async def test_local_object_storage_crud_and_copy(tmp_path) -> None:
    storage = LocalObjectStorage(str(tmp_path))
    reference = await storage.put("knowledge/user/file.txt", b"hello", "text/plain")

    assert reference == "object://knowledge/user/file.txt"
    assert await storage.exists(reference)
    assert await storage.read(reference) == b"hello"
    assert await storage.size(reference) == 5
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
