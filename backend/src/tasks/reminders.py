import email.mime.multipart
import email.mime.text
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import aiosmtplib
from sqlalchemy.orm.attributes import flag_modified

from src.celery_app import celery_app
from src.config import settings
from src.database import AsyncSessionLocal
from src.redis_client import get_redis
from src.tasks.runtime import run_async


@celery_app.task(
    name="src.tasks.reminders.send_daily_reminders",
    bind=True,
    max_retries=2,
    default_retry_delay=300,
)
def send_daily_reminders(self):
    try:
        run_async(_main())
    except Exception as exc:
        raise self.retry(exc=exc)


def _study_reminder_preferences(user) -> tuple[bool, str, str, str | None]:
    study_preferences = (user.account_preferences or {}).get("study_preferences") or {}
    if not isinstance(study_preferences, dict):
        return False, "21:30", "email", None
    return (
        study_preferences.get("reminder_enabled") is True,
        str(study_preferences.get("reminder_time") or "21:30"),
        str(study_preferences.get("reminder_channel") or "email"),
        (
            str(study_preferences.get("last_email_reminder_date"))
            if study_preferences.get("last_email_reminder_date")
            else None
        ),
    )


def _reminder_recipient(user) -> str:
    study_preferences = (user.account_preferences or {}).get("study_preferences") or {}
    if isinstance(study_preferences, dict):
        reminder_email = study_preferences.get("reminder_email")
        if isinstance(reminder_email, str) and reminder_email.strip():
            return reminder_email.strip()
    return str(user.email)


def _local_reminder_context(user, now_utc: datetime) -> tuple[str, bool]:
    try:
        user_zone = ZoneInfo(user.timezone or "Asia/Shanghai")
    except ZoneInfoNotFoundError:
        user_zone = ZoneInfo("UTC")
    local_now = now_utc.astimezone(user_zone)
    enabled, reminder_time, channel, last_sent_date = _study_reminder_preferences(user)
    try:
        reminder_hour, reminder_minute = (int(part) for part in reminder_time.split(":", 1))
    except (TypeError, ValueError):
        reminder_hour, reminder_minute = 21, 30
    if not 0 <= reminder_hour <= 23 or not 0 <= reminder_minute <= 59:
        reminder_hour, reminder_minute = 21, 30
    reminder_is_due = (local_now.hour, local_now.minute) >= (reminder_hour, reminder_minute)
    local_date = local_now.date().isoformat()
    return local_date, bool(
        enabled
        and channel == "email"
        and reminder_is_due
        and last_sent_date != local_date
    )


async def _main(now_utc: datetime | None = None):
    if not settings.smtp_user or not settings.smtp_password:
        return

    from sqlalchemy import select

    from src.models import CheckinRecord, Goal, Task, User

    execution_time = now_utc or datetime.now(timezone.utc)

    async with AsyncSessionLocal() as db:
        users = (await db.execute(select(User).where(User.is_active.is_(True)))).scalars().all()

        for user in users:
            today, reminder_due = _local_reminder_context(user, execution_time)
            if not reminder_due or not user.email_verified:
                continue

            already_checked = (
                await db.execute(
                    select(CheckinRecord).where(
                        CheckinRecord.user_id == user.id,
                        CheckinRecord.date == today,
                    )
                )
            ).scalar_one_or_none()
            if already_checked:
                continue

            tasks_today = (
                (
                    await db.execute(
                        select(Task)
                        .join(Goal, Goal.id == Task.goal_id)
                        .where(
                            Goal.user_id == user.id,
                            Goal.status == "active",
                            Task.scheduled_date == today,
                            Task.status == "pending",
                        )
                        .limit(5)
                    )
                )
                .scalars()
                .all()
            )

            if not tasks_today:
                continue

            task_lines = "\n".join(
                f"  · {t.title}（预计 {t.estimated_mins} 分钟）" for t in tasks_today
            )
            body = (
                f"你好 {user.username}，\n\n"
                f"你今天还有以下学习任务待完成：\n{task_lines}\n\n"
                f"打开 PlanPilot 完成打卡，保持学习连续性！\n\n"
                f"—— PlanPilot"
            )
            reminder_lock = f"reminder:email:{user.id}:{today}"
            redis = get_redis()
            acquired = await redis.set(reminder_lock, "sending", nx=True, ex=900)
            if not acquired:
                continue
            try:
                await _send_email(_reminder_recipient(user), "PlanPilot · 今日学习任务提醒", body)
                account_preferences = dict(user.account_preferences or {})
                study_preferences = dict(account_preferences.get("study_preferences") or {})
                study_preferences["last_email_reminder_date"] = today
                account_preferences["study_preferences"] = study_preferences
                user.account_preferences = account_preferences
                flag_modified(user, "account_preferences")
                await db.commit()
            except Exception:
                await redis.delete(reminder_lock)
                raise


async def _send_email(to: str, subject: str, body: str) -> None:
    msg = email.mime.multipart.MIMEMultipart()
    msg["From"] = f"{settings.smtp_from_name} <{settings.smtp_user}>"
    msg["To"] = to
    msg["Subject"] = subject
    msg.attach(email.mime.text.MIMEText(body, "plain", "utf-8"))

    await aiosmtplib.send(
        msg,
        hostname=settings.smtp_host,
        port=settings.smtp_port,
        username=settings.smtp_user,
        password=settings.smtp_password,
        start_tls=True,
    )
