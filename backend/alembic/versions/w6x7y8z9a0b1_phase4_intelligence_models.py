"""Phase 4 intelligence models

Revision ID: w6x7y8z9a0b1
Revises: v5w6x7y8z9a0
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "w6x7y8z9a0b1"
down_revision: str | None = "v5w6x7y8z9a0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "learner_cognitive_profiles",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "goal_id", sa.String(), sa.ForeignKey("goals.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("learning_speed", sa.Float(), nullable=True),
        sa.Column("retention_rate", sa.Float(), nullable=True),
        sa.Column("forgetting_rate", sa.Float(), nullable=True),
        sa.Column("transfer_score", sa.Float(), nullable=True),
        sa.Column("persistence_score", sa.Float(), nullable=True),
        sa.Column("procrastination_score", sa.Float(), nullable=True),
        sa.Column("recovery_score", sa.Float(), nullable=True),
        sa.Column("difficulty_preference", sa.Float(), nullable=True),
        sa.Column("challenge_tolerance", sa.Float(), nullable=True),
        sa.Column("feedback_acceptance", sa.Float(), nullable=True),
        sa.Column("observation_window_days", sa.Integer(), nullable=False, server_default="90"),
        sa.Column("sample_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0"),
        sa.Column("last_computed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.CheckConstraint(
            "confidence >= 0.0 AND confidence <= 1.0", name="ck_cognitive_confidence"
        ),
    )
    op.create_index(
        "ix_learner_cognitive_profiles_user_id", "learner_cognitive_profiles", ["user_id"]
    )
    op.create_index(
        "ix_learner_cognitive_profiles_goal_id", "learner_cognitive_profiles", ["goal_id"]
    )
    op.create_index(
        "uq_cognitive_profiles_user_scope",
        "learner_cognitive_profiles",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("goal_id IS NULL"),
    )
    op.create_index(
        "uq_cognitive_profiles_goal_scope",
        "learner_cognitive_profiles",
        ["user_id", "goal_id"],
        unique=True,
        postgresql_where=sa.text("goal_id IS NOT NULL"),
    )

    op.create_table(
        "learning_memories",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "goal_id", sa.String(), sa.ForeignKey("goals.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("memory_type", sa.String(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column(
            "source_event_id",
            sa.String(),
            sa.ForeignKey("learning_events.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("importance", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("metadata", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.CheckConstraint("importance >= 0.0 AND importance <= 1.0", name="ck_memory_importance"),
        sa.UniqueConstraint("source_event_id", "memory_type", name="uq_memory_event_type"),
    )
    op.create_index("ix_learning_memories_user_id", "learning_memories", ["user_id"])
    op.create_index("ix_learning_memories_goal_id", "learning_memories", ["goal_id"])
    op.create_index("ix_learning_memories_memory_type", "learning_memories", ["memory_type"])
    op.create_index(
        "ix_learning_memories_source_event_id", "learning_memories", ["source_event_id"]
    )
    op.create_index(
        "ix_learning_memories_user_recency", "learning_memories", ["user_id", "occurred_at"]
    )

    op.create_table(
        "learning_concepts",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "goal_id", sa.String(), sa.ForeignKey("goals.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("normalized_name", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("mastery_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("initial_strength", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("forgetting_rate", sa.Float(), nullable=False, server_default="0.05"),
        sa.Column("evidence_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(), nullable=False, server_default="learning"),
        sa.Column("last_reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("next_review_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.CheckConstraint(
            "mastery_score >= 0.0 AND mastery_score <= 1.0", name="ck_concept_mastery"
        ),
        sa.CheckConstraint(
            "initial_strength >= 0.0 AND initial_strength <= 1.0", name="ck_concept_strength"
        ),
        sa.UniqueConstraint("user_id", "goal_id", "normalized_name", name="uq_concept_scope_name"),
    )
    op.create_index("ix_learning_concepts_user_id", "learning_concepts", ["user_id"])
    op.create_index("ix_learning_concepts_goal_id", "learning_concepts", ["goal_id"])
    op.create_index("ix_learning_concepts_status", "learning_concepts", ["status"])
    op.create_index("ix_learning_concepts_next_review_at", "learning_concepts", ["next_review_at"])

    op.create_table(
        "knowledge_edges",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "source_concept_id",
            sa.String(),
            sa.ForeignKey("learning_concepts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "target_concept_id",
            sa.String(),
            sa.ForeignKey("learning_concepts.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "resource_item_id",
            sa.String(),
            sa.ForeignKey("knowledge_items.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("relation_type", sa.String(), nullable=False),
        sa.Column("weight", sa.Float(), nullable=False, server_default="1"),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("evidence_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.CheckConstraint(
            "(target_concept_id IS NOT NULL AND resource_item_id IS NULL) OR "
            "(target_concept_id IS NULL AND resource_item_id IS NOT NULL)",
            name="ck_knowledge_edge_target",
        ),
        sa.CheckConstraint("confidence >= 0.0 AND confidence <= 1.0", name="ck_edge_confidence"),
    )
    op.create_index("ix_knowledge_edges_user_id", "knowledge_edges", ["user_id"])
    op.create_index(
        "ix_knowledge_edges_source_concept_id", "knowledge_edges", ["source_concept_id"]
    )
    op.create_index(
        "ix_knowledge_edges_target_concept_id", "knowledge_edges", ["target_concept_id"]
    )
    op.create_index("ix_knowledge_edges_resource_item_id", "knowledge_edges", ["resource_item_id"])
    op.create_index("ix_knowledge_edges_relation_type", "knowledge_edges", ["relation_type"])
    op.create_index(
        "uq_knowledge_edge_identity",
        "knowledge_edges",
        ["source_concept_id", "target_concept_id", "resource_item_id", "relation_type"],
        unique=True,
    )

    op.create_table(
        "agent_evals",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("benchmark_name", sa.String(), nullable=False),
        sa.Column("case_id", sa.String(), nullable=False),
        sa.Column("category", sa.String(), nullable=False),
        sa.Column("input_case", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("expected_output", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("actual_output", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("planning_quality", sa.Float(), nullable=False, server_default="0"),
        sa.Column("recommendation_accuracy", sa.Float(), nullable=False, server_default="0"),
        sa.Column("user_acceptance", sa.Float(), nullable=True),
        sa.Column("long_term_improvement", sa.Float(), nullable=True),
        sa.Column("passed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("model_name", sa.String(), nullable=True),
        sa.Column("prompt_version", sa.String(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint("benchmark_name", "case_id", name="uq_agent_eval_benchmark_case"),
    )
    op.create_index("ix_agent_evals_benchmark_name", "agent_evals", ["benchmark_name"])
    op.create_index("ix_agent_evals_case_id", "agent_evals", ["case_id"])
    op.create_index("ix_agent_evals_category", "agent_evals", ["category"])
    op.create_index("ix_agent_evals_passed", "agent_evals", ["passed"])


def downgrade() -> None:
    op.drop_table("agent_evals")
    op.drop_table("knowledge_edges")
    op.drop_table("learning_concepts")
    op.drop_table("learning_memories")
    op.drop_index("uq_cognitive_profiles_goal_scope", table_name="learner_cognitive_profiles")
    op.drop_index("uq_cognitive_profiles_user_scope", table_name="learner_cognitive_profiles")
    op.drop_table("learner_cognitive_profiles")
