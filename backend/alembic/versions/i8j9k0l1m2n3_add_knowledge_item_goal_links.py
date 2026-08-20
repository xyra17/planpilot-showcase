"""allow knowledge resources to link to multiple goals

Revision ID: i8j9k0l1m2n3
Revises: h7i8j9k0l1m2
Create Date: 2026-08-06
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "i8j9k0l1m2n3"
down_revision: str | None = "h7i8j9k0l1m2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "knowledge_item_goal_links",
        sa.Column("item_id", sa.String(), nullable=False),
        sa.Column("goal_id", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["item_id"], ["knowledge_items.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["goal_id"], ["goals.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("item_id", "goal_id"),
    )
    op.create_index(
        "ix_knowledge_item_goal_links_goal_id",
        "knowledge_item_goal_links",
        ["goal_id"],
        unique=False,
    )
    op.execute(
        """
        INSERT INTO knowledge_item_goal_links (item_id, goal_id)
        SELECT id, goal_id
        FROM knowledge_items
        WHERE goal_id IS NOT NULL
        ON CONFLICT (item_id, goal_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_index("ix_knowledge_item_goal_links_goal_id", table_name="knowledge_item_goal_links")
    op.drop_table("knowledge_item_goal_links")
