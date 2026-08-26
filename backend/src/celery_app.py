from celery import Celery
from celery.schedules import crontab
from celery.signals import worker_process_init

from src.config import settings


@worker_process_init.connect
def configure_worker_observability(**_kwargs) -> None:
    from src.observability import configure_logging, configure_telemetry

    configure_logging(settings.log_level)
    configure_telemetry(worker=True)

celery_app = Celery(
    "planpilot",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        "src.tasks.daily_brief",
        "src.tasks.deviation",
        "src.tasks.reminders",
        "src.tasks.email_verification",
        "src.tasks.password_recovery",
        "src.tasks.knowledge",
        "src.tasks.media_preview",
        "src.tasks.agent_suggestions",
        "src.tasks.agent_runs",
        "src.tasks.pattern_tasks",
        "src.tasks.profile_tasks",
        "src.tasks.memory_tasks",
        "src.tasks.phase5_tasks",
        "src.tasks.phase6_tasks",
        "src.tasks.privacy_tasks",
        "src.tasks.beta_readiness_tasks",
        "src.tasks.storage_gc",
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
    "process-learning-events": {
        "task": "src.tasks.pattern_tasks.process_learning_events",
        "schedule": crontab(minute="*/5"),
        "options": {"expires": 240},
    },
    "build-learning-memories": {
        "task": "src.tasks.memory_tasks.build_learning_memories",
        "schedule": crontab(minute="2-59/5"),
        "options": {"expires": 240},
    },
    "decay-learner-patterns": {
        "task": "src.tasks.pattern_tasks.decay_learner_patterns",
        "schedule": crontab(hour=0, minute=30),
        "options": {"expires": 3600},
    },
    "rebuild-learner-profiles": {
        "task": "src.tasks.profile_tasks.rebuild_learner_profiles",
        "schedule": crontab(hour=1, minute=0),
        "options": {"expires": 3600},
    },
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
        "schedule": crontab(minute="*/5"),
        "options": {"expires": 240},
    },
    "generate-agent-suggestions": {
        "task": "src.tasks.agent_suggestions.generate_agent_suggestions",
        "schedule": crontab(hour=8, minute=0),
        "options": {"expires": 3600},
    },
    "recover-agent-runs": {
        "task": "src.tasks.agent_runs.recover_agent_runs",
        "schedule": crontab(minute="*/2"),
        "options": {"expires": 90},
    },
    "normalize-agent-feedback": {
        "task": "src.tasks.phase5_tasks.normalize_agent_feedback",
        "schedule": crontab(minute="4-59/5"),
        "options": {"expires": 240},
    },
    "compute-delayed-agent-outcomes": {
        "task": "src.tasks.phase5_tasks.compute_delayed_agent_outcomes",
        "schedule": crontab(hour=2, minute=10),
        "options": {"expires": 3600},
    },
    "aggregate-agent-metrics": {
        "task": "src.tasks.phase5_tasks.aggregate_agent_metrics",
        "schedule": crontab(hour=2, minute=30),
        "options": {"expires": 3600},
    },
    "capture-prediction-outcomes": {
        "task": "src.tasks.phase6_tasks.capture_prediction_outcomes",
        "schedule": crontab(hour=2, minute=40),
        "options": {"expires": 3600},
    },
    "calculate-prediction-calibration": {
        "task": "src.tasks.phase6_tasks.calculate_prediction_calibration",
        "schedule": crontab(hour=2, minute=50),
        "options": {"expires": 3600},
    },
    "enforce-data-retention": {
        "task": "src.tasks.privacy_tasks.enforce_data_retention",
        "schedule": crontab(hour=3, minute=20),
        "options": {"expires": 3600},
    },
    "normalize-canary-observations": {
        "task": "src.tasks.phase6_tasks.normalize_canary_observations",
        "schedule": crontab(minute="3-59/5"),
        "options": {"expires": 240},
    },
    "scan-beta-hard-safety": {
        "task": "src.tasks.beta_readiness_tasks.scan_hard_safety",
        "schedule": crontab(minute="1-59/5"),
        "options": {"expires": 240},
    },
    "normalize-beta-review-samples": {
        "task": "src.tasks.beta_readiness_tasks.normalize_review_samples",
        "schedule": crontab(minute="2-59/5"),
        "options": {"expires": 240},
    },
    "cleanup-beta-review-samples": {
        "task": "src.tasks.beta_readiness_tasks.cleanup_review_samples",
        "schedule": crontab(hour=3, minute=35),
        "options": {"expires": 3600},
    },
}
