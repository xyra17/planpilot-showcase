"""Agent V2.5 lifecycle, trace and pending intent state."""

import sqlalchemy as sa

from alembic import op

revision: str = "c6d7e8f9g0h1"
down_revision: str | None = "b5c6d7e8f9g0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "decision_proposals",
        sa.Column("lifecycle_status", sa.String(), nullable=False, server_default="insight"),
    )
    op.create_index(
        "ix_decision_proposals_lifecycle_status",
        "decision_proposals",
        ["lifecycle_status"],
    )
    op.add_column("agent_runs", sa.Column("conversation_turn_id", sa.String(), nullable=True))
    op.add_column("agent_runs", sa.Column("insight_id", sa.String(), nullable=True))
    op.add_column(
        "agent_runs", sa.Column("trace_context", sa.JSON(), nullable=False, server_default=sa.text("'{}'"))
    )
    op.add_column("agent_runs", sa.Column("input_received_at", sa.DateTime(), nullable=True))
    op.add_column("agent_runs", sa.Column("preview_ready_at", sa.DateTime(), nullable=True))
    op.create_index("ix_agent_runs_conversation_turn_id", "agent_runs", ["conversation_turn_id"])
    op.create_index("ix_agent_runs_insight_id", "agent_runs", ["insight_id"])
    op.create_foreign_key(
        "fk_agent_runs_insight_id_decision_proposals",
        "agent_runs",
        "decision_proposals",
        ["insight_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_table(
        "insight_action_runs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("insight_id", sa.String(), nullable=False),
        sa.Column("run_id", sa.String(), nullable=False, unique=True),
        sa.Column("status", sa.String(), nullable=False, server_default="converted"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("attempt_number", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("change_set_id", sa.String(), nullable=True),
        sa.Column("approval_id", sa.String(), nullable=True),
        sa.Column("history", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["insight_id"], ["decision_proposals.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run_id"], ["agent_runs.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_insight_action_runs_insight_id", "insight_action_runs", ["insight_id"])
    op.create_index("ix_insight_action_runs_status", "insight_action_runs", ["status"])
    op.create_index("ix_insight_action_runs_is_active", "insight_action_runs", ["is_active"])
    op.create_index("ix_insight_action_runs_change_set_id", "insight_action_runs", ["change_set_id"])
    op.create_index("ix_insight_action_runs_approval_id", "insight_action_runs", ["approval_id"])
    op.create_index(
        "uq_insight_action_run_active",
        "insight_action_runs",
        ["insight_id"],
        unique=True,
        postgresql_where=sa.text("is_active IS TRUE"),
        sqlite_where=sa.text("is_active IS 1"),
    )
    op.create_table(
        "pending_action_intents",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("session_id", sa.String(), nullable=False),
        sa.Column("conversation_turn_id", sa.String(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("missing_slots", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("user_id", "session_id", name="uq_pending_action_user_session"),
    )
    op.create_index("ix_pending_action_intents_user_id", "pending_action_intents", ["user_id"])
    op.create_index("ix_pending_action_intents_conversation_turn_id", "pending_action_intents", ["conversation_turn_id"])
    op.create_index("ix_pending_action_intents_expires_at", "pending_action_intents", ["expires_at"])
    op.add_column("agent_feedback_events", sa.Column("run_id", sa.String(), nullable=True))
    op.create_index("ix_agent_feedback_events_run_id", "agent_feedback_events", ["run_id"])
    op.create_foreign_key(
        "fk_agent_feedback_events_run_id_agent_runs",
        "agent_feedback_events",
        "agent_runs",
        ["run_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_agent_feedback_events_run_id_agent_runs", "agent_feedback_events", type_="foreignkey")
    op.drop_index("ix_agent_feedback_events_run_id", table_name="agent_feedback_events")
    op.drop_column("agent_feedback_events", "run_id")
    op.drop_table("pending_action_intents")
    op.drop_table("insight_action_runs")
    op.drop_constraint("fk_agent_runs_insight_id_decision_proposals", "agent_runs", type_="foreignkey")
    op.drop_index("ix_agent_runs_insight_id", table_name="agent_runs")
    op.drop_index("ix_agent_runs_conversation_turn_id", table_name="agent_runs")
    op.drop_column("agent_runs", "preview_ready_at")
    op.drop_column("agent_runs", "input_received_at")
    op.drop_column("agent_runs", "trace_context")
    op.drop_column("agent_runs", "insight_id")
    op.drop_column("agent_runs", "conversation_turn_id")
    op.drop_index("ix_decision_proposals_lifecycle_status", table_name="decision_proposals")
    op.drop_column("decision_proposals", "lifecycle_status")
