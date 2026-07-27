from celery import Celery
from celery.schedules import crontab

from src.config import settings

celery_app = Celery(
    "planpilot",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        "src.tasks.daily_brief",
        "src.tasks.deviation",
        "src.tasks.reminders",
        "src.tasks.knowledge",
        "src.tasks.agent_suggestions",
    ],
)

celery_app.conf.update(
    timezone="Asia/Shanghai",
    enable_utc=True,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_soft_time_limit=900,
    task_time_limit=960,
)

celery_app.conf.beat_schedule = {
    "generate-all-daily-briefs": {
        "task": "src.tasks.daily_brief.generate_all_daily_briefs",
        "schedule": crontab(hour=7, minute=30),
        "options": {"expires": 3600},
    },
    "check-all-deviations": {
        "task": "src.tasks.deviation.check_all_deviations",
        "schedule": crontab(hour=0, minute=5),
        "options": {"expires": 3600},
    },
    "send-daily-reminders": {
        "task": "src.tasks.reminders.send_daily_reminders",
        "schedule": crontab(hour=23, minute=0),
        "options": {"expires": 3600},
    },
    "generate-agent-suggestions": {
        "task": "src.tasks.agent_suggestions.generate_agent_suggestions",
        "schedule": crontab(hour=8, minute=0),
        "options": {"expires": 3600},
    },
}
