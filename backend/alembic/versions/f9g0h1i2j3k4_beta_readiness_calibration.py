"""Calibrate Beta funnel activation and safety observation metadata."""

import sqlalchemy as sa

from alembic import op

revision: str = "f9g0h1i2j3k4"
down_revision: str | None = "e8f9g0h1i2j3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_beta_controls",
        sa.Column(
            "measurement_started_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.execute(
        "UPDATE agent_beta_controls "
        "SET metric_version = 'action-beta-funnel-v2', safety_snapshot = '{}'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE agent_beta_controls SET metric_version = 'action-beta-funnel-v1'"
    )
    op.drop_column("agent_beta_controls", "measurement_started_at")
