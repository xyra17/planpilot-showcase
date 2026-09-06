"""Conservative offline operation staging and user-confirmed conflict resolution."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.database import get_db
from src.deps import get_current_user
from src.models import (
    Device,
    Goal,
    KnowledgeItem,
    OfflineOperation,
    Task,
    User,
    WorkspaceMember,
)

router = APIRouter(prefix="/api/v1/sync", tags=["offline-sync"])
MAX_SNAPSHOT_BYTES = 1024 * 1024


class OfflineOperationStage(BaseModel):
    operation_id: str = Field(min_length=8, max_length=120)
    workspace_id: str
    device_id: str
    operation_type: Literal["create", "update", "delete"]
    entity_type: Literal["goal", "task", "note", "knowledge_item"]
    entity_id: str | None = Field(default=None, max_length=120)
    base_version: int = Field(ge=0)
    local_snapshot: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_contract(self) -> "OfflineOperationStage":
        if self.operation_type != "create" and not self.entity_id:
            raise ValueError("更新或删除操作必须提供 entity_id")
        encoded = json.dumps(self.local_snapshot, ensure_ascii=False, separators=(",", ":")).encode()
        if len(encoded) > MAX_SNAPSHOT_BYTES:
            raise ValueError("离线快照不能超过 1 MB")
        return self


class ConflictResolution(BaseModel):
    action: Literal["keep_server", "keep_both"]


def _operation_hash(body: OfflineOperationStage) -> str:
    encoded = json.dumps(
        body.model_dump(), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _operation_out(row: OfflineOperation) -> dict[str, Any]:
    return {
        "id": row.id,
        "operation_id": row.operation_id,
        "workspace_id": row.workspace_id,
        "device_id": row.device_id,
        "operation_type": row.operation_type,
        "entity_type": row.entity_type,
        "entity_id": row.entity_id,
        "base_version": row.base_version,
        "server_version": row.server_version,
        "local_snapshot": row.local_snapshot or {},
        "server_snapshot": row.server_snapshot or {},
        "status": row.status,
        "resolution": row.resolution,
        "requires_user_confirmation": row.status == "conflict",
        "safe_default": (
            "保留服务器版本和本机副本，用户确认后再创建副本；不会自动覆盖。"
            if row.status == "conflict"
            else "操作已排队，须由对应领域同步器应用。"
        ),
        "resolved_at": row.resolved_at.isoformat() if row.resolved_at else None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def _server_entity_snapshot(
    db: AsyncSession,
    user_id: str,
    workspace_id: str,
    entity_type: str,
    entity_id: str | None,
) -> tuple[int, dict[str, Any]]:
    if not entity_id:
        return 0, {"exists": False}
    if entity_type == "goal":
        row = await db.scalar(
            select(Goal).where(
                Goal.id == entity_id,
                Goal.user_id == user_id,
                Goal.workspace_id == workspace_id,
            )
        )
        if row is None:
            return 0, {"exists": False, "entity_id": entity_id}
        return row.version, {
            "exists": True,
            "id": row.id,
            "title": row.title,
            "description": row.description,
            "deadline": row.deadline,
            "daily_hours": row.daily_hours,
            "status": row.status,
            "contract": row.contract or {},
            "version": row.version,
        }
    if entity_type == "task":
        row = await db.scalar(
            select(Task)
            .join(Goal, Goal.id == Task.goal_id)
            .where(
                Task.id == entity_id,
                Goal.user_id == user_id,
                Goal.workspace_id == workspace_id,
            )
        )
        if row is None:
            return 0, {"exists": False, "entity_id": entity_id}
        return row.version, {
            "exists": True,
            "id": row.id,
            "goal_id": row.goal_id,
            "title": row.title,
            "description": row.description,
            "status": row.status,
            "scheduled_date": row.scheduled_date,
            "execution_guide": row.execution_guide or {},
            "version": row.version,
        }
    row = await db.scalar(
        select(KnowledgeItem).where(
            KnowledgeItem.id == entity_id,
            KnowledgeItem.user_id == user_id,
            KnowledgeItem.workspace_id == workspace_id,
        )
    )
    if row is None:
        return 0, {"exists": False, "entity_id": entity_id}
    if entity_type == "note" and row.note_scope is None and row.note_id is None:
        return 0, {"exists": False, "entity_id": entity_id}
    return row.content_version, {
        "exists": True,
        "id": row.id,
        "title": row.title,
        "summary": row.summary,
        "content": row.content,
        "content_format": row.content_format,
        "source_role": row.source_role,
        "source_metadata": row.source_metadata or {},
        "content_version": row.content_version,
    }


@router.post("/operations", status_code=201)
async def stage_offline_operation(
    body: OfflineOperationStage,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    member = await db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == body.workspace_id,
            WorkspaceMember.user_id == current_user.id,
        )
    )
    if member is None:
        raise HTTPException(404, "学习空间不存在")
    device = await db.scalar(
        select(Device).where(
            Device.id == body.device_id,
            Device.user_id == current_user.id,
        )
    )
    if device is None:
        raise HTTPException(404, "设备不存在")
    if device.revoked_at is not None:
        raise HTTPException(409, "设备已撤销，请重新登记后再同步")

    request_hash = _operation_hash(body)
    existing = await db.scalar(
        select(OfflineOperation).where(
            OfflineOperation.user_id == current_user.id,
            OfflineOperation.operation_id == body.operation_id,
        )
    )
    if existing is not None:
        if existing.request_hash != request_hash:
            raise HTTPException(409, "operation_id 已用于不同内容")
        return _operation_out(existing)

    server_version, server_snapshot = await _server_entity_snapshot(
        db,
        current_user.id,
        body.workspace_id,
        body.entity_type,
        body.entity_id,
    )
    conflict = (
        (body.operation_type == "create" and server_version != 0)
        or (body.operation_type != "create" and server_version == 0)
        or body.base_version != server_version
    )
    row = OfflineOperation(
        user_id=current_user.id,
        workspace_id=body.workspace_id,
        device_id=body.device_id,
        operation_id=body.operation_id,
        operation_type=body.operation_type,
        entity_type=body.entity_type,
        entity_id=body.entity_id,
        base_version=body.base_version,
        server_version=server_version,
        request_hash=request_hash,
        local_snapshot=body.local_snapshot,
        server_snapshot=server_snapshot,
        status="conflict" if conflict else "queued",
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _operation_out(row)


@router.get("/operations")
async def list_offline_operations(
    status: Literal["queued", "conflict", "ready_copy", "resolved"] | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    statement = select(OfflineOperation).where(OfflineOperation.user_id == current_user.id)
    if status:
        statement = statement.where(OfflineOperation.status == status)
    rows = list(
        (
            await db.execute(
                statement.order_by(OfflineOperation.created_at.desc()).limit(limit)
            )
        ).scalars()
    )
    return {"items": [_operation_out(row) for row in rows]}


@router.post("/operations/{operation_id}/resolve")
async def resolve_offline_conflict(
    operation_id: str,
    body: ConflictResolution,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    row = await db.scalar(
        select(OfflineOperation).where(
            OfflineOperation.operation_id == operation_id,
            OfflineOperation.user_id == current_user.id,
        )
    )
    if row is None:
        raise HTTPException(404, "离线操作不存在")
    if row.status != "conflict":
        raise HTTPException(409, "只有待确认冲突可以处理")
    row.resolution = body.action
    row.status = "ready_copy" if body.action == "keep_both" else "resolved"
    row.resolved_at = utc_now()
    await db.commit()
    await db.refresh(row)
    return _operation_out(row)
