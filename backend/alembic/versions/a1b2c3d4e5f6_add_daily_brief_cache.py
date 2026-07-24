"""add daily_brief_caches table

Revision ID: a1b2c3d4e5f6
Revises: f2c8d1e04a7b
Create Date: 2026-07-19
"""
from alembic import op
import sqlalchemy as sa

revision = "a1b2c3d4e5f6"
down_revision = "f2c8d1e04a7b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "daily_brief_caches",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("date", sa.String(), nullable=False),
        sa.Column("content", sa.JSON(), nullable=False),
        sa.Column("is_read", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("generated_by", sa.String(), nullable=False, server_default="on_demand"),
        sa.Column("generated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "date", name="uq_daily_brief_cache_user_date"),
    )
    op.create_index("ix_daily_brief_caches_user_id", "daily_brief_caches", ["user_id"])
    op.create_index("ix_daily_brief_caches_date", "daily_brief_caches", ["date"])


def downgrade() -> None:
    op.drop_index("ix_daily_brief_caches_date", "daily_brief_caches")
    op.drop_index("ix_daily_brief_caches_user_id", "daily_brief_caches")
    op.drop_table("daily_brief_caches")
