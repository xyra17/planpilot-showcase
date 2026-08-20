"""add description to tasks

Revision ID: e7a3b9c12d45
Revises: b3f7e9a12cd0
Create Date: 2026-07-15

"""

import sqlalchemy as sa

from alembic import op

revision = "e7a3b9c12d45"
down_revision = "b3f7e9a12cd0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("description", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("tasks", "description")
