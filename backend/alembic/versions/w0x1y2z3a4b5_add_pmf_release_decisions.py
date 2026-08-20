"""add PMF and release decisions

Revision ID: w0x1y2z3a4b5
Revises: v9w0x1y2z3a4
"""

import sqlalchemy as sa

from alembic import op

revision = "w0x1y2z3a4b5"
down_revision = "v9w0x1y2z3a4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "product_feedback_signals",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("signal_type", sa.String(length=64), nullable=False),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column("request_id", sa.String(length=100), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("request_id"),
    )
    op.create_index("ix_product_feedback_signals_user_id", "product_feedback_signals", ["user_id"])
    op.create_index("ix_product_feedback_signals_signal_type", "product_feedback_signals", ["signal_type"])
    op.create_index("ix_product_feedback_signals_occurred_at", "product_feedback_signals", ["occurred_at"])
    op.create_table(
        "product_validation_snapshots",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("schema_version", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("report", sa.JSON(), nullable=False),
        sa.Column("generated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_product_validation_snapshots_status", "product_validation_snapshots", ["status"])
    op.create_index("ix_product_validation_snapshots_generated_at", "product_validation_snapshots", ["generated_at"])
    op.create_table(
        "production_readiness_decisions",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("decision", sa.String(length=32), nullable=False),
        sa.Column("reason_codes", sa.JSON(), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("canary_release_id", sa.String(), nullable=True),
        sa.Column("actor", sa.String(), nullable=False),
        sa.Column("generated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["canary_release_id"], ["canary_releases.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_production_readiness_decisions_decision", "production_readiness_decisions", ["decision"])
    op.create_index("ix_production_readiness_decisions_canary_release_id", "production_readiness_decisions", ["canary_release_id"])
    op.create_index("ix_production_readiness_decisions_generated_at", "production_readiness_decisions", ["generated_at"])


def downgrade() -> None:
    op.drop_table("production_readiness_decisions")
    op.drop_table("product_validation_snapshots")
    op.drop_table("product_feedback_signals")
