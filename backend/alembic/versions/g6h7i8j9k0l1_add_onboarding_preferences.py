"""add onboarding preferences

Revision ID: g6h7i8j9k0l1
Revises: f5g6h7i8j9k0
Create Date: 2026-08-05
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "g6h7i8j9k0l1"
down_revision: str | None = "f5g6h7i8j9k0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("language", sa.String(length=16), nullable=False, server_default="zh-CN"),
    )
    op.add_column(
        "users",
        sa.Column("week_start", sa.String(length=16), nullable=False, server_default="monday"),
    )
    op.add_column(
        "users",
        sa.Column(
            "study_days",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[\"mon\",\"tue\",\"wed\",\"thu\",\"fri\"]'::json"),
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "availability_windows",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[\"evening\"]'::json"),
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "font_density", sa.String(length=24), nullable=False, server_default="comfortable"
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "preferred_start_method",
            sa.String(length=32),
            nullable=False,
            server_default="create_goal",
        ),
    )
    op.add_column(
        "users",
        sa.Column("onboarding_completed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("users", "onboarding_completed")
    op.drop_column("users", "preferred_start_method")
    op.drop_column("users", "font_density")
    op.drop_column("users", "availability_windows")
    op.drop_column("users", "study_days")
    op.drop_column("users", "week_start")
    op.drop_column("users", "language")
