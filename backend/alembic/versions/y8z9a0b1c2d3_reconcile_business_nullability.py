"""Reconcile audited business-column nullability.

Revision ID: y8z9a0b1c2d3
Revises: x7y8z9a0b1c2
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "y8z9a0b1c2d3"
down_revision: str | None = "x7y8z9a0b1c2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TIMESTAMP_COLUMNS = {
    "agent_evals": ("created_at",),
    "decision_proposals": ("created_at", "updated_at"),
    "intelligence_cursors": ("created_at", "updated_at"),
    "knowledge_edges": ("created_at", "updated_at"),
    "learner_cognitive_profiles": ("created_at", "updated_at"),
    "learner_patterns": ("created_at", "updated_at"),
    "learner_profiles": ("created_at", "updated_at"),
    "learning_concepts": ("created_at", "updated_at"),
    "learning_events": ("created_at",),
    "learning_memories": ("created_at",),
    "pattern_evidences": ("created_at",),
    "proposal_feedback": ("created_at",),
}


def upgrade() -> None:
    for table, columns in TIMESTAMP_COLUMNS.items():
        for column in columns:
            op.execute(
                sa.text(f'UPDATE "{table}" SET "{column}" = CURRENT_TIMESTAMP '
                        f'WHERE "{column}" IS NULL')
            )
            op.alter_column(
                table,
                column,
                existing_type=sa.DateTime(),
                nullable=False,
            )

    op.execute(sa.text("UPDATE goals SET work_schedule = 'all' WHERE work_schedule IS NULL"))
    op.alter_column("goals", "work_schedule", existing_type=sa.String(), nullable=False)
    op.execute(sa.text("UPDATE plans SET created_by = 'ai' WHERE created_by IS NULL"))
    op.alter_column("plans", "created_by", existing_type=sa.String(), nullable=False)


def downgrade() -> None:
    op.alter_column("plans", "created_by", existing_type=sa.String(), nullable=True)
    op.alter_column("goals", "work_schedule", existing_type=sa.String(), nullable=True)
    for table, columns in reversed(tuple(TIMESTAMP_COLUMNS.items())):
        for column in reversed(columns):
            op.alter_column(
                table,
                column,
                existing_type=sa.DateTime(),
                nullable=True,
            )
