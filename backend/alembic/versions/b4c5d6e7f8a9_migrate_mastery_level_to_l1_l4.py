"""migrate mastery_level values to L1-L4

Revision ID: b4c5d6e7f8a9
Revises: a1b2c3d4e5f6
Create Date: 2026-07-19
"""

from alembic import op

revision = "b4c5d6e7f8a9"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        UPDATE tasks SET mastery_level = CASE
            WHEN mastery_level = 'good'    THEN 'L3'
            WHEN mastery_level = 'basic'   THEN 'L2'
            WHEN mastery_level = 'unknown' THEN 'L1'
            ELSE mastery_level
        END
        WHERE mastery_level IN ('good', 'basic', 'unknown')
    """)


def downgrade() -> None:
    op.execute("""
        UPDATE tasks SET mastery_level = CASE
            WHEN mastery_level = 'L3' THEN 'good'
            WHEN mastery_level = 'L4' THEN 'good'
            WHEN mastery_level = 'L2' THEN 'basic'
            WHEN mastery_level = 'L1' THEN 'unknown'
            ELSE mastery_level
        END
        WHERE mastery_level IN ('L1', 'L2', 'L3', 'L4')
    """)
