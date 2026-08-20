import email.mime.multipart
import email.mime.text

import aiosmtplib

from src.celery_app import celery_app
from src.config import settings
from src.tasks.runtime import run_async


@celery_app.task(
    name="src.tasks.password_recovery.send_password_reset",
    bind=True,
    max_retries=2,
    default_retry_delay=120,
)
def send_password_reset(self, to: str, username: str, token: str) -> None:
    try:
        run_async(_send(to, username, token))
    except Exception as exc:
        raise self.retry(exc=exc)


async def _send(to: str, username: str, token: str) -> None:
    if not settings.smtp_user or not settings.smtp_password:
        return

    recover_url = f"{settings.frontend_url.rstrip('/')}/auth/recover?token={token}"
    message = email.mime.multipart.MIMEMultipart()
    message["From"] = f"{settings.smtp_from_name} <{settings.smtp_user}>"
    message["To"] = to
    message["Subject"] = "重置你的 PlanPilot 密码"
    message.attach(
        email.mime.text.MIMEText(
            (
                f"你好 {username}，\n\n"
                "我们收到了你的密码重置请求。请在 1 小时内点击下方链接设置新密码：\n\n"
                f"{recover_url}\n\n"
                "如果这不是你发起的请求，请忽略此邮件。\n\n"
                "— PlanPilot 团队"
            ),
            "plain",
            "utf-8",
        )
    )
    await aiosmtplib.send(
        message,
        hostname=settings.smtp_host,
        port=settings.smtp_port,
        username=settings.smtp_user,
        password=settings.smtp_password,
        start_tls=True,
    )
