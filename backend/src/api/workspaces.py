from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import Device, User
from src.services.workspace_service import list_workspaces, register_device

router = APIRouter(prefix="/api/v1", tags=["workspaces"])


class WorkspaceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    kind: str
    is_default: bool
    version: int
    created_at: datetime
    updated_at: datetime


class DeviceRegistration(BaseModel):
    installation_id: str = Field(min_length=8, max_length=120)
    name: str = Field(min_length=1, max_length=120)
    platform: str = Field(min_length=1, max_length=40)
    app_version: str = Field(min_length=1, max_length=40)


class DeviceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    installation_id: str
    name: str
    platform: str
    app_version: str
    last_seen_at: datetime
    revoked_at: datetime | None


@router.get("/workspaces", response_model=list[WorkspaceOut])
async def get_workspaces(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rows = await list_workspaces(current_user, db)
    await db.commit()
    return rows


@router.get("/devices", response_model=list[DeviceOut])
async def get_devices(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rows = await db.execute(
        select(Device).where(Device.user_id == current_user.id).order_by(Device.last_seen_at.desc())
    )
    return list(rows.scalars().all())


@router.put("/devices/current", response_model=DeviceOut)
async def put_current_device(
    body: DeviceRegistration,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await register_device(current_user, db, **body.model_dump())
    await db.commit()
    await db.refresh(row)
    return row


@router.delete("/devices/{device_id}", status_code=204)
async def revoke_device(
    device_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = (
        await db.execute(select(Device).where(Device.id == device_id, Device.user_id == current_user.id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="设备不存在")
    from src.core.time import utc_now

    row.revoked_at = utc_now()
    await db.commit()
