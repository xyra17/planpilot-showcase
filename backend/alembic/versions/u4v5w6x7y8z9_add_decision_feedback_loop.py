"""add profile uniqueness, decision proposals and feedback

Revision ID: u4v5w6x7y8z9
Revises: t4u5v6w7x8y9
Create Date: 2026-07-29

Phase 2C-4 ~ 2C-7:
- learner_profiles scope-level uniqueness
- decision_proposals review/apply state
- proposal_feedback effectiveness record
"""

import sqlalchemy as sa

from alembic import op

revision = "u4v5w6x7y8z9"
down_revision = "t4u5v6w7x8y9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "uq_learner_profiles_user_scope",
        "learner_profiles",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("goal_id IS NULL"),
    )
    op.create_index(
        "uq_learner_profiles_goal_scope",
        "learner_profiles",
        ["user_id", "goal_id"],
        unique=True,
        postgresql_where=sa.text("goal_id IS NOT NULL"),
    )

    op.create_table(
        "decision_proposals",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "goal_id",
            sa.String(),
            sa.ForeignKey("goals.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("proposal_type", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("reasoning", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("proposed_changes", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("evidence_references", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column(
            "requires_user_confirmation", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("applied_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.CheckConstraint(
            "confidence >= 0.0 AND confidence <= 1.0",
            name="ck_decision_proposals_confidence",
        ),
    )
    op.create_index("ix_decision_proposals_user_id", "decision_proposals", ["user_id"])
    op.create_index("ix_decision_proposals_goal_id", "decision_proposals", ["goal_id"])
    op.create_index("ix_decision_proposals_proposal_type", "decision_proposals", ["proposal_type"])
    op.create_index("ix_decision_proposals_status", "decision_proposals", ["status"])
    op.create_index(
        "ix_decision_proposals_user_status",
        "decision_proposals",
        ["user_id", "status"],
    )

    op.create_table(
        "proposal_feedback",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "proposal_id",
            sa.String(),
            sa.ForeignKey("decision_proposals.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("outcome", sa.String(), nullable=False),
        sa.Column("rating", sa.Integer(), nullable=True),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("observed_metrics", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.CheckConstraint(
            "rating IS NULL OR (rating >= 1 AND rating <= 5)",
            name="ck_proposal_feedback_rating",
        ),
    )
    op.create_index("ix_proposal_feedback_proposal_id", "proposal_feedback", ["proposal_id"])
    op.create_index("ix_proposal_feedback_user_id", "proposal_feedback", ["user_id"])
    op.create_index("ix_proposal_feedback_outcome", "proposal_feedback", ["outcome"])


def downgrade() -> None:
    op.drop_index("ix_proposal_feedback_outcome", table_name="proposal_feedback")
    op.drop_index("ix_proposal_feedback_user_id", table_name="proposal_feedback")
    op.drop_index("ix_proposal_feedback_proposal_id", table_name="proposal_feedback")
    op.drop_table("proposal_feedback")

    op.drop_index("ix_decision_proposals_user_status", table_name="decision_proposals")
    op.drop_index("ix_decision_proposals_status", table_name="decision_proposals")
    op.drop_index("ix_decision_proposals_proposal_type", table_name="decision_proposals")
    op.drop_index("ix_decision_proposals_goal_id", table_name="decision_proposals")
    op.drop_index("ix_decision_proposals_user_id", table_name="decision_proposals")
    op.drop_table("decision_proposals")

    op.drop_index("uq_learner_profiles_goal_scope", table_name="learner_profiles")
    op.drop_index("uq_learner_profiles_user_scope", table_name="learner_profiles")
