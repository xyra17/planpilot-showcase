"""add media preview state and cached asset references

Revision ID: g0h1i2j3k4l5
Revises: f9g0h1i2j3k4
"""

import sqlalchemy as sa

from alembic import op

revision = "g0h1i2j3k4l5"
down_revision = "f9g0h1i2j3k4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "knowledge_items",
        sa.Column("media_preview_status", sa.String(), server_default="none", nullable=False),
    )
    op.add_column("knowledge_items", sa.Column("media_preview_error", sa.Text(), nullable=True))
    op.add_column(
        "knowledge_items",
        sa.Column("media_metadata", sa.JSON(), server_default=sa.text("'{}'::json"), nullable=False),
    )
    op.add_column("knowledge_items", sa.Column("media_source_version", sa.String(), nullable=True))
    op.add_column("knowledge_items", sa.Column("media_playback_path", sa.Text(), nullable=True))
    op.add_column("knowledge_items", sa.Column("media_poster_path", sa.Text(), nullable=True))
    op.add_column("knowledge_items", sa.Column("media_waveform_path", sa.Text(), nullable=True))
    op.add_column("knowledge_items", sa.Column("media_previewed_at", sa.DateTime(), nullable=True))
    op.create_index(
        "ix_knowledge_items_media_preview_status",
        "knowledge_items",
        ["media_preview_status"],
    )


def downgrade() -> None:
    op.drop_index("ix_knowledge_items_media_preview_status", table_name="knowledge_items")
    op.drop_column("knowledge_items", "media_previewed_at")
    op.drop_column("knowledge_items", "media_waveform_path")
    op.drop_column("knowledge_items", "media_poster_path")
    op.drop_column("knowledge_items", "media_playback_path")
    op.drop_column("knowledge_items", "media_source_version")
    op.drop_column("knowledge_items", "media_metadata")
    op.drop_column("knowledge_items", "media_preview_error")
    op.drop_column("knowledge_items", "media_preview_status")
