from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.database import get_db
from src.deps import get_current_user
from src.models import DailyBriefCache, User

router = APIRouter(prefix="/api/v1/notifications", tags=["notifications"])


class NotificationItem(BaseModel):
    id: str
    date: str
    summary: str
    is_read: bool
    generated_at: str
    generated_by: str


class NotificationsResponse(BaseModel):
    unread_count: int
    items: list[NotificationItem]


class EmailReminderStatus(BaseModel):
    configured: bool
    recipient: str
    email_verified: bool
    timezone: str


def _reminder_recipient(current_user: User) -> str:
    study_preferences = (current_user.account_preferences or {}).get("study_preferences") or {}
    if isinstance(study_preferences, dict):
        reminder_email = study_preferences.get("reminder_email")
        if isinstance(reminder_email, str) and reminder_email.strip():
            return reminder_email.strip()
    return current_user.email


@router.get("/email-reminder-status", response_model=EmailReminderStatus)
async def email_reminder_status(
    current_user: User = Depends(get_current_user),
) -> EmailReminderStatus:
    return EmailReminderStatus(
        configured=bool(settings.smtp_user and settings.smtp_password),
        recipient=_reminder_recipient(current_user),
        email_verified=current_user.email_verified,
        timezone=current_user.timezone or "Asia/Shanghai",
    )


@router.get("", response_model=NotificationsResponse)
async def list_notifications(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NotificationsResponse:
    rows = (
        (
            await db.execute(
                select(DailyBriefCache)
                .where(DailyBriefCache.user_id == current_user.id)
                .order_by(DailyBriefCache.date.desc())
                .limit(30)
            )
        )
        .scalars()
        .all()
    )

    items = [
        NotificationItem(
            id=r.id,
            date=r.date,
            summary=r.content.get("summary", ""),
            is_read=r.is_read,
            generated_at=r.generated_at.isoformat() if r.generated_at else "",
            generated_by=r.generated_by,
        )
        for r in rows
    ]
    return NotificationsResponse(
        unread_count=sum(1 for i in items if not i.is_read),
        items=items,
    )


@router.patch("/mark-read")
async def mark_all_read(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    rows = (
        (
            await db.execute(
                select(DailyBriefCache).where(
                    DailyBriefCache.user_id == current_user.id,
                    DailyBriefCache.is_read.is_(False),
                )
            )
        )
        .scalars()
        .all()
    )
    for r in rows:
        r.is_read = True
    await db.commit()
    return {"status": "ok"}


@router.delete("")
async def clear_notifications(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await db.execute(delete(DailyBriefCache).where(DailyBriefCache.user_id == current_user.id))
    await db.commit()
    return {"status": "ok"}
