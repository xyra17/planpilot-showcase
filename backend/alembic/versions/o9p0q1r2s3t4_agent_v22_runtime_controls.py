"""add agent v2.2 runtime controls

Revision ID: o9p0q1r2s3t4
Revises: n8o9p0q1r2s3
Create Date: 2026-07-27
"""

from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa

from alembic import op

revision: str = "o9p0q1r2s3t4"
down_revision: Union[str, None] = "n8o9p0q1r2s3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    run_columns = (
        sa.Column("run_kind", sa.String(), server_default="user", nullable=False),
        sa.Column("plan_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("state_version", sa.Integer(), server_default="0", nullable=False),
        sa.Column("steps_consumed", sa.Integer(), server_default="0", nullable=False),
        sa.Column("tokens_consumed", sa.Integer(), server_default="0", nullable=False),
        sa.Column("tool_time_budget_ms", sa.Integer(), server_default="600000", nullable=False),
        sa.Column("tool_time_consumed_ms", sa.Integer(), server_default="0", nullable=False),
        sa.Column("replan_budget", sa.Integer(), server_default="2", nullable=False),
        sa.Column("replan_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("worker_id", sa.String(), nullable=True),
        sa.Column("lease_token", sa.String(), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("deadline_at", sa.DateTime(), nullable=True),
    )
    for column in run_columns:
        op.add_column("agent_runs", column)
    op.create_index("ix_agent_runs_lease_token", "agent_runs", ["lease_token"])
    op.create_index("ix_agent_runs_lease_expires_at", "agent_runs", ["lease_expires_at"])

    step_columns = (
        sa.Column("step_key", sa.String(), nullable=True),
        sa.Column("plan_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("input_refs", sa.JSON(), server_default=sa.text("'{}'::json"), nullable=False),
        sa.Column("depends_on", sa.JSON(), server_default=sa.text("'[]'::json"), nullable=False),
        sa.Column("on_failure", sa.String(), server_default="fail", nullable=False),
        sa.Column("rationale", sa.Text(), server_default="", nullable=False),
        sa.Column("error_data", sa.JSON(), nullable=True),
        sa.Column("state_version", sa.Integer(), server_default="0", nullable=False),
        sa.Column("tool_time_ms", sa.Integer(), server_default="0", nullable=False),
        sa.Column("token_usage", sa.Integer(), server_default="0", nullable=False),
    )
    for column in step_columns:
        op.add_column("agent_steps", column)
    op.execute("UPDATE agent_steps SET step_key = 'v1:step-' || step_index::text")
    op.alter_column("agent_steps", "step_key", nullable=False)
    op.drop_constraint("uq_agent_step_run_index", "agent_steps", type_="unique")
    op.create_unique_constraint(
        "uq_agent_step_run_plan_index", "agent_steps", ["run_id", "plan_version", "step_index"]
    )
    op.create_unique_constraint("uq_agent_step_run_key", "agent_steps", ["run_id", "step_key"])

    op.add_column(
        "agent_approvals",
        sa.Column("change_set_version", sa.Integer(), server_default="1", nullable=False),
    )
    op.add_column(
        "agent_approvals",
        sa.Column("run_state_version", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column(
        "agent_approvals",
        sa.Column(
            "policy_decision", sa.JSON(), server_default=sa.text("'{}'::json"), nullable=False
        ),
    )
    op.add_column(
        "agent_audit_events",
        sa.Column("schema_version", sa.Integer(), server_default="1", nullable=False),
    )
    op.add_column("agent_audit_events", sa.Column("safe_summary", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("agent_audit_events", "safe_summary")
    op.drop_column("agent_audit_events", "schema_version")
    op.drop_column("agent_approvals", "policy_decision")
    op.drop_column("agent_approvals", "run_state_version")
    op.drop_column("agent_approvals", "change_set_version")
    op.drop_constraint("uq_agent_step_run_key", "agent_steps", type_="unique")
    op.drop_constraint("uq_agent_step_run_plan_index", "agent_steps", type_="unique")
    op.create_unique_constraint("uq_agent_step_run_index", "agent_steps", ["run_id", "step_index"])
    for name in (
        "token_usage",
        "tool_time_ms",
        "state_version",
        "error_data",
        "rationale",
        "on_failure",
        "depends_on",
        "input_refs",
        "plan_version",
        "step_key",
    ):
        op.drop_column("agent_steps", name)
    op.drop_index("ix_agent_runs_lease_expires_at", table_name="agent_runs")
    op.drop_index("ix_agent_runs_lease_token", table_name="agent_runs")
    for name in (
        "deadline_at",
        "started_at",
        "heartbeat_at",
        "lease_expires_at",
        "lease_token",
        "worker_id",
        "replan_count",
        "replan_budget",
        "tool_time_consumed_ms",
        "tool_time_budget_ms",
        "tokens_consumed",
        "steps_consumed",
        "state_version",
        "plan_version",
        "run_kind",
    ):
        op.drop_column("agent_runs", name)
