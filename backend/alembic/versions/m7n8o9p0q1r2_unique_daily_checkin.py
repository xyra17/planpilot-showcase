"""keep one check-in per goal and day

Revision ID: m7n8o9p0q1r2
Revises: l6m7n8o9p0q1
Create Date: 2026-07-27
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "m7n8o9p0q1r2"
down_revision: Union[str, None] = "l6m7n8o9p0q1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 保留同一用户、目标、日期下最近创建的一条记录。
    op.execute(
        """
        DELETE FROM checkin_records older
        USING checkin_records newer
        WHERE older.user_id = newer.user_id
          AND older.goal_id = newer.goal_id
          AND older.date = newer.date
          AND (
            older.created_at < newer.created_at
            OR (older.created_at = newer.created_at AND older.id < newer.id)
          )
        """
    )
    op.create_unique_constraint(
        "uq_checkin_user_goal_date",
        "checkin_records",
        ["user_id", "goal_id", "date"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_checkin_user_goal_date",
        "checkin_records",
        type_="unique",
    )
