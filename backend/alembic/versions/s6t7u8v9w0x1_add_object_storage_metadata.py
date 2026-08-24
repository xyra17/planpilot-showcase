"""add object storage metadata

Revision ID: s6t7u8v9w0x1
Revises: r5s6t7u8v9w0
"""

import sqlalchemy as sa

from alembic import op

revision = "s6t7u8v9w0x1"
down_revision = "r5s6t7u8v9w0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "knowledge_items",
        sa.Column("file_size_bytes", sa.Integer(), server_default="0", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("knowledge_items", "file_size_bytes")
