"""Refresh the persisted demo audit after a plan-only migration."""
from __future__ import annotations
import asyncio, json
from pathlib import Path
from sqlalchemy import select, text, func
from src.database import AsyncSessionLocal
from src.models import User, Goal, Plan, Task, KnowledgeItem

REPORT = Path("evaluations/admin-junior-student-journey-20260906/journey-audit.json")

async def main() -> None:
    data = json.loads(REPORT.read_text(encoding="utf-8"))
    async with AsyncSessionLocal() as db:
        admin = (await db.execute(select(User).where(User.is_admin.is_(True)).limit(1))).scalar_one()
        goals = list((await db.execute(select(Goal).where(Goal.user_id == admin.id))).scalars().all())
        sources = int(await db.scalar(select(func.count(KnowledgeItem.id)).where(KnowledgeItem.user_id == admin.id, KnowledgeItem.source_type == "upload")) or 0)
        ready = int(await db.scalar(select(func.count(KnowledgeItem.id)).where(KnowledgeItem.user_id == admin.id, KnowledgeItem.source_type == "upload", KnowledgeItem.processing_status == "ready")) or 0)
        notes = int(await db.scalar(text("SELECT count(*) FROM knowledge_items WHERE user_id=:uid AND source_role='note'"), {"uid": admin.id}) or 0)
        tasks = int(await db.scalar(text("SELECT count(*) FROM tasks WHERE goal_id IN (SELECT id FROM goals WHERE user_id=:uid)"), {"uid": admin.id}) or 0)
        conversations = int(await db.scalar(text("SELECT count(*) FROM coach_conversations WHERE user_id=:uid"), {"uid": admin.id}) or 0)
        plans = []
        for goal in goals:
            plan = (await db.execute(select(Plan).where(Plan.goal_id == goal.id, Plan.is_current.is_(True)))).scalar_one_or_none()
            count = int(await db.scalar(select(func.count(Task.id)).where(Task.plan_id == plan.id)) or 0) if plan else 0
            plans.append({"goal_id": goal.id, "goal": goal.title, "plan_id": plan.id if plan else None, "phases": len((plan.baseline or {}).get("phases", [])) if plan else 0, "tasks": count, "source_grounded_tasks": sum(bool(t.execution_guide and t.execution_guide.get("source_refs")) for t in (await db.execute(select(Task).where(Task.plan_id == plan.id))).scalars().all()) if plan else 0})
    actual = data["steps"][-1]["actual"]
    actual.update({"goal_count": len(goals), "conversation_count": conversations, "sources": sources, "ready_sources": ready, "notes": notes, "tasks": tasks, "macro_plans": plans})
    data["steps"][-1]["passed"] = len(goals) == 3 and sources == ready and ready >= 15 and notes >= 19 and tasks >= 21 and conversations >= 4 and all(p["phases"] == 4 and p["tasks"] == 12 and p["source_grounded_tasks"] == 12 for p in plans)
    data["steps"][-1]["expected"] = "3 goals / 15 ready real files / 4 four-stage plans with 36 cited tasks / longitudinal notes, recovery, Pilo and evidence"
    data["passed"] = all(step["passed"] for step in data["steps"])
    REPORT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": data["passed"], "last_step": data["steps"][-1]}, ensure_ascii=False))

if __name__ == "__main__": asyncio.run(main())
