"""Domain schema cleanup: extract meta fields, add goal_versions, task_mastery_records

Revision ID: q1r2s3t4u5v6
Revises: p0q1r2s3t4u5
Create Date: 2026-07-29
"""

from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa

from alembic import op

revision: str = "q1r2s3t4u5v6"
down_revision: Union[str, None] = "p0q1r2s3t4u5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── goals: 提升 meta 字段为独立列 ──────────────────────────────────
    op.add_column("goals", sa.Column("knowledge_base_id", sa.String(), nullable=True))
    op.add_column(
        "goals", sa.Column("work_schedule", sa.String(), nullable=True, server_default="all")
    )
    op.add_column("goals", sa.Column("description", sa.Text(), nullable=True))
    op.add_column(
        "goals",
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
    )

    op.create_index("ix_goals_knowledge_base_id", "goals", ["knowledge_base_id"])
    op.create_foreign_key(
        "fk_goals_knowledge_base_id",
        "goals",
        "knowledge_bases",
        ["knowledge_base_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # 数据迁移: meta["kb_id"] → knowledge_base_id, meta["work_schedule"] → work_schedule
    op.execute("""
        UPDATE goals
        SET
            knowledge_base_id = (meta->>'kb_id')::varchar,
            work_schedule      = COALESCE(meta->>'work_schedule', 'all')
        WHERE meta IS NOT NULL
    """)

    # ── plans: 新增 created_by / updated_at ───────────────────────────
    op.add_column("plans", sa.Column("created_by", sa.String(), nullable=True, server_default="ai"))
    op.add_column(
        "plans",
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
    )

    # ── tasks: 新增 updated_at / stage_label / sequence_in_plan ───────
    op.add_column(
        "tasks",
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
    )
    op.add_column("tasks", sa.Column("stage_label", sa.String(), nullable=True))
    op.add_column("tasks", sa.Column("sequence_in_plan", sa.Integer(), nullable=True))

    # ── checkin_records: 新增 duration_mins ───────────────────────────
    op.add_column("checkin_records", sa.Column("duration_mins", sa.Integer(), nullable=True))

    # ── learning_debts: 新增 user_id / resolved_at / updated_at ──────
    op.add_column("learning_debts", sa.Column("user_id", sa.String(), nullable=True))
    op.add_column("learning_debts", sa.Column("resolved_at", sa.DateTime(), nullable=True))
    op.add_column(
        "learning_debts",
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
    )

    op.create_index("ix_learning_debts_user_id", "learning_debts", ["user_id"])
    op.create_foreign_key(
        "fk_learning_debts_user_id",
        "learning_debts",
        "users",
        ["user_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # 数据迁移: learning_debts.user_id ← goals.user_id
    op.execute("""
        UPDATE learning_debts ld
        SET user_id = g.user_id
        FROM goals g
        WHERE ld.goal_id = g.id
    """)

    # ── goal_versions（新表）────────────────────────────────────────────
    op.create_table(
        "goal_versions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "goal_id",
            sa.String(),
            sa.ForeignKey("goals.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("title_snapshot", sa.Text(), nullable=True),
        sa.Column("objective_snapshot", sa.Text(), nullable=True),
        sa.Column("constraints_snapshot", sa.JSON(), nullable=True),
        sa.Column("change_reason", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(), nullable=False, server_default="user"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
    )

    # ── task_mastery_records（新表）─────────────────────────────────────
    op.create_table(
        "task_mastery_records",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "task_id",
            sa.String(),
            sa.ForeignKey("tasks.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "goal_id",
            sa.String(),
            sa.ForeignKey("goals.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("mastery_level", sa.String(), nullable=False),
        sa.Column("source", sa.String(), nullable=False, server_default="checkin_submission"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
    )

    # 数据迁移: 将 tasks.mastery_level 现有值回填到 task_mastery_records
    op.execute("""
        INSERT INTO task_mastery_records (id, task_id, goal_id, user_id, mastery_level, source, created_at)
        SELECT
            gen_random_uuid()::text,
            t.id,
            t.goal_id,
            g.user_id,
            CASE WHEN t.mastery_level IS NULL OR t.mastery_level = '' THEN 'unknown' ELSE t.mastery_level END,
            'system_estimate',
            t.created_at
        FROM tasks t
        JOIN goals g ON t.goal_id = g.id
        WHERE t.mastery_level IS NOT NULL
    """)


def downgrade() -> None:
    op.drop_table("task_mastery_records")
    op.drop_table("goal_versions")

    op.drop_constraint("fk_learning_debts_user_id", "learning_debts", type_="foreignkey")
    op.drop_index("ix_learning_debts_user_id", "learning_debts")
    op.drop_column("learning_debts", "updated_at")
    op.drop_column("learning_debts", "resolved_at")
    op.drop_column("learning_debts", "user_id")

    op.drop_column("checkin_records", "duration_mins")

    op.drop_column("tasks", "sequence_in_plan")
    op.drop_column("tasks", "stage_label")
    op.drop_column("tasks", "updated_at")

    op.drop_column("plans", "updated_at")
    op.drop_column("plans", "created_by")

    op.drop_constraint("fk_goals_knowledge_base_id", "goals", type_="foreignkey")
    op.drop_index("ix_goals_knowledge_base_id", "goals")
    op.drop_column("goals", "updated_at")
    op.drop_column("goals", "description")
    op.drop_column("goals", "work_schedule")
    op.drop_column("goals", "knowledge_base_id")
