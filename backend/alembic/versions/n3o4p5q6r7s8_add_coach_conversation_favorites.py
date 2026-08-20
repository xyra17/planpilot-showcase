"""add favorite state to Pilo conversations

Revision ID: n3o4p5q6r7s8
Revises: m2n3o4p5q6r7
"""

from alembic import op
import sqlalchemy as sa


revision = "n3o4p5q6r7s8"
down_revision = "m2n3o4p5q6r7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "coach_conversations",
        sa.Column("is_favorite", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.create_index(
        "ix_coach_conversations_is_favorite",
        "coach_conversations",
        ["is_favorite"],
    )


def downgrade() -> None:
    op.drop_index("ix_coach_conversations_is_favorite", table_name="coach_conversations")
    op.drop_column("coach_conversations", "is_favorite")
