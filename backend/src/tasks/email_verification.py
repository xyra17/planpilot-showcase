import email.mime.multipart
import email.mime.text

import aiosmtplib

from src.celery_app import celery_app
from src.config import settings
from src.tasks.runtime import run_async


@celery_app.task(
    name="src.tasks.email_verification.send_email_verification",
    bind=True,
    max_retries=2,
    default_retry_delay=120,
)
def send_email_verification(self, to: str, username: str, token: str) -> None:
    try:
        run_async(_send(to, username, token))
    except Exception as exc:
        raise self.retry(exc=exc)


async def _send(to: str, username: str, token: str) -> None:
    if not settings.smtp_user or not settings.smtp_password:
        return

    verify_url = f"{settings.frontend_url.rstrip('/')}/verify-email?token={token}"
    message = email.mime.multipart.MIMEMultipart()
    message["From"] = f"{settings.smtp_from_name} <{settings.smtp_user}>"
    message["To"] = to
    message["Subject"] = "验证你的 PlanPilot 邮箱"
    message.attach(
        email.mime.text.MIMEText(
            (
                f"你好 {username}，\n\n"
                "欢迎加入 PlanPilot。请在 24 小时内点击下方链接完成邮箱验证：\n\n"
                f"{verify_url}\n\n"
                "如果这不是你发起的注册，请忽略此邮件。\n\n"
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
