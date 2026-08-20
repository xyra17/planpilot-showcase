"""add precise weekly availability

Revision ID: h7i8j9k0l1m2
Revises: g6h7i8j9k0l1
Create Date: 2026-08-06
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "h7i8j9k0l1m2"
down_revision: str | None = "g6h7i8j9k0l1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("weekly_availability", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "weekly_availability")
