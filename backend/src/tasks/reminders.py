import asyncio
import email.mime.multipart
import email.mime.text

import aiosmtplib

from src.celery_app import celery_app
from src.config import settings
from src.database import AsyncSessionLocal


@celery_app.task(
    name="src.tasks.reminders.send_daily_reminders",
    bind=True,
    max_retries=2,
    default_retry_delay=300,
)
def send_daily_reminders(self):
    try:
        asyncio.run(_main())
    except Exception as exc:
        raise self.retry(exc=exc)


async def _main():
    if not settings.smtp_user or not settings.smtp_password:
        return

    from datetime import date

    from sqlalchemy import select

    from src.models import CheckinRecord, Goal, Task, User

    today = date.today().isoformat()

    async with AsyncSessionLocal() as db:
        users = (await db.execute(
            select(User).where(User.is_active.is_(True))
        )).scalars().all()

        for user in users:
            already_checked = (await db.execute(
                select(CheckinRecord).where(
                    CheckinRecord.user_id == user.id,
                    CheckinRecord.date == today,
                )
            )).scalar_one_or_none()
            if already_checked:
                continue

            tasks_today = (await db.execute(
                select(Task)
                .join(Goal, Goal.id == Task.goal_id)
                .where(
                    Goal.user_id == user.id,
                    Goal.status == "active",
                    Task.scheduled_date == today,
                    Task.status == "pending",
                )
                .limit(5)
            )).scalars().all()

            if not tasks_today:
                continue

            task_lines = "\n".join(f"  · {t.title}（预计 {t.estimated_mins} 分钟）" for t in tasks_today)
            body = (
                f"你好 {user.username}，\n\n"
                f"你今天还有以下学习任务待完成：\n{task_lines}\n\n"
                f"打开 PlanPilot 完成打卡，保持学习连续性！\n\n"
                f"—— PlanPilot"
            )
            await _send_email(user.email, "PlanPilot · 今日学习任务提醒", body)


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
