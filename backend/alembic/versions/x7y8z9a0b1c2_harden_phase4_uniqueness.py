"""Harden Phase 4 nullable-scope uniqueness.

Revision ID: x7y8z9a0b1c2
Revises: w6x7y8z9a0b1
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "x7y8z9a0b1c2"
down_revision: str | None = "w6x7y8z9a0b1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("uq_concept_scope_name", "learning_concepts", type_="unique")
    op.create_index(
        "uq_learning_concepts_user_scope",
        "learning_concepts",
        ["user_id", "normalized_name"],
        unique=True,
        postgresql_where=sa.text("goal_id IS NULL"),
        sqlite_where=sa.text("goal_id IS NULL"),
    )
    op.create_index(
        "uq_learning_concepts_goal_scope",
        "learning_concepts",
        ["user_id", "goal_id", "normalized_name"],
        unique=True,
        postgresql_where=sa.text("goal_id IS NOT NULL"),
        sqlite_where=sa.text("goal_id IS NOT NULL"),
    )
    op.drop_index("uq_knowledge_edge_identity", table_name="knowledge_edges")
    op.create_index(
        "uq_knowledge_edge_concept_target",
        "knowledge_edges",
        ["source_concept_id", "target_concept_id", "relation_type"],
        unique=True,
        postgresql_where=sa.text("target_concept_id IS NOT NULL"),
        sqlite_where=sa.text("target_concept_id IS NOT NULL"),
    )
    op.create_index(
        "uq_knowledge_edge_resource_target",
        "knowledge_edges",
        ["source_concept_id", "resource_item_id", "relation_type"],
        unique=True,
        postgresql_where=sa.text("resource_item_id IS NOT NULL"),
        sqlite_where=sa.text("resource_item_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_knowledge_edge_resource_target", table_name="knowledge_edges")
    op.drop_index("uq_knowledge_edge_concept_target", table_name="knowledge_edges")
    op.create_index(
        "uq_knowledge_edge_identity",
        "knowledge_edges",
        ["source_concept_id", "target_concept_id", "resource_item_id", "relation_type"],
        unique=True,
    )
    op.drop_index("uq_learning_concepts_goal_scope", table_name="learning_concepts")
    op.drop_index("uq_learning_concepts_user_scope", table_name="learning_concepts")
    op.create_unique_constraint(
        "uq_concept_scope_name",
        "learning_concepts",
        ["user_id", "goal_id", "normalized_name"],
    )
