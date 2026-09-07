"""Replace only admin's empty model-timeout plans with complete source-grounded plans.

This migration intentionally preserves goals, sources, notes, conversations, evidence,
completed tasks and account settings. Run from the API container after the source seed.
"""

from __future__ import annotations

import asyncio
import json
from datetime import date, timedelta

from sqlalchemy import select, func

from src.database import AsyncSessionLocal
from src.models import Goal, KnowledgeItem, Plan, Task, User
from scripts.seed_admin_junior_student_journey import FALLBACK_MACRO_PLANS, GOALS, SOURCES, persist_fallback_macro_plan


async def main() -> dict:
    result: dict[str, object] = {"migrated": [], "skipped": [], "missing_sources": []}
    async with AsyncSessionLocal() as db:
        admin = (
            await db.execute(select(User).where(User.is_admin.is_(True)).limit(1))
        ).scalar_one_or_none()
        if not admin:
            raise RuntimeError("admin account not found")
        goals = list((await db.execute(select(Goal).where(Goal.user_id == admin.id))).scalars().all())
        items = list(
            (await db.execute(select(KnowledgeItem).where(KnowledgeItem.user_id == admin.id)))
            .scalars()
            .all()
        )
        by_key: dict[str, str] = {}
        for source_group in SOURCES.values():
            for source in source_group:
                for item in items:
                    metadata = item.source_metadata or {}
                    if metadata.get("local_artifact") == source.get("filename") or item.title == source.get("title"):
                        by_key[source["key"]] = item.id
                        break
        for goal_spec in GOALS:
            goal = next((g for g in goals if g.title == goal_spec["title"]), None)
            if not goal:
                result["skipped"].append({"key": goal_spec["key"], "reason": "goal_missing"})
                continue
            missing = sorted(
                {
                    source["key"]
                    for source in SOURCES[goal_spec["key"]]
                    if source["key"] not in by_key
                }
            )
            if missing:
                result["missing_sources"].append({"key": goal_spec["key"], "sources": missing})
                continue
            current = (
                await db.execute(
                    select(Plan)
                    .where(Plan.goal_id == goal.id, Plan.is_current.is_(True))
                    .order_by(Plan.created_at.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            task_count = int(await db.scalar(select(func.count(Task.id)).where(Task.plan_id == current.id)) or 0) if current else 0
            if current and task_count > 0 and (current.content or {}).get("lifecycle", {}).get("generated_by") == "deterministic_source_grounded_fallback":
                tasks = list((await db.execute(select(Task).where(Task.plan_id == current.id).order_by(Task.sequence_in_plan))).scalars().all())
                cursor = 0
                phases = (current.baseline or {}).get("phases", [])
                for phase_index, phase_spec in enumerate(FALLBACK_MACRO_PLANS[goal_spec["key"]]):
                    start = date.fromisoformat(phase_spec["start_date"])
                    end = date.fromisoformat(phase_spec["end_date"])
                    span = max(0, (end - start).days)
                    for index, _ in enumerate(phase_spec["tasks"]):
                        scheduled = start + timedelta(days=round(span * (index + 1) / (len(phase_spec["tasks"]) + 1)))
                        tasks[cursor].scheduled_date = scheduled.isoformat()
                        phases[phase_index]["tasks"][index]["scheduled_date"] = scheduled.isoformat()
                        cursor += 1
                current.baseline = {**(current.baseline or {}), "phases": phases}
                await db.commit()
                result["skipped"].append({"key": goal_spec["key"], "reason": "normalized_existing_source_grounded_plan", "tasks": task_count})
                continue
            if current and task_count > 0 and current.created_by != "system_fallback":
                result["skipped"].append({"key": goal_spec["key"], "reason": "non_empty_current_plan", "tasks": task_count})
                continue
            plan_id, task_ids = await persist_fallback_macro_plan(
                db,
                key=goal_spec["key"],
                goal_id=goal.id,
                goal_snapshot={"intent_version": goal.intent_version or 1, "contract": goal.contract or {}},
                source_ids=by_key,
                reason="将模型超时产生的空计划替换为资料驱动的可执行计划",
                replace_current=True,
            )
            result["migrated"].append({"key": goal_spec["key"], "plan_id": plan_id, "tasks": len(task_ids)})
    return result


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main()), ensure_ascii=False, indent=2))
