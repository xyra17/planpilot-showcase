"""Conservative garbage collection for unreferenced managed storage objects."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import KnowledgeItem, KnowledgeItemFileVersion, User
from src.services.object_storage import StoredObject, get_object_storage, object_reference

MANAGED_PREFIXES = ("knowledge", "avatars")
DEFAULT_GRACE_PERIOD = timedelta(hours=48)
MAX_DELETIONS_PER_RUN = 2_000


def _avatar_reference(avatar_url: str | None) -> str | None:
    if not avatar_url or "/api/v1/auth/avatars/" not in avatar_url:
        return None
    filename = PurePosixPath(avatar_url.split("?", 1)[0]).name
    return object_reference(f"avatars/{filename}") if filename else None


async def collect_referenced_objects(db: AsyncSession) -> set[str]:
    references: set[str] = set()
    rows = (
        await db.execute(
            select(
                KnowledgeItem.file_path,
                KnowledgeItem.media_playback_path,
                KnowledgeItem.media_poster_path,
                KnowledgeItem.media_waveform_path,
            )
        )
    ).all()
    for row in rows:
        references.update(value for value in row if value and value.startswith("object://"))

    version_paths = (
        await db.execute(select(KnowledgeItemFileVersion.file_path))
    ).scalars().all()
    references.update(value for value in version_paths if value.startswith("object://"))

    avatar_urls = (await db.execute(select(User.avatar_url))).scalars().all()
    references.update(
        reference for value in avatar_urls if (reference := _avatar_reference(value))
    )
    return references


def select_orphaned_objects(
    objects: list[StoredObject],
    references: set[str],
    *,
    cutoff: datetime,
) -> list[StoredObject]:
    return sorted(
        (
            item
            for item in objects
            if item.reference not in references and item.modified_at <= cutoff
        ),
        key=lambda item: item.modified_at,
    )


async def collect_orphaned_storage(
    db: AsyncSession,
    *,
    dry_run: bool = False,
    now: datetime | None = None,
    grace_period: timedelta = DEFAULT_GRACE_PERIOD,
) -> dict[str, int]:
    storage = get_object_storage()
    references = await collect_referenced_objects(db)
    objects: list[StoredObject] = []
    for prefix in MANAGED_PREFIXES:
        objects.extend(await storage.list_objects(prefix))

    current_time = now or datetime.now(timezone.utc)
    candidates = select_orphaned_objects(
        objects,
        references,
        cutoff=current_time - grace_period,
    )[:MAX_DELETIONS_PER_RUN]
    if not dry_run:
        for item in candidates:
            await storage.delete(item.reference)

    return {
        "scanned": len(objects),
        "referenced": len(references),
        "orphaned": len(candidates),
        "deleted": 0 if dry_run else len(candidates),
        "bytes_reclaimed": 0 if dry_run else sum(item.size for item in candidates),
    }
