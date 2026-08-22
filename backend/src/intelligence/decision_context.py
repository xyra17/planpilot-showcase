"""Read-only Agent Decision Context assembled from learner and goal state."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.privacy_fields import SENSITIVE_INFERENCE_FIELDS
from src.core.time import to_user_timezone
from src.intelligence.cognitive_model import (
    CognitiveProfileBuilder,
    cognitive_profile_to_dict,
)
from src.intelligence.knowledge_graph import KnowledgeGraphService
from src.intelligence.memory_system import MemoryService
from src.intelligence.profile_builder import PROFILE_FIELDS, profile_to_dict
from src.models import (
    Goal,
    LearnerPattern,
    LearnerProfile,
    LearningEvent,
    PatternEvidence,
    Plan,
    Task,
    User,
)
from src.services import privacy_service

MIN_GOAL_PROFILE_EVENTS = 5
ACTIVE_PATTERN_CONFIDENCE = 0.5
SAFE_EVENT_PAYLOAD_KEYS = {
    "date",
    "mode",
    "completion_rate",
    "mastery_rate",
    "completed",
    "completed_count",
    "partial",
    "skipped",
    "actual_mins",
    "time_investment_mins",
    "days_overdue",
    "from_date",
    "to_date",
    "trigger",
    "from_level",
    "to_level",
}


class DecisionContextBuilder:
    """Builds context for an Agent without writing any database state."""

    @classmethod
    async def build(
        cls,
        db: AsyncSession,
        user_id: str,
        *,
        goal_id: str | None = None,
        recent_event_limit: int = 20,
    ) -> dict[str, Any]:
        goal = await cls._load_goal(db, user_id, goal_id)
        if goal_id is not None and goal is None:
            raise LookupError("goal does not exist")
        timezone_name = (
            await db.scalar(select(User.timezone).where(User.id == user_id)) or "Asia/Shanghai"
        )
        goal_context = await cls._load_goal_context(db, goal) if goal else None
        if not await privacy_service.personalization_allowed(db, user_id):
            return {
                "profile": None,
                "cognitive_profile": None,
                "memories": {},
                "knowledge_gaps": [],
                "active_patterns": [],
                "recent_events": [],
                "user_timezone": timezone_name,
                "goal_context": goal_context,
                "data_quality": {
                    "profile_event_count": 0,
                    "profile_scope": "disabled",
                    "pattern_count": 0,
                    "memory_count": 0,
                    "cognitive_confidence": 0.0,
                    "knowledge_gap_count": 0,
                    "low_confidence_fields": [],
                    "level": "low",
                    "personalization_enabled": False,
                },
            }
        profile, profile_scope = await cls._load_profile(db, user_id, goal_id)
        patterns = await cls._load_active_patterns(db, user_id, goal_id)
        recent_events = await cls._load_recent_events(db, user_id, goal_id, recent_event_limit)
        evidence = await cls._load_pattern_evidence(db, patterns)
        cognitive = await CognitiveProfileBuilder.get_profile(db, user_id, goal_id)
        if cognitive is None and goal_id is not None:
            cognitive = await CognitiveProfileBuilder.get_profile(db, user_id, None)
        memories = await MemoryService.get_relevant_memories(db, user_id, goal_id=goal_id, limit=8)
        knowledge_gaps = await KnowledgeGraphService.detect_gaps(
            db, user_id, goal_id=goal_id, limit=5
        )

        cognitive_data = cognitive_profile_to_dict(cognitive)
        if cognitive_data and not await privacy_service.sensitive_inference_allowed(db, user_id):
            for field in SENSITIVE_INFERENCE_FIELDS:
                cognitive_data.pop(field, None)
        compatible_patterns = [
            pattern
            for pattern in patterns
            if pattern.pattern_type != "preferred_learning_time"
            or (pattern.pattern_value or {}).get("timezone") == timezone_name
        ]
        pattern_rows = [
            {
                "id": pattern.id,
                "goal_id": pattern.goal_id,
                "scope": pattern.scope,
                "pattern_type": pattern.pattern_type,
                "pattern_value": pattern.pattern_value or {},
                "confidence": round(pattern.confidence, 4),
                "evidence_count": pattern.evidence_count,
                "last_confirmed_at": (
                    pattern.last_confirmed_at.isoformat() if pattern.last_confirmed_at else None
                ),
                "user_review_status": pattern.user_review_status,
                "user_reviewed_at": (
                    pattern.user_reviewed_at.isoformat() if pattern.user_reviewed_at else None
                ),
                "evidence": evidence.get(pattern.id, {}).get("items", []),
                "evidence_summary": {
                    "supporting_count": evidence.get(pattern.id, {}).get("supporting_count", 0),
                    "opposing_count": evidence.get(pattern.id, {}).get("opposing_count", 0),
                    "neutral_count": evidence.get(pattern.id, {}).get("neutral_count", 0),
                    "first_observed_at": pattern.first_observed_at.isoformat(),
                    "last_observed_at": evidence.get(pattern.id, {}).get("last_observed_at"),
                    "timezone": (pattern.pattern_value or {}).get("timezone") or timezone_name,
                    "observation_window_days": profile.observation_window_days if profile else None,
                    "last_impacted_proposal_id": evidence.get(pattern.id, {}).get(
                        "last_impacted_proposal_id"
                    ),
                },
                "explanation": (pattern.user_override or {}).get("summary")
                or cls._explain_pattern(pattern),
            }
            for pattern in compatible_patterns
        ]
        profile_data = profile_to_dict(profile)
        low_confidence_fields = cls._low_confidence_fields(profile_data, compatible_patterns)
        event_count = profile.event_count if profile else 0
        return {
            "profile": profile_data,
            "cognitive_profile": cognitive_data,
            "memories": memories,
            "knowledge_gaps": knowledge_gaps,
            "active_patterns": pattern_rows,
            "recent_events": [cls._event_to_dict(event, timezone_name) for event in recent_events],
            "user_timezone": timezone_name,
            "goal_context": goal_context,
            "data_quality": {
                "profile_event_count": event_count,
                "profile_scope": profile_scope,
                "pattern_count": len(compatible_patterns),
                "memory_count": sum(len(rows) for rows in memories.values()),
                "cognitive_confidence": cognitive.confidence if cognitive else 0.0,
                "knowledge_gap_count": len(knowledge_gaps),
                "low_confidence_fields": low_confidence_fields,
                "level": ("high" if event_count >= 20 else "medium" if event_count >= 5 else "low"),
            },
        }

    @staticmethod
    async def _load_goal(db: AsyncSession, user_id: str, goal_id: str | None) -> Goal | None:
        if goal_id is None:
            return None
        return (
            await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
        ).scalar_one_or_none()

    @staticmethod
    async def _load_profile(
        db: AsyncSession, user_id: str, goal_id: str | None
    ) -> tuple[LearnerProfile | None, str]:
        if goal_id is not None:
            goal_profile = (
                await db.execute(
                    select(LearnerProfile).where(
                        LearnerProfile.user_id == user_id,
                        LearnerProfile.goal_id == goal_id,
                    )
                )
            ).scalar_one_or_none()
            if goal_profile is not None and goal_profile.event_count >= MIN_GOAL_PROFILE_EVENTS:
                return goal_profile, "goal"
        user_profile = (
            await db.execute(
                select(LearnerProfile).where(
                    LearnerProfile.user_id == user_id,
                    LearnerProfile.goal_id.is_(None),
                )
            )
        ).scalar_one_or_none()
        return (user_profile, "user") if user_profile else (None, "default")

    @staticmethod
    async def _load_active_patterns(
        db: AsyncSession, user_id: str, goal_id: str | None
    ) -> list[LearnerPattern]:
        stmt = select(LearnerPattern).where(
            LearnerPattern.user_id == user_id,
            LearnerPattern.status == "active",
            LearnerPattern.confidence >= ACTIVE_PATTERN_CONFIDENCE,
        )
        if goal_id is not None:
            stmt = stmt.where(
                or_(LearnerPattern.goal_id == goal_id, LearnerPattern.goal_id.is_(None))
            )
        rows = list((await db.execute(stmt)).scalars().all())
        if goal_id is None:
            return sorted(rows, key=lambda row: row.confidence, reverse=True)

        best_by_type: dict[str, LearnerPattern] = {}
        for row in rows:
            current = best_by_type.get(row.pattern_type)
            row_rank = (row.goal_id == goal_id, row.confidence)
            current_rank = (
                (current.goal_id == goal_id, current.confidence) if current else (False, -1.0)
            )
            if current is None or row_rank > current_rank:
                best_by_type[row.pattern_type] = row
        return sorted(best_by_type.values(), key=lambda row: row.confidence, reverse=True)

    @staticmethod
    async def _load_recent_events(
        db: AsyncSession,
        user_id: str,
        goal_id: str | None,
        limit: int,
    ) -> list[LearningEvent]:
        stmt = select(LearningEvent).where(LearningEvent.user_id == user_id)
        if goal_id is not None:
            stmt = stmt.where(
                or_(LearningEvent.goal_id == goal_id, LearningEvent.goal_id.is_(None))
            )
        return list(
            (
                await db.execute(
                    stmt.order_by(LearningEvent.occurred_at.desc()).limit(max(1, min(limit, 50)))
                )
            )
            .scalars()
            .all()
        )

    @staticmethod
    async def _load_pattern_evidence(
        db: AsyncSession, patterns: list[LearnerPattern]
    ) -> dict[str, dict[str, Any]]:
        if not patterns:
            return {}
        rows = (
            await db.execute(
                select(PatternEvidence, LearningEvent)
                .outerjoin(LearningEvent, PatternEvidence.learning_event_id == LearningEvent.id)
                .where(PatternEvidence.pattern_id.in_([row.id for row in patterns]))
                .order_by(PatternEvidence.recorded_at.desc())
            )
        ).all()
        result: dict[str, dict[str, Any]] = {}
        for evidence, event in rows:
            bucket = result.setdefault(
                evidence.pattern_id,
                {
                    "items": [],
                    "supporting_count": 0,
                    "opposing_count": 0,
                    "neutral_count": 0,
                    "last_observed_at": None,
                    "last_impacted_proposal_id": None,
                },
            )
            if evidence.contribution > 0:
                bucket["supporting_count"] += 1
            elif evidence.contribution < 0:
                bucket["opposing_count"] += 1
            else:
                bucket["neutral_count"] += 1
            if bucket["last_observed_at"] is None:
                bucket["last_observed_at"] = evidence.recorded_at.isoformat()
            if (
                bucket["last_impacted_proposal_id"] is None
                and (evidence.meta or {}).get("source") in {
                    "proposal_accepted", "proposal_feedback"
                }
                and event is not None
            ):
                bucket["last_impacted_proposal_id"] = event.aggregate_id
            if len(bucket["items"]) < 3:
                bucket["items"].append(
                    {
                        "event_id": evidence.learning_event_id,
                        "event_type": event.event_type if event else "system_prior",
                        "occurred_at": event.occurred_at.isoformat() if event else None,
                        "contribution": evidence.contribution,
                        "direction": (
                            "supporting" if evidence.contribution > 0
                            else "opposing" if evidence.contribution < 0
                            else "neutral"
                        ),
                        "source": (evidence.meta or {}).get("source"),
                        "aggregate_type": event.aggregate_type if event else None,
                        "aggregate_id": event.aggregate_id if event else None,
                    }
                )
        return result

    @staticmethod
    async def _load_goal_context(db: AsyncSession, goal: Goal) -> dict[str, Any]:
        plan = (
            await db.execute(
                select(Plan)
                .where(Plan.goal_id == goal.id, Plan.is_current.is_(True))
                .order_by(Plan.version.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        tasks = list(
            (
                await db.execute(
                    select(Task).where(Task.goal_id == goal.id).order_by(Task.scheduled_date)
                )
            )
            .scalars()
            .all()
        )
        today = date.today()
        week_end = today + timedelta(days=7)
        overdue = [
            task
            for task in tasks
            if task.status not in {"completed", "skipped", "abandoned"}
            and task.scheduled_date < today.isoformat()
        ]
        upcoming = [
            task
            for task in tasks
            if today.isoformat() <= task.scheduled_date <= week_end.isoformat()
            and task.status not in {"completed", "skipped", "abandoned"}
        ]
        completed = sum(task.status == "completed" for task in tasks)
        return {
            "goal": {
                "id": goal.id,
                "title": goal.title,
                "type": goal.type,
                "deadline": goal.deadline,
                "daily_hours": goal.daily_hours,
                "status": goal.status,
            },
            "current_plan": (
                {
                    "id": plan.id,
                    "version": plan.version,
                    "created_by": plan.created_by,
                }
                if plan
                else None
            ),
            "task_summary": {
                "total": len(tasks),
                "completed": completed,
                "completion_rate": round(completed / len(tasks), 4) if tasks else None,
                "overdue_count": len(overdue),
                "upcoming_count": len(upcoming),
            },
            "overdue_tasks": [DecisionContextBuilder._task_to_dict(task) for task in overdue[:10]],
            "upcoming_tasks": [
                DecisionContextBuilder._task_to_dict(task) for task in upcoming[:10]
            ],
        }

    @staticmethod
    def _task_to_dict(task: Task) -> dict[str, Any]:
        return {
            "id": task.id,
            "title": task.title,
            "scheduled_date": task.scheduled_date,
            "estimated_mins": task.estimated_mins,
            "status": task.status,
        }

    @staticmethod
    def _event_to_dict(event: LearningEvent, timezone_name: str) -> dict[str, Any]:
        payload = event.payload or {}
        return {
            "id": event.id,
            "goal_id": event.goal_id,
            "aggregate_type": event.aggregate_type,
            "aggregate_id": event.aggregate_id,
            "event_type": event.event_type,
            "occurred_at": event.occurred_at.isoformat(),
            "occurred_at_local": to_user_timezone(event.occurred_at, timezone_name).isoformat(),
            "payload": {key: payload[key] for key in SAFE_EVENT_PAYLOAD_KEYS if key in payload},
        }

    @staticmethod
    def _explain_pattern(pattern: LearnerPattern) -> str:
        labels = {
            "preferred_learning_time": "你的任务完成记录显示出稳定的学习时段偏好",
            "preferred_session_length": "你的实际任务时长形成了稳定的单次学习节奏",
            "weekly_learning_frequency": "你的打卡日期形成了每周学习频率",
            "completion_rate_trend": "近期打卡完成率形成了可识别趋势",
            "mastery_velocity": "掌握等级变化显示了当前学习速度",
            "delay_pattern": "任务逾期记录显示了延期倾向",
            "plan_adherence": "任务改期记录显示了计划遵从情况",
            "estimation_accuracy": "实际用时与估时的差异形成了估时特征",
        }
        return labels.get(pattern.pattern_type, "近期学习事件形成了稳定的行为模式")

    @staticmethod
    def _low_confidence_fields(
        profile: dict[str, Any] | None, patterns: list[LearnerPattern]
    ) -> list[str]:
        if profile is None:
            return list(PROFILE_FIELDS)
        low = [field for field in PROFILE_FIELDS if profile.get(field) is None]
        if not patterns:
            low.extend(
                field
                for field in ("preferred_hour_start", "preferred_hour_end", "mastery_velocity")
                if field not in low
            )
        return low
