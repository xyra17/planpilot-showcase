"""persist Pilo conversations and preferences

Revision ID: l1m2n3o4p5q6
Revises: k0l1m2n3o4p5
"""

import sqlalchemy as sa

from alembic import op

revision = "l1m2n3o4p5q6"
down_revision = "k0l1m2n3o4p5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "coach_conversations",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("session_id", sa.String(), nullable=False),
        sa.Column("goal_id", sa.String(), nullable=True),
        sa.Column("goal_title", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("summary", sa.Text(), server_default="", nullable=False),
        sa.Column("pilo_feedback", sa.Text(), server_default="", nullable=False),
        sa.Column("messages", sa.JSON(), server_default=sa.text("'[]'"), nullable=False),
        sa.Column("association", sa.String(), server_default="", nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["goal_id"], ["goals.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_coach_conversations_user_id", "coach_conversations", ["user_id"])
    op.create_index("ix_coach_conversations_goal_id", "coach_conversations", ["goal_id"])
    op.create_index("ix_coach_conversations_updated_at", "coach_conversations", ["updated_at"])
    op.create_index(
        "ix_coach_conversations_user_updated",
        "coach_conversations",
        ["user_id", "updated_at"],
    )
    op.create_table(
        "coach_preferences",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("preferences", sa.JSON(), server_default=sa.text("'{}'"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )


def downgrade() -> None:
    op.drop_table("coach_preferences")
    op.drop_index("ix_coach_conversations_user_updated", table_name="coach_conversations")
    op.drop_index("ix_coach_conversations_updated_at", table_name="coach_conversations")
    op.drop_index("ix_coach_conversations_goal_id", table_name="coach_conversations")
    op.drop_index("ix_coach_conversations_user_id", table_name="coach_conversations")
    op.drop_table("coach_conversations")
