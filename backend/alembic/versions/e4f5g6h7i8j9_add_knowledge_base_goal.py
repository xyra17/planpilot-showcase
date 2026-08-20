"""associate knowledge bases with goals

Revision ID: e4f5g6h7i8j9
Revises: d3e4f5g6h7i8
Create Date: 2026-08-03
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e4f5g6h7i8j9"
down_revision: str | None = "d3e4f5g6h7i8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("knowledge_bases", sa.Column("goal_id", sa.String(), nullable=True))
    op.create_index(
        op.f("ix_knowledge_bases_goal_id"),
        "knowledge_bases",
        ["goal_id"],
        unique=False,
    )
    op.create_foreign_key(
        "fk_knowledge_bases_goal_id_goals",
        "knowledge_bases",
        "goals",
        ["goal_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column(
        "knowledge_items",
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
    )


def downgrade() -> None:
    op.drop_column("knowledge_items", "summary")
    op.drop_constraint(
        "fk_knowledge_bases_goal_id_goals",
        "knowledge_bases",
        type_="foreignkey",
    )
    op.drop_index(op.f("ix_knowledge_bases_goal_id"), table_name="knowledge_bases")
    op.drop_column("knowledge_bases", "goal_id")
