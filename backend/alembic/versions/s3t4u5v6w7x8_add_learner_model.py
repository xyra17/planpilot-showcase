"""add learner model tables

Revision ID: s3t4u5v6w7x8
Revises: r2s3t4u5v6w7
Create Date: 2026-07-29

Phase 2C-2: Learner Model 基础设施
- learner_profiles  : 用户学习行为当前状态快照（State，批处理每日重算）
- learner_patterns  : 用户长期行为知识（Knowledge，事件驱动近实时更新）
- pattern_evidences : Pattern 支撑证据（Traceability，append-only 永久保留）
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision = "s3t4u5v6w7x8"
down_revision = "r2s3t4u5v6w7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── learner_profiles ───────────────────────────────────────────────────
    op.create_table(
        "learner_profiles",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "goal_id", sa.String(), sa.ForeignKey("goals.id", ondelete="SET NULL"), nullable=True
        ),
        # 坚持度
        sa.Column("consistency_score", sa.Float(), nullable=True),
        sa.Column("weekly_active_days", sa.Float(), nullable=True),
        # 投入时长
        sa.Column("avg_session_duration_mins", sa.Float(), nullable=True),
        sa.Column("avg_daily_investment_mins", sa.Float(), nullable=True),
        # 完成率 / 掌握率
        sa.Column("completion_rate_30d", sa.Float(), nullable=True),
        sa.Column("mastery_rate_30d", sa.Float(), nullable=True),
        sa.Column("mastery_velocity", sa.Float(), nullable=True),
        # 时段偏好
        sa.Column("preferred_hour_start", sa.Integer(), nullable=True),
        sa.Column("preferred_hour_end", sa.Integer(), nullable=True),
        sa.Column("preferred_weekdays", sa.JSON(), nullable=True),
        # 估时准确性
        sa.Column("estimation_accuracy", sa.Float(), nullable=True),
        sa.Column("debt_tendency", sa.Float(), nullable=True),
        sa.Column("reschedule_rate", sa.Float(), nullable=True),
        # 元数据
        sa.Column("observation_window_days", sa.Integer(), nullable=False, server_default="30"),
        sa.Column("event_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_computed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_learner_profiles_user_id", "learner_profiles", ["user_id"])
    op.create_index("ix_learner_profiles_goal_id", "learner_profiles", ["goal_id"])
    op.create_index("ix_learner_profiles_last_computed", "learner_profiles", ["last_computed_at"])

    # ── learner_patterns ───────────────────────────────────────────────────
    op.create_table(
        "learner_patterns",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "goal_id", sa.String(), sa.ForeignKey("goals.id", ondelete="SET NULL"), nullable=True
        ),
        # 模式定义
        sa.Column("pattern_type", sa.String(), nullable=False),
        sa.Column("pattern_value", sa.JSON(), nullable=False, server_default="{}"),
        # 置信度
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("evidence_count", sa.Integer(), nullable=False, server_default="0"),
        # 范围与参数
        sa.Column("scope", sa.String(), nullable=False, server_default="goal"),
        sa.Column("decay_rate", sa.Float(), nullable=False, server_default="0.05"),
        # 生命周期
        sa.Column("status", sa.String(), nullable=False, server_default="candidate"),
        sa.Column("first_observed_at", sa.DateTime(), nullable=False),
        sa.Column("last_confirmed_at", sa.DateTime(), nullable=True),
        # 元数据
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_learner_patterns_user_id", "learner_patterns", ["user_id"])
    op.create_index("ix_learner_patterns_goal_id", "learner_patterns", ["goal_id"])
    op.create_index(
        "ix_learner_patterns_status_confidence", "learner_patterns", ["status", "confidence"]
    )
    op.create_index(
        "ix_learner_patterns_type_status", "learner_patterns", ["pattern_type", "status"]
    )

    # ── pattern_evidences ──────────────────────────────────────────────────
    op.create_table(
        "pattern_evidences",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "pattern_id",
            sa.String(),
            sa.ForeignKey("learner_patterns.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "learning_event_id",
            sa.String(),
            sa.ForeignKey("learning_events.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # 贡献量
        sa.Column("contribution", sa.Float(), nullable=False, server_default="1.0"),
        # 时间 & 元信息
        sa.Column("recorded_at", sa.DateTime(), nullable=False),
        sa.Column("meta", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_pattern_evidences_pattern_id", "pattern_evidences", ["pattern_id"])
    op.create_index(
        "ix_pattern_evidences_learning_event_id", "pattern_evidences", ["learning_event_id"]
    )
    op.create_index("ix_pattern_evidences_recorded_at", "pattern_evidences", ["recorded_at"])


def downgrade() -> None:
    # pattern_evidences
    op.drop_index("ix_pattern_evidences_recorded_at", "pattern_evidences")
    op.drop_index("ix_pattern_evidences_learning_event_id", "pattern_evidences")
    op.drop_index("ix_pattern_evidences_pattern_id", "pattern_evidences")
    op.drop_table("pattern_evidences")

    # learner_patterns
    op.drop_index("ix_learner_patterns_type_status", "learner_patterns")
    op.drop_index("ix_learner_patterns_status_confidence", "learner_patterns")
    op.drop_index("ix_learner_patterns_goal_id", "learner_patterns")
    op.drop_index("ix_learner_patterns_user_id", "learner_patterns")
    op.drop_table("learner_patterns")

    # learner_profiles
    op.drop_index("ix_learner_profiles_last_computed", "learner_profiles")
    op.drop_index("ix_learner_profiles_goal_id", "learner_profiles")
    op.drop_index("ix_learner_profiles_user_id", "learner_profiles")
    op.drop_table("learner_profiles")
