"""add learning_events table

Revision ID: r2s3t4u5v6w7
Revises: q1r2s3t4u5v6
Create Date: 2026-07-29

Phase 2B: Learning Event 基础设施
- append-only 事件日志表
- 4个复合索引（用户时间线 / 目标类型 / 聚合体历史 / 事件类型）
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision = "r2s3t4u5v6w7"
down_revision = "q1r2s3t4u5v6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "learning_events",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "goal_id", sa.String(), sa.ForeignKey("goals.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("aggregate_type", sa.String(), nullable=False),
        sa.Column("aggregate_id", sa.String(), nullable=False),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("source", sa.String(), nullable=False, server_default="user_action"),
        sa.Column("payload", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
    )

    # 单列索引
    op.create_index("ix_learning_events_user_id", "learning_events", ["user_id"])
    op.create_index("ix_learning_events_goal_id", "learning_events", ["goal_id"])
    op.create_index("ix_learning_events_event_type_col", "learning_events", ["event_type"])

    # 复合索引（用于 Intelligence Layer 查询）
    op.create_index(
        "ix_learning_events_user_timeline", "learning_events", ["user_id", "occurred_at"]
    )
    op.create_index("ix_learning_events_goal_type", "learning_events", ["goal_id", "event_type"])
    op.create_index(
        "ix_learning_events_aggregate", "learning_events", ["aggregate_type", "aggregate_id"]
    )
    op.create_index(
        "ix_learning_events_event_type", "learning_events", ["event_type", "occurred_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_learning_events_event_type", "learning_events")
    op.drop_index("ix_learning_events_aggregate", "learning_events")
    op.drop_index("ix_learning_events_goal_type", "learning_events")
    op.drop_index("ix_learning_events_user_timeline", "learning_events")
    op.drop_index("ix_learning_events_event_type_col", "learning_events")
    op.drop_index("ix_learning_events_goal_id", "learning_events")
    op.drop_index("ix_learning_events_user_id", "learning_events")
    op.drop_table("learning_events")
