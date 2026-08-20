"""cascade goal-scoped learner profiles

Revision ID: y2z3a4b5c6d7
Revises: x1y2z3a4b5c6
Create Date: 2026-08-19
"""

from alembic import op

revision = "y2z3a4b5c6d7"
down_revision = "x1y2z3a4b5c6"
branch_labels = None
depends_on = None


def _replace_goal_foreign_key(table_name: str, ondelete: str) -> None:
    op.drop_constraint(f"{table_name}_goal_id_fkey", table_name, type_="foreignkey")
    op.create_foreign_key(
        f"{table_name}_goal_id_fkey",
        table_name,
        "goals",
        ["goal_id"],
        ["id"],
        ondelete=ondelete,
    )


def upgrade() -> None:
    _replace_goal_foreign_key("learner_profiles", "CASCADE")
    _replace_goal_foreign_key("learner_cognitive_profiles", "CASCADE")


def downgrade() -> None:
    _replace_goal_foreign_key("learner_cognitive_profiles", "SET NULL")
    _replace_goal_foreign_key("learner_profiles", "SET NULL")
