"""Add goal-contract snapshots and versioned note evidence.

Revision ID: h1i2j3k4l5m6
Revises: g0h1i2j3k4l5
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "h1i2j3k4l5m6"
down_revision: str | None = "g0h1i2j3k4l5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "goals",
        sa.Column("contract", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.add_column(
        "goals",
        sa.Column("intent_version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column("plans", sa.Column("goal_intent_version", sa.Integer(), nullable=True))
    op.add_column("plans", sa.Column("goal_contract_snapshot", sa.JSON(), nullable=True))
    op.add_column(
        "tasks",
        sa.Column("execution_guide", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.add_column(
        "goal_versions",
        sa.Column("contract_snapshot", sa.JSON(), nullable=True),
    )
    op.add_column(
        "goal_versions",
        sa.Column("intent_version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "knowledge_items",
        sa.Column("normalized_content", sa.Text(), nullable=False, server_default=""),
    )
    op.add_column(
        "knowledge_items",
        sa.Column("content_version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column("knowledge_items", sa.Column("note_scope", sa.String(24), nullable=True))
    op.add_column(
        "knowledge_items",
        sa.Column("note_structure", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.create_table(
        "knowledge_item_content_versions",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("item_id", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("title_snapshot", sa.Text(), nullable=False, server_default=""),
        sa.Column("content_snapshot", sa.Text(), nullable=False, server_default=""),
        sa.Column("normalized_content_snapshot", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["item_id"], ["knowledge_items.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("item_id", "version", name="uq_knowledge_content_version"),
    )
    op.create_index(
        "ix_knowledge_item_content_versions_item_id",
        "knowledge_item_content_versions",
        ["item_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_knowledge_item_content_versions_item_id",
        table_name="knowledge_item_content_versions",
    )
    op.drop_table("knowledge_item_content_versions")
    op.drop_column("knowledge_items", "note_structure")
    op.drop_column("knowledge_items", "note_scope")
    op.drop_column("knowledge_items", "content_version")
    op.drop_column("knowledge_items", "normalized_content")
    op.drop_column("goal_versions", "intent_version")
    op.drop_column("goal_versions", "contract_snapshot")
    op.drop_column("plans", "goal_contract_snapshot")
    op.drop_column("tasks", "execution_guide")
    op.drop_column("plans", "goal_intent_version")
    op.drop_column("goals", "intent_version")
    op.drop_column("goals", "contract")
