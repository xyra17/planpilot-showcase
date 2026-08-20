"""add learner pattern controls and audit history

Revision ID: x1y2z3a4b5c6
Revises: w0x1y2z3a4b5
"""

import sqlalchemy as sa

from alembic import op

revision = "x1y2z3a4b5c6"
down_revision = "w0x1y2z3a4b5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("learner_patterns", sa.Column("user_review_status", sa.String(32), nullable=True))
    op.add_column("learner_patterns", sa.Column("user_override", sa.JSON(), server_default="{}", nullable=False))
    op.add_column("learner_patterns", sa.Column("user_reviewed_at", sa.DateTime(), nullable=True))
    op.add_column("learner_patterns", sa.Column("paused_at", sa.DateTime(), nullable=True))
    op.create_table(
        "learner_pattern_audits",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("pattern_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("action", sa.String(32), nullable=False),
        sa.Column("actor_type", sa.String(24), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("before_state", sa.JSON(), nullable=False),
        sa.Column("after_state", sa.JSON(), nullable=False),
        sa.Column("reversible", sa.Boolean(), nullable=False),
        sa.Column("undone_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_learner_pattern_audits_pattern_id", "learner_pattern_audits", ["pattern_id"])
    op.create_index("ix_learner_pattern_audits_user_id", "learner_pattern_audits", ["user_id"])
    op.create_index("ix_learner_pattern_audits_action", "learner_pattern_audits", ["action"])
    op.create_index("ix_learner_pattern_audits_created_at", "learner_pattern_audits", ["created_at"])
    op.create_index("ix_learner_pattern_audits_user_created", "learner_pattern_audits", ["user_id", "created_at"])
    op.create_table(
        "learner_pattern_suppressions",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("pattern_type", sa.String(), nullable=False),
        sa.Column("scope", sa.String(), nullable=False),
        sa.Column("goal_id", sa.String(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["goal_id"], ["goals.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_learner_pattern_suppressions_user_id", "learner_pattern_suppressions", ["user_id"])
    op.create_index("ix_learner_pattern_suppressions_pattern_type", "learner_pattern_suppressions", ["pattern_type"])
    op.create_index("ix_learner_pattern_suppressions_lookup", "learner_pattern_suppressions", ["user_id", "pattern_type", "scope", "goal_id"], unique=True)


def downgrade() -> None:
    op.drop_table("learner_pattern_suppressions")
    op.drop_table("learner_pattern_audits")
    op.drop_column("learner_patterns", "paused_at")
    op.drop_column("learner_patterns", "user_reviewed_at")
    op.drop_column("learner_patterns", "user_override")
    op.drop_column("learner_patterns", "user_review_status")
