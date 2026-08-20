"""Align the knowledge item library foreign-key delete behavior.

Revision ID: z3a4b5c6d7e8
Revises: y2z3a4b5c6d7
Create Date: 2026-08-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "z3a4b5c6d7e8"
down_revision: str | None = "y2z3a4b5c6d7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "knowledge_items_kb_id_fkey",
        "knowledge_items",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "knowledge_items_kb_id_fkey",
        "knowledge_items",
        "knowledge_bases",
        ["kb_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "knowledge_items_kb_id_fkey",
        "knowledge_items",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "knowledge_items_kb_id_fkey",
        "knowledge_items",
        "knowledge_bases",
        ["kb_id"],
        ["id"],
    )
