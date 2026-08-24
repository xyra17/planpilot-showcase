"""Add server-controlled Action beta evidence foundation."""

import sqlalchemy as sa

from alembic import op

revision: str = "e8f9g0h1i2j3"
down_revision: str | None = "d7e8f9g0h1i2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_beta_controls",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("beta_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("new_action_runs_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("cohort_mode", sa.String(24), nullable=False, server_default="allowlist"),
        sa.Column("traffic_percent", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("allowlisted_user_ids", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("metric_version", sa.String(64), nullable=False, server_default="action-beta-funnel-v1"),
        sa.Column("paused_reason", sa.Text(), nullable=True),
        sa.Column("safety_snapshot", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("updated_by", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("traffic_percent IN (0, 5, 20, 50)", name="ck_agent_beta_traffic_stage"),
        sa.CheckConstraint("cohort_mode IN ('allowlist', 'percentage')", name="ck_agent_beta_cohort_mode"),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "agent_beta_control_events",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("control_id", sa.String(), nullable=False),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("actor_id", sa.String(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("before_state", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("after_state", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["control_id"], ["agent_beta_controls.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_agent_beta_control_events_control_id", "agent_beta_control_events", ["control_id"])
    op.create_index("ix_agent_beta_control_events_action", "agent_beta_control_events", ["action"])
    op.bulk_insert(
        sa.table(
            "agent_beta_controls",
            sa.column("id", sa.String()),
            sa.column("beta_enabled", sa.Boolean()),
            sa.column("new_action_runs_enabled", sa.Boolean()),
            sa.column("cohort_mode", sa.String()),
            sa.column("traffic_percent", sa.Integer()),
            sa.column("allowlisted_user_ids", sa.JSON()),
            sa.column("metric_version", sa.String()),
            sa.column("safety_snapshot", sa.JSON()),
        ),
        [{
            "id": "action-beta",
            "beta_enabled": False,
            "new_action_runs_enabled": True,
            "cohort_mode": "allowlist",
            "traffic_percent": 0,
            "allowlisted_user_ids": [],
            "metric_version": "action-beta-funnel-v1",
            "safety_snapshot": {},
        }],
    )
    op.create_table(
        "agent_beta_review_samples",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("source_kind", sa.String(32), nullable=False),
        sa.Column("source_id", sa.String(), nullable=False),
        sa.Column("run_id", sa.String(), nullable=True),
        sa.Column("conversation_turn_id", sa.String(), nullable=True),
        sa.Column("pseudonymous_user_key", sa.String(64), nullable=False),
        sa.Column("sample_type", sa.String(48), nullable=False),
        sa.Column("structured_context", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("redacted_summary", sa.Text(), nullable=True),
        sa.Column("status", sa.String(24), nullable=False, server_default="pending"),
        sa.Column("reviewer_id", sa.String(), nullable=True),
        sa.Column("reviewer_note", sa.Text(), nullable=True),
        sa.Column("candidate_dataset_id", sa.String(), nullable=True),
        sa.Column("retention_expires_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("status IN ('pending', 'reviewed', 'confirmed', 'dismissed')", name="ck_agent_beta_review_status"),
        sa.ForeignKeyConstraint(["candidate_dataset_id"], ["evaluation_datasets.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["reviewer_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["run_id"], ["agent_runs.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_kind", "source_id", "sample_type", name="uq_agent_beta_review_source_type"),
    )
    for name, columns in (
        ("ix_agent_beta_review_samples_run_id", ["run_id"]),
        ("ix_agent_beta_review_samples_conversation_turn_id", ["conversation_turn_id"]),
        ("ix_agent_beta_review_samples_pseudonymous_user_key", ["pseudonymous_user_key"]),
        ("ix_agent_beta_review_samples_sample_type", ["sample_type"]),
        ("ix_agent_beta_review_samples_status", ["status"]),
        ("ix_agent_beta_review_samples_retention_expires_at", ["retention_expires_at"]),
    ):
        op.create_index(name, "agent_beta_review_samples", columns)


def downgrade() -> None:
    op.drop_table("agent_beta_review_samples")
    op.drop_table("agent_beta_control_events")
    op.drop_table("agent_beta_controls")
