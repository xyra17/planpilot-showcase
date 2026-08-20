"""add persistent user avatar

Revision ID: p4q5r6s7t8u9
Revises: n3o4p5q6r7s8
"""

from alembic import op
import sqlalchemy as sa


revision = "p4q5r6s7t8u9"
down_revision = "n3o4p5q6r7s8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("avatar_url", sa.String(length=500), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "avatar_url")
