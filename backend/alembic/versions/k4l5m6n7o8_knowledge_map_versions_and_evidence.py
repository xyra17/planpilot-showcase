"""Add source proposals, map versions, concept aliases and typed mastery evidence.

Revision ID: k4l5m6n7o8
Revises: j3k4l5m6n7
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "k4l5m6n7o8"
down_revision: str | None = "j3k4l5m6n7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "knowledge_source_metadata_proposals",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("item_id", sa.String(), nullable=False),
        sa.Column("proposed_role", sa.String(length=24), nullable=False),
        sa.Column("proposed_metadata", sa.JSON(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=24), server_default="draft", nullable=False),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "confidence >= 0.0 AND confidence <= 1.0", name="ck_source_metadata_confidence"
        ),
        sa.ForeignKeyConstraint(["item_id"], ["knowledge_items.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_knowledge_source_metadata_proposals_item_id",
        "knowledge_source_metadata_proposals",
        ["item_id"],
    )
    op.create_index(
        "ix_knowledge_source_metadata_proposals_user_id",
        "knowledge_source_metadata_proposals",
        ["user_id"],
    )
    op.create_index(
        "ix_knowledge_source_metadata_proposals_status",
        "knowledge_source_metadata_proposals",
        ["status"],
    )

    op.add_column(
        "learning_concepts", sa.Column("aliases", sa.JSON(), server_default=sa.text("'[]'"), nullable=False)
    )
    op.add_column("learning_concepts", sa.Column("merged_into_id", sa.String(), nullable=True))
    op.add_column(
        "learning_concepts",
        sa.Column("lifecycle_status", sa.String(length=24), server_default="active", nullable=False),
    )
    op.create_foreign_key(
        "fk_learning_concepts_merged_into_id",
        "learning_concepts",
        "learning_concepts",
        ["merged_into_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_learning_concepts_merged_into_id", "learning_concepts", ["merged_into_id"])
    op.create_index("ix_learning_concepts_lifecycle_status", "learning_concepts", ["lifecycle_status"])

    op.create_table(
        "knowledge_map_versions",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("goal_id", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=24), server_default="draft", nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("change_summary", sa.JSON(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("generated_by", sa.String(length=40), nullable=False),
        sa.Column("parent_version_id", sa.String(), nullable=True),
        sa.Column("activated_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["goal_id"], ["goals.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["parent_version_id"], ["knowledge_map_versions.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("goal_id", "version", name="uq_knowledge_map_goal_version"),
    )
    for column in ("user_id", "goal_id", "status"):
        op.create_index(f"ix_knowledge_map_versions_{column}", "knowledge_map_versions", [column])

    op.create_table(
        "mastery_evidence",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("goal_id", sa.String(), nullable=False),
        sa.Column("task_id", sa.String(), nullable=True),
        sa.Column("concept_id", sa.String(), nullable=False),
        sa.Column("evidence_type", sa.String(length=32), nullable=False),
        sa.Column("score", sa.Float(), nullable=False),
        sa.Column("reliability", sa.Float(), nullable=False),
        sa.Column("source_item_id", sa.String(), nullable=True),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("detail", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("score >= 0.0 AND score <= 1.0", name="ck_mastery_evidence_score"),
        sa.CheckConstraint(
            "reliability >= 0.0 AND reliability <= 1.0",
            name="ck_mastery_evidence_reliability",
        ),
        sa.ForeignKeyConstraint(["concept_id"], ["learning_concepts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["goal_id"], ["goals.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_item_id"], ["knowledge_items.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    for column in ("user_id", "goal_id", "task_id", "concept_id", "evidence_type", "created_at"):
        op.create_index(f"ix_mastery_evidence_{column}", "mastery_evidence", [column])


def downgrade() -> None:
    op.drop_table("mastery_evidence")
    op.drop_table("knowledge_map_versions")
    op.drop_index("ix_learning_concepts_lifecycle_status", table_name="learning_concepts")
    op.drop_index("ix_learning_concepts_merged_into_id", table_name="learning_concepts")
    op.drop_constraint(
        "fk_learning_concepts_merged_into_id", "learning_concepts", type_="foreignkey"
    )
    op.drop_column("learning_concepts", "lifecycle_status")
    op.drop_column("learning_concepts", "merged_into_id")
    op.drop_column("learning_concepts", "aliases")
    op.drop_table("knowledge_source_metadata_proposals")
