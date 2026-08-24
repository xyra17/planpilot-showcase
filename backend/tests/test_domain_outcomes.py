import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from src.core.time import utc_now
from src.events.publisher import emit
from src.models import (
    AgentFeedbackEvent,
    AgentRun,
    AgentStep,
    DecisionProposal,
    Goal,
    InsightActionRun,
    Task,
    User,
)
from src.services.feedback_learning_service import compute_delayed_outcomes


@pytest.mark.asyncio
async def test_delayed_proposal_outcomes_link_exact_targets_at_1d_and_7d(db) -> None:
    user = User(
        email=f"outcome-{uuid.uuid4().hex}@test.com",
        username=f"outcome-{uuid.uuid4().hex[:12]}",
        hashed_password="not-used",
    )
    db.add(user)
    await db.flush()
    goal = Goal(
        user_id=user.id,
        type="skill",
        title="Outcome",
        deadline="2027-12-31",
        daily_hours=1,
    )
    db.add(goal)
    await db.flush()
    tasks = [
        Task(goal_id=goal.id, title="A", scheduled_date="2026-08-10"),
        Task(goal_id=goal.id, title="B", scheduled_date="2026-08-11"),
    ]
    db.add_all(tasks)
    await db.flush()
    applied_at = utc_now() - timedelta(days=8)
    snapshot_tasks = {
        task.id: {
            "version": task.version,
            "status": "pending",
            "scheduled_date": task.scheduled_date,
        }
        for task in tasks
    }
    proposal = DecisionProposal(
        user_id=user.id,
        goal_id=goal.id,
        proposal_type="reschedule_overdue_tasks",
        title="Reschedule",
        confidence=0.8,
        status="applied",
        lifecycle_status="applied",
        applied_at=applied_at,
        application_snapshot={
            "schema_version": "proposal-application-v1",
            "applied_at": applied_at.isoformat(),
            "after": {"tasks": snapshot_tasks},
            "target_task_ids": [task.id for task in tasks],
        },
    )
    db.add(proposal)
    await db.flush()
    run = AgentRun(
        user_id=user.id,
        goal_id=goal.id,
        request_text="reschedule",
        status="completed",
    )
    db.add(run)
    await db.flush()
    operations = [
        {
            "operation_id": str(uuid.uuid4()),
            "entity": "task",
            "entity_id": task.id,
            "field": "scheduled_date",
            "before": task.scheduled_date,
            "after": task.scheduled_date,
            "label": task.title,
            "reason": "test",
        }
        for task in tasks
    ]
    db.add(
        AgentStep(
            run_id=run.id,
            step_index=0,
            step_key="v1:apply",
            tool_name="tasks.apply_changes",
            status="completed",
            output_data={"undo_operations": operations},
        )
    )
    db.add(
        InsightActionRun(
            insight_id=proposal.id,
            run_id=run.id,
            status="applied",
            is_active=False,
            change_set_id="changeset-outcome",
        )
    )
    await emit(
        db,
        user_id=user.id,
        goal_id=goal.id,
        aggregate_type="task",
        aggregate_id=tasks[0].id,
        event_type="TaskCompleted",
        payload={},
        occurred_at=applied_at + timedelta(hours=12),
    )
    await emit(
        db,
        user_id=user.id,
        goal_id=goal.id,
        aggregate_type="task",
        aggregate_id=tasks[1].id,
        event_type="TaskCompleted",
        payload={},
        occurred_at=applied_at + timedelta(days=3),
    )
    await db.commit()

    assert await compute_delayed_outcomes(db, days=1) == 1
    assert await compute_delayed_outcomes(db, days=7) == 1
    assert await compute_delayed_outcomes(db, days=7) == 0

    rows = list(
        (
            await db.execute(
                select(AgentFeedbackEvent)
                .where(AgentFeedbackEvent.proposal_id == proposal.id)
                .order_by(AgentFeedbackEvent.attribution_window)
            )
        ).scalars()
    )
    by_window = {row.attribution_window: row.value for row in rows}
    assert by_window["1d"]["completion_rate"] == 0.5
    assert by_window["7d"]["completion_rate"] == 1.0
    assert by_window["7d"]["change_set_id"] == "changeset-outcome"
    assert by_window["7d"]["operation_count"] == 2
    assert {row.run_id for row in rows} == {run.id}
