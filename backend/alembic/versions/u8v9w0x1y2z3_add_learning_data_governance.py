"""add learning data governance

Revision ID: u8v9w0x1y2z3
Revises: t7u8v9w0x1y2
"""

import sqlalchemy as sa

from alembic import op

revision = "u8v9w0x1y2z3"
down_revision = "t7u8v9w0x1y2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_data_consents",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("personalization_enabled", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("experiments_enabled", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("product_analytics_enabled", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("sensitive_inference_enabled", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("policy_version", sa.String(length=32), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )
    op.create_table(
        "consent_audit_events",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("purposes", sa.JSON(), nullable=False),
        sa.Column("policy_version", sa.String(length=32), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("request_id", sa.String(length=100), nullable=True),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("request_id"),
    )
    op.create_index("ix_consent_audit_events_user_id", "consent_audit_events", ["user_id"])
    op.create_index("ix_consent_audit_events_occurred_at", "consent_audit_events", ["occurred_at"])
    op.create_table(
        "data_export_audits",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("schema_version", sa.String(length=32), nullable=False),
        sa.Column("section_counts", sa.JSON(), nullable=False),
        sa.Column("requested_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_data_export_audits_user_id", "data_export_audits", ["user_id"])
    op.create_index("ix_data_export_audits_requested_at", "data_export_audits", ["requested_at"])
    op.create_table(
        "data_quality_snapshots",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("schema_version", sa.String(length=32), nullable=False),
        sa.Column("window_days", sa.Integer(), nullable=False),
        sa.Column("quality_score", sa.Float(), nullable=False),
        sa.Column("report", sa.JSON(), nullable=False),
        sa.Column("sampled_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_data_quality_snapshots_user_id", "data_quality_snapshots", ["user_id"])
    op.create_index("ix_data_quality_snapshots_sampled_at", "data_quality_snapshots", ["sampled_at"])


def downgrade() -> None:
    op.drop_table("data_quality_snapshots")
    op.drop_table("data_export_audits")
    op.drop_table("consent_audit_events")
    op.drop_table("user_data_consents")
