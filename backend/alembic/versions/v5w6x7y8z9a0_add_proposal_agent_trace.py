"""add proposal agent provenance and trace

Revision ID: v5w6x7y8z9a0
Revises: u4v5w6x7y8z9
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "v5w6x7y8z9a0"
down_revision: str | None = "u4v5w6x7y8z9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "decision_proposals",
        sa.Column("source", sa.String(), nullable=False, server_default="ai_agent"),
    )
    op.add_column("decision_proposals", sa.Column("model_name", sa.String(), nullable=True))
    op.add_column(
        "decision_proposals",
        sa.Column("agent_trace", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )


def downgrade() -> None:
    op.drop_column("decision_proposals", "agent_trace")
    op.drop_column("decision_proposals", "model_name")
    op.drop_column("decision_proposals", "source")
