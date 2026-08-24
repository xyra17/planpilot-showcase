"""add extensible account preferences

Revision ID: m2n3o4p5q6r7
Revises: l1m2n3o4p5q6
"""

import sqlalchemy as sa

from alembic import op

revision = "m2n3o4p5q6r7"
down_revision = "l1m2n3o4p5q6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("account_preferences", sa.JSON(), server_default=sa.text("'{}'"), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("users", "account_preferences")
