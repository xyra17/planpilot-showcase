"""Predictive task risk scoring and Proposal-only adaptive planning."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.intelligence.cognitive_model import CognitiveProfileBuilder
from src.intelligence.decision_context import DecisionContextBuilder
from src.intelligence.knowledge_graph import KnowledgeGraphService
from src.models import DecisionProposal, Goal, Task
from src.services import proposal_service
from src.services.calibration_service import record_task_failure_prediction
from src.services.proposal_service import ProposalCreate


class FailurePredictor:
    @staticmethod
    def predict(
        task: Task,
        *,
        completion_rate: float | None,
        procrastination_score: float | None,
        current_daily_load_mins: int,
        daily_capacity_mins: int,
        deadline: str,
    ) -> dict[str, Any]:
        today = date.today()
        try:
            scheduled = date.fromisoformat(task.scheduled_date)
            days_to_task = (scheduled - today).days
        except ValueError:
            days_to_task = 0
        try:
            days_to_deadline = max(0, (date.fromisoformat(deadline) - today).days)
        except ValueError:
            days_to_deadline = 30
        base = 1.0 - (completion_rate if completion_rate is not None else 0.65)
        overdue_pressure = min(0.3, max(0, -days_to_task) * 0.06)
        deadline_pressure = 0.2 if days_to_deadline <= 7 else 0.1 if days_to_deadline <= 21 else 0.0
        mastery_pressure = (
            0.15
            if task.mastery_level in {"unknown", "L0", "L1"}
            else 0.05
            if task.mastery_level == "L2"
            else 0.0
        )
        load_ratio = current_daily_load_mins / max(1, daily_capacity_mins)
        overload_pressure = min(0.25, max(0.0, load_ratio - 1.0) * 0.25)
        procrastination = (procrastination_score or 0.0) * 0.2
        probability = max(
            0.02,
            min(
                0.98,
                base * 0.35
                + overdue_pressure
                + deadline_pressure
                + mastery_pressure
                + overload_pressure
                + procrastination,
            ),
        )
        factors = []
        if overdue_pressure:
            factors.append("task_overdue")
        if deadline_pressure:
            factors.append("deadline_pressure")
        if mastery_pressure >= 0.15:
            factors.append("low_mastery")
        if overload_pressure:
            factors.append("daily_overload")
        if procrastination >= 0.1:
            factors.append("procrastination_pattern")
        return {
            "task_id": task.id,
            "title": task.title,
            "failure_probability": round(probability, 4),
            "risk_level": "high"
            if probability >= 0.7
            else "medium"
            if probability >= 0.4
            else "low",
            "factors": factors,
            "feature_snapshot": {
                "completion_rate": completion_rate,
                "procrastination_score": procrastination_score,
                "current_daily_load_mins": current_daily_load_mins,
                "daily_capacity_mins": daily_capacity_mins,
                "days_to_task": days_to_task,
                "days_to_deadline": days_to_deadline,
                "mastery_level": task.mastery_level,
            },
        }


class AdaptivePlanOptimizer:
    @classmethod
    async def assess_goal(cls, db: AsyncSession, user_id: str, goal_id: str) -> dict[str, Any]:
        goal = (
            await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
        ).scalar_one_or_none()
        if goal is None:
            raise LookupError("goal does not exist")
        context = await DecisionContextBuilder.build(db, user_id, goal_id=goal_id)
        cognitive = await CognitiveProfileBuilder.get_profile(db, user_id, goal_id)
        tasks = list(
            (
                await db.execute(
                    select(Task).where(
                        Task.goal_id == goal_id,
                        Task.status.in_(["pending", "in_progress"]),
                    )
                )
            ).scalars()
        )
        daily_load: dict[str, int] = {}
        for task in tasks:
            daily_load[task.scheduled_date] = (
                daily_load.get(task.scheduled_date, 0) + task.estimated_mins
            )
        completion_rate = (context.get("profile") or {}).get("completion_rate_30d")
        procrastination = cognitive.procrastination_score if cognitive else None
        risks = [
            FailurePredictor.predict(
                task,
                completion_rate=completion_rate,
                procrastination_score=procrastination,
                current_daily_load_mins=daily_load.get(task.scheduled_date, 0),
                daily_capacity_mins=max(15, round(goal.daily_hours * 60)),
                deadline=goal.deadline,
            )
            for task in tasks
        ]
        risks.sort(key=lambda row: row["failure_probability"], reverse=True)
        for task in tasks:
            risk = next(row for row in risks if row["task_id"] == task.id)
            await record_task_failure_prediction(
                db,
                user_id=user_id,
                goal_id=goal_id,
                task=task,
                probability=risk["failure_probability"],
                features=risk["feature_snapshot"],
            )
        await db.commit()
        gaps = await KnowledgeGraphService.detect_gaps(db, user_id, goal_id=goal_id, limit=5)
        return {
            "goal_id": goal_id,
            "risks": [
                {key: value for key, value in row.items() if key != "feature_snapshot"}
                for row in risks
            ],
            "high_risk_count": sum(row["risk_level"] == "high" for row in risks),
            "knowledge_gaps": gaps,
            "generated_at": utc_now().isoformat(),
        }

    @classmethod
    async def generate_proposal(
        cls, db: AsyncSession, user_id: str, goal_id: str
    ) -> dict[str, Any]:
        assessment = await cls.assess_goal(db, user_id, goal_id)
        context = await DecisionContextBuilder.build(db, user_id, goal_id=goal_id)
        goal_context = context["goal_context"]
        patterns = context.get("active_patterns", [])
        evidence_ids = [row["id"] for row in patterns[:5]]
        risks = assessment["risks"]
        top = risks[0] if risks else None
        tasks_by_id = {
            row.id: row
            for row in (await db.execute(select(Task).where(Task.goal_id == goal_id))).scalars()
        }

        if assessment["knowledge_gaps"]:
            gap = assessment["knowledge_gaps"][0]
            body = ProposalCreate(
                goal_id=goal_id,
                proposal_type="REVIEW_INSERTION",
                title=f"插入一次“{gap['name']}”复习",
                summary=f"预计知识保持率已降至 {gap['retention']:.0%}，建议在继续学习前安排一次短复习。",
                reasoning=["遗忘曲线已进入复习阈值。", "复习任务仍需你确认后才会加入计划。"],
                proposed_changes={
                    "goal_id": goal_id,
                    "concept_id": gap["id"],
                    "title": f"复习：{gap['name']}",
                    "scheduled_date": (date.today() + timedelta(days=1)).isoformat(),
                    "estimated_mins": 25,
                },
                evidence_references=evidence_ids,
                confidence=max(0.55, float(gap["gap_score"])),
                expires_at=utc_now() + timedelta(days=7),
            )
        elif top and top["failure_probability"] >= 0.65:
            task = tasks_by_id[top["task_id"]]
            if task.estimated_mins >= 60:
                first = max(15, task.estimated_mins // 2)
                second = max(15, task.estimated_mins - first)
                body = ProposalCreate(
                    goal_id=goal_id,
                    proposal_type="TASK_SPLIT",
                    title=f"拆分高风险任务“{task.title}”",
                    summary="将单个高负荷任务拆成两个可完成的小步骤，降低启动阻力。",
                    reasoning=[
                        f"预测失败概率为 {top['failure_probability']:.0%}。",
                        *[f"风险信号：{factor}" for factor in top["factors"][:3]],
                    ],
                    proposed_changes={
                        "original_task_id": task.id,
                        "new_tasks": [
                            {
                                "title": f"{task.title}（1/2）",
                                "estimated_mins": first,
                                "scheduled_date": max(
                                    task.scheduled_date, date.today().isoformat()
                                ),
                            },
                            {
                                "title": f"{task.title}（2/2）",
                                "estimated_mins": second,
                                "scheduled_date": max(
                                    task.scheduled_date,
                                    (date.today() + timedelta(days=1)).isoformat(),
                                ),
                            },
                        ],
                    },
                    evidence_references=evidence_ids,
                    confidence=top["failure_probability"],
                    expires_at=utc_now() + timedelta(days=7),
                )
            else:
                new_date = (date.today() + timedelta(days=1)).isoformat()
                body = ProposalCreate(
                    goal_id=goal_id,
                    proposal_type="PLAN_ADJUSTMENT",
                    title="重新分配高风险任务",
                    summary="根据当前负荷和截止日期压力，建议把最高风险任务移到下一可执行学习日。",
                    reasoning=[f"“{task.title}”预测失败概率为 {top['failure_probability']:.0%}。"],
                    proposed_changes={
                        "task_updates": [{"task_id": task.id, "scheduled_date": new_date}]
                    },
                    evidence_references=evidence_ids,
                    confidence=top["failure_probability"],
                    expires_at=utc_now() + timedelta(days=7),
                )
        elif top and "low_mastery" in top["factors"]:
            task = tasks_by_id[top["task_id"]]
            body = ProposalCreate(
                goal_id=goal_id,
                proposal_type="DIFFICULTY_ADJUST",
                title=f"降低“{task.title}”的首次挑战强度",
                summary="先减少单次投入并提高优先级，完成后再逐步增加难度。",
                reasoning=[
                    "当前掌握度较低。",
                    f"预测失败概率为 {top['failure_probability']:.0%}。",
                ],
                proposed_changes={
                    "task_id": task.id,
                    "estimated_mins": max(15, round(task.estimated_mins * 0.75)),
                    "priority": "high",
                },
                evidence_references=evidence_ids,
                confidence=max(0.5, top["failure_probability"]),
                expires_at=utc_now() + timedelta(days=7),
            )
        else:
            goal = goal_context["goal"]
            body = ProposalCreate(
                goal_id=goal_id,
                proposal_type="PLAN_ADJUSTMENT",
                title="保持当前计划，仅微调负荷",
                summary="当前没有显著高风险任务，建议维持结构并保留缓冲时间。",
                reasoning=["预测模型未发现需要立即干预的高风险任务。"],
                proposed_changes={"goal_id": goal_id, "daily_hours": goal["daily_hours"]},
                evidence_references=evidence_ids,
                confidence=0.55,
                expires_at=utc_now() + timedelta(days=7),
            )
        existing = await db.scalar(
            select(DecisionProposal)
            .where(
                DecisionProposal.user_id == user_id,
                DecisionProposal.goal_id == goal_id,
                DecisionProposal.proposal_type == body.proposal_type,
                DecisionProposal.status.in_(("pending", "accepted")),
            )
            .order_by(DecisionProposal.created_at.desc())
        )
        if existing is not None:
            return proposal_service.proposal_to_dict(existing)
        return await proposal_service.create_proposal(user_id, body, db, source="ai_agent")
