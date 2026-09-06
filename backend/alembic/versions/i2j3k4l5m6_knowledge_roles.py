"""Add source roles and metadata for knowledge boundary workflows.

Revision ID: i2j3k4l5m6
Revises: h1i2j3k4l5m6
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "i2j3k4l5m6"
down_revision: str | None = "h1i2j3k4l5m6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "knowledge_items",
        sa.Column("source_role", sa.String(length=24), nullable=False, server_default="reference"),
    )
    op.add_column(
        "knowledge_items",
        sa.Column("source_metadata", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.create_index("ix_knowledge_items_source_role", "knowledge_items", ["source_role"])


def downgrade() -> None:
    op.drop_index("ix_knowledge_items_source_role", table_name="knowledge_items")
    op.drop_column("knowledge_items", "source_metadata")
    op.drop_column("knowledge_items", "source_role")

