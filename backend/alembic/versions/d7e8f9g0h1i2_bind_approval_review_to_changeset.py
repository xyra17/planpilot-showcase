"""Bind approval review and policy snapshots to the reviewed ChangeSet."""

import sqlalchemy as sa

from alembic import op

revision: str = "d7e8f9g0h1i2"
down_revision: str | None = "c6d7e8f9g0h1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_approvals",
        sa.Column("review_snapshot", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.add_column(
        "agent_approvals", sa.Column("reviewed_change_hash", sa.String(64), nullable=True)
    )
    op.add_column("agent_approvals", sa.Column("review_hash", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("agent_approvals", "review_hash")
    op.drop_column("agent_approvals", "reviewed_change_hash")
    op.drop_column("agent_approvals", "review_snapshot")
