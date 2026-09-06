"""Add reviewable provenance to knowledge maps.

Revision ID: j3k4l5m6n7
Revises: i2j3k4l5m6
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "j3k4l5m6n7"
down_revision: str | None = "i2j3k4l5m6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "learning_concepts",
        sa.Column(
            "provenance_type",
            sa.String(length=32),
            nullable=False,
            server_default="user_created",
        ),
    )
    op.add_column(
        "learning_concepts",
        sa.Column(
            "review_status", sa.String(length=24), nullable=False, server_default="confirmed"
        ),
    )
    op.add_column(
        "learning_concepts",
        sa.Column("source_refs", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
    )
    op.create_index(
        "ix_learning_concepts_review_status", "learning_concepts", ["review_status"]
    )

    op.add_column(
        "knowledge_edges",
        sa.Column("basis", sa.String(length=24), nullable=False, server_default="user_defined"),
    )
    op.add_column(
        "knowledge_edges",
        sa.Column(
            "review_status", sa.String(length=24), nullable=False, server_default="confirmed"
        ),
    )
    op.create_index("ix_knowledge_edges_review_status", "knowledge_edges", ["review_status"])


def downgrade() -> None:
    op.drop_index("ix_knowledge_edges_review_status", table_name="knowledge_edges")
    op.drop_column("knowledge_edges", "review_status")
    op.drop_column("knowledge_edges", "basis")
    op.drop_index("ix_learning_concepts_review_status", table_name="learning_concepts")
    op.drop_column("learning_concepts", "source_refs")
    op.drop_column("learning_concepts", "review_status")
    op.drop_column("learning_concepts", "provenance_type")
