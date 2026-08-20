"""add note task snapshot and timestamps

Revision ID: l6m7n8o9p0q1
Revises: k5l6m7n8o9p0
Create Date: 2026-07-26
"""

from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa

from alembic import op

revision: str = "l6m7n8o9p0q1"
down_revision: Union[str, None] = "k5l6m7n8o9p0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "knowledge_items",
        sa.Column("task_title_snapshot", sa.Text(), nullable=True),
    )
    op.add_column(
        "knowledge_items",
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=True,
        ),
    )
    op.execute("UPDATE knowledge_items SET updated_at = created_at WHERE updated_at IS NULL")
    op.alter_column(
        "knowledge_items",
        "updated_at",
        existing_type=sa.DateTime(),
        nullable=False,
        server_default=sa.text("now()"),
    )
    op.execute("ALTER TABLE knowledge_items DROP CONSTRAINT IF EXISTS knowledge_items_task_id_fkey")
    op.create_foreign_key(
        "knowledge_items_task_id_fkey",
        "knowledge_items",
        "tasks",
        ["task_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.execute("ALTER TABLE knowledge_items DROP CONSTRAINT IF EXISTS knowledge_items_task_id_fkey")
    op.create_foreign_key(
        "knowledge_items_task_id_fkey",
        "knowledge_items",
        "tasks",
        ["task_id"],
        ["id"],
    )
    op.drop_column("knowledge_items", "updated_at")
    op.drop_column("knowledge_items", "task_title_snapshot")
