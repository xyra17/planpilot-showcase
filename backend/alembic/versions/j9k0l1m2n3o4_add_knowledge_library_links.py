"""add knowledge item library links and editable content format

Revision ID: j9k0l1m2n3o4
Revises: i8j9k0l1m2n3
"""

import sqlalchemy as sa

from alembic import op

revision = "j9k0l1m2n3o4"
down_revision = "i8j9k0l1m2n3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "knowledge_items",
        sa.Column("content_format", sa.String(), server_default="plain", nullable=False),
    )
    op.create_table(
        "knowledge_item_library_links",
        sa.Column("item_id", sa.String(), nullable=False),
        sa.Column("kb_id", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["item_id"], ["knowledge_items.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["kb_id"], ["knowledge_bases.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("item_id", "kb_id"),
    )
    op.create_index(
        "ix_knowledge_item_library_links_kb_id",
        "knowledge_item_library_links",
        ["kb_id"],
    )
    op.execute(
        """
        INSERT INTO knowledge_item_library_links (item_id, kb_id)
        SELECT id, kb_id FROM knowledge_items WHERE kb_id IS NOT NULL
        ON CONFLICT DO NOTHING
        """
    )
    op.execute(
        """
        UPDATE knowledge_items SET content_format = 'markdown'
        WHERE lower(file_path) LIKE '%.md'
        """
    )


def downgrade() -> None:
    op.drop_index("ix_knowledge_item_library_links_kb_id", table_name="knowledge_item_library_links")
    op.drop_table("knowledge_item_library_links")
    op.drop_column("knowledge_items", "content_format")
