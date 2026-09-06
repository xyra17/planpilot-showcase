from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.models import Device, User, Workspace, WorkspaceMember, personal_workspace_id


async def ensure_default_workspace(user: User, db: AsyncSession) -> Workspace:
    workspace_id = personal_workspace_id(user.id)
    workspace = await db.get(Workspace, workspace_id)
    if workspace is None:
        workspace = Workspace(
            id=workspace_id,
            owner_user_id=user.id,
            name="我的学习空间",
            kind="cloud",
            is_default=True,
        )
        db.add(workspace)
        db.add(WorkspaceMember(workspace_id=workspace_id, user_id=user.id, role="owner"))
        await db.flush()
    return workspace


async def list_workspaces(user: User, db: AsyncSession) -> list[Workspace]:
    await ensure_default_workspace(user, db)
    rows = await db.execute(
        select(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id)
        .order_by(Workspace.is_default.desc(), Workspace.created_at.asc())
    )
    return list(rows.scalars().all())


async def register_device(
    user: User,
    db: AsyncSession,
    *,
    installation_id: str,
    name: str,
    platform: str,
    app_version: str,
) -> Device:
    row = (
        await db.execute(
            select(Device).where(
                Device.user_id == user.id,
                Device.installation_id == installation_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        row = Device(
            user_id=user.id,
            installation_id=installation_id,
            name=name,
            platform=platform,
            app_version=app_version,
            last_seen_at=utc_now(),
        )
        db.add(row)
    else:
        row.name = name
        row.platform = platform
        row.app_version = app_version
        row.last_seen_at = utc_now()
        row.revoked_at = None
    await db.flush()
    return row
