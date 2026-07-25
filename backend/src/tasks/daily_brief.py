import asyncio
from datetime import date, timedelta

from sqlalchemy import select

from src.api.agent import _build_daily_brief_for_user, _upsert_brief_cache
from src.celery_app import celery_app
from src.database import AsyncSessionLocal
from src.models import CheckinRecord, Goal, User


@celery_app.task(
    name="src.tasks.daily_brief.generate_all_daily_briefs",
    bind=True,
    max_retries=2,
    default_retry_delay=300,
)
def generate_all_daily_briefs(self):
    try:
        asyncio.run(_main())
    except Exception as exc:
        raise self.retry(exc=exc)


async def _main():
    seven_days_ago = (date.today() - timedelta(days=7)).isoformat()

    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            select(User.id)
            .join(CheckinRecord, CheckinRecord.user_id == User.id)
            .join(Goal, Goal.user_id == User.id)
            .where(
                User.is_active.is_(True),
                CheckinRecord.date >= seven_days_ago,
                Goal.status == "active",
            )
            .distinct()
        )).scalars().all()
        user_ids = list(rows)

    for uid in user_ids:
        async with AsyncSessionLocal() as db:
            brief = await _build_daily_brief_for_user(uid, db)
            if brief:
                await _upsert_brief_cache(uid, db, brief, "celery")
