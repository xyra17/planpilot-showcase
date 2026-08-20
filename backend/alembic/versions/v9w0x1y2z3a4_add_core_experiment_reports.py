"""add core experiment reports

Revision ID: v9w0x1y2z3a4
Revises: u8v9w0x1y2z3
"""

import sqlalchemy as sa

from alembic import op

revision = "v9w0x1y2z3a4"
down_revision = "u8v9w0x1y2z3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "experiment_variants",
        sa.Column("treatment_config", sa.JSON(), server_default="{}", nullable=False),
    )
    op.create_table(
        "learning_experiment_reports",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("experiment_key", sa.String(length=64), nullable=False),
        sa.Column("scope_key", sa.String(length=100), nullable=False),
        sa.Column("schema_version", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("parameters", sa.JSON(), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False),
        sa.Column("generated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_learning_experiment_reports_experiment_key",
        "learning_experiment_reports",
        ["experiment_key"],
    )
    op.create_index(
        "ix_learning_experiment_reports_scope_key",
        "learning_experiment_reports",
        ["scope_key"],
    )
    op.create_index(
        "ix_learning_experiment_reports_status",
        "learning_experiment_reports",
        ["status"],
    )
    op.create_index(
        "ix_learning_experiment_reports_generated_at",
        "learning_experiment_reports",
        ["generated_at"],
    )


def downgrade() -> None:
    op.drop_table("learning_experiment_reports")
    op.drop_column("experiment_variants", "treatment_config")
