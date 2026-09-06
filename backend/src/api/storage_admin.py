"""Admin-only controls for conservative storage garbage collection."""

from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from src.celery_app import celery_app
from src.deps import get_current_admin, get_db
from src.models import User
from src.services.object_storage import probe_object_storage
from src.services.storage_gc_service import collect_orphaned_storage

router = APIRouter(prefix="/api/v1/admin/storage", tags=["admin-storage"])


class StorageCleanupRequest(BaseModel):
    mode: Literal["immediate", "scheduled"] = "immediate"
    run_at: datetime | None = None
    grace_hours: int = Field(default=48, ge=0, le=720)


@router.get("/status")
async def get_storage_status(_: User = Depends(get_current_admin)) -> dict[str, object]:
    """Return the process-local backend selection without credentials or endpoint URLs."""

    return (await probe_object_storage()).as_dict()


@router.post("/probe")
async def probe_storage(_: User = Depends(get_current_admin)) -> dict[str, object]:
    """Recheck availability without writing, deleting, or automatically failing back."""

    return (await probe_object_storage(refresh=True)).as_dict()


@router.get("/gc/preview")
async def preview_storage_cleanup(
    _: User = Depends(get_current_admin), db: AsyncSession = Depends(get_db)
) -> dict[str, int]:
    return await collect_orphaned_storage(db, dry_run=True)


@router.post("/gc")
async def run_storage_cleanup(
    body: StorageCleanupRequest,
    _: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if body.mode == "immediate":
        return await collect_orphaned_storage(db, grace_period=timedelta(hours=body.grace_hours))
    if body.run_at is None:
        raise HTTPException(422, "scheduled 模式必须提供 run_at")
    run_at = body.run_at if body.run_at.tzinfo else body.run_at.replace(tzinfo=timezone.utc)
    if run_at <= datetime.now(timezone.utc):
        raise HTTPException(422, "run_at 必须是未来时间")
    task = celery_app.send_task(
        "src.tasks.storage_gc.collect_orphaned_storage",
        kwargs={"grace_hours": body.grace_hours},
        eta=run_at,
    )
    return {"mode": "scheduled", "task_id": task.id, "run_at": run_at.isoformat()}
