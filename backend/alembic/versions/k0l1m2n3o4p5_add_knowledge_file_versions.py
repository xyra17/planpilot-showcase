"""add knowledge file versions

Revision ID: k0l1m2n3o4p5
Revises: j9k0l1m2n3o4
"""

from alembic import op
import sqlalchemy as sa


revision = "k0l1m2n3o4p5"
down_revision = "j9k0l1m2n3o4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "knowledge_item_file_versions",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("item_id", sa.String(), nullable=False),
        sa.Column("file_path", sa.Text(), nullable=False),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), server_default="0", nullable=False),
        sa.Column("content", sa.Text(), server_default="", nullable=False),
        sa.Column("content_format", sa.String(), server_default="plain", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["item_id"], ["knowledge_items.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_knowledge_item_file_versions_item_id",
        "knowledge_item_file_versions",
        ["item_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_knowledge_item_file_versions_item_id", table_name="knowledge_item_file_versions")
    op.drop_table("knowledge_item_file_versions")
