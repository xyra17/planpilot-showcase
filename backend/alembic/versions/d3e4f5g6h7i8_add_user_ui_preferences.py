"""add account-level UI preferences

Revision ID: d3e4f5g6h7i8
Revises: c2d3e4f5g6h7
Create Date: 2026-08-03
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d3e4f5g6h7i8"
down_revision: str | None = "c2d3e4f5g6h7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "ui_experience", sa.String(length=24), nullable=False, server_default="technology"
        ),
    )
    op.add_column(
        "users",
        sa.Column("ui_theme", sa.String(length=24), nullable=False, server_default="base"),
    )
    op.add_column(
        "users",
        sa.Column("ui_accent", sa.String(length=32), nullable=False, server_default="violet"),
    )


def downgrade() -> None:
    op.drop_column("users", "ui_accent")
    op.drop_column("users", "ui_theme")
    op.drop_column("users", "ui_experience")
