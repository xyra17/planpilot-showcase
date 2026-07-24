"""add_learning_debt

Revision ID: c1d2e3f4a5b6
Revises: b4c5d6e7f8a9
Create Date: 2026-07-20

"""
from alembic import op
import sqlalchemy as sa

revision = "c1d2e3f4a5b6"
down_revision = "b4c5d6e7f8a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "learning_debts",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("goal_id", sa.String(), nullable=False),
        sa.Column("task_id", sa.String(), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("estimated_hours", sa.Float(), nullable=False, server_default="0"),
        sa.Column("skip_reason", sa.Text(), nullable=True),
        sa.Column("impact", sa.String(), nullable=False, server_default="medium"),
        sa.Column("status", sa.String(), nullable=False, server_default="open"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["goal_id"], ["goals.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_learning_debts_goal_id", "learning_debts", ["goal_id"])
    op.create_index("ix_learning_debts_task_id", "learning_debts", ["task_id"])


def downgrade() -> None:
    op.drop_index("ix_learning_debts_task_id", "learning_debts")
    op.drop_index("ix_learning_debts_goal_id", "learning_debts")
    op.drop_table("learning_debts")
