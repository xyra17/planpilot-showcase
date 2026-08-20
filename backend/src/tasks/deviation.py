from src.celery_app import celery_app
from src.database import AsyncSessionLocal
from src.tasks.runtime import run_async


@celery_app.task(
    name="src.tasks.deviation.check_all_deviations",
    bind=True,
    max_retries=2,
    default_retry_delay=300,
)
def check_all_deviations(self, user_id: str | None = None):
    try:
        run_async(_main(user_id=user_id))
    except Exception as exc:
        raise self.retry(exc=exc)


async def _main(user_id: str | None = None):
    from datetime import date, timedelta

    from sqlalchemy import select

    from src.core.replan_policy import should_suggest_replan
    from src.models import CheckinRecord, Goal, User

    four_days_ago = (date.today() - timedelta(days=4)).isoformat()

    async with AsyncSessionLocal() as db:
        stmt = (
            select(Goal)
            .join(User, User.id == Goal.user_id)
            .where(Goal.status == "active", User.is_active.is_(True))
        )
        if user_id:
            stmt = stmt.where(Goal.user_id == user_id)
        active_goals = (await db.execute(stmt)).scalars().all()

        for goal in active_goals:
            recent = (
                (
                    await db.execute(
                        select(CheckinRecord)
                        .where(
                            CheckinRecord.goal_id == goal.id,
                            CheckinRecord.date >= four_days_ago,
                            CheckinRecord.mode != "natural",
                        )
                        .order_by(CheckinRecord.date.desc())
                        .limit(4)
                    )
                )
                .scalars()
                .all()
            )

            rates_by_date = {record.date: record.completion_rate for record in recent}
            work_schedule = goal.work_schedule or "all"
            # replan signal: computed but no longer written to goal.meta
            # TODO(Phase-2B): emit LearningEvent when replan is warranted
            should_suggest_replan(
                rates_by_date=rates_by_date,
                end_date=date.today(),
                work_schedule=work_schedule,
            )

        await db.commit()
