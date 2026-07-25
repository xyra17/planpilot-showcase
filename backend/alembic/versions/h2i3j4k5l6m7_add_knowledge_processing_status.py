"""add knowledge processing status

Revision ID: h2i3j4k5l6m7
Revises: g1h2i3j4k5l6
Create Date: 2026-07-25
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "h2i3j4k5l6m7"
down_revision: Union[str, None] = "g1h2i3j4k5l6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "knowledge_items",
        sa.Column("processing_status", sa.String(), nullable=False, server_default="uploaded"),
    )
    op.add_column("knowledge_items", sa.Column("processing_error", sa.Text(), nullable=True))
    op.add_column(
        "knowledge_items",
        sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("knowledge_items", sa.Column("processed_at", sa.DateTime(), nullable=True))
    op.add_column(
        "knowledge_items",
        sa.Column("content_length", sa.Integer(), nullable=False, server_default="0"),
    )
    op.execute("UPDATE knowledge_items SET content_length = length(content)")
    op.execute(
        "UPDATE knowledge_items SET processing_status = CASE "
        "WHEN embedding IS NOT NULL THEN 'ready' "
        "WHEN source_type IN ('chat_note', 'daily_log', 'flash_card', 'task_note') THEN 'ready' "
        "ELSE 'failed' END"
    )
    op.execute(
        "UPDATE knowledge_items SET processing_error = "
        "'系统升级后需要重新建立索引' "
        "WHERE processing_status = 'failed'"
    )
    op.create_index(
        "ix_knowledge_items_processing_status",
        "knowledge_items",
        ["processing_status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_knowledge_items_processing_status", table_name="knowledge_items")
    op.drop_column("knowledge_items", "content_length")
    op.drop_column("knowledge_items", "processed_at")
    op.drop_column("knowledge_items", "retry_count")
    op.drop_column("knowledge_items", "processing_error")
    op.drop_column("knowledge_items", "processing_status")
