"""initial_schema

Revision ID: 0c1c9d0abd67
Revises:
Create Date: 2026-07-14 19:41:54.822385

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0c1c9d0abd67"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("username", sa.String(), nullable=False),
        sa.Column("hashed_password", sa.String(), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email"),
        sa.UniqueConstraint("username"),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "goals",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("deadline", sa.String(), nullable=False),
        sa.Column("daily_hours", sa.Float(), server_default="2.0", nullable=False),
        sa.Column("current_level", sa.String(), server_default="beginner", nullable=False),
        sa.Column("status", sa.String(), server_default="active", nullable=False),
        sa.Column("meta", sa.JSON(), server_default="{}", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_goals_user_id", "goals", ["user_id"])

    op.create_table(
        "plans",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("goal_id", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("is_current", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("baseline", sa.JSON(), nullable=True),
        sa.Column("content", sa.JSON(), nullable=True),
        sa.Column("replan_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["goal_id"], ["goals.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_plans_goal_id", "plans", ["goal_id"])

    # tasks: 无 priority（migration b3f7e9a12cd0）、无 description（migration e7a3b9c12d45）
    op.create_table(
        "tasks",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("goal_id", sa.String(), nullable=False),
        sa.Column("plan_id", sa.String(), nullable=True),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("estimated_mins", sa.Integer(), server_default="30", nullable=False),
        sa.Column("actual_mins", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(), server_default="pending", nullable=False),
        sa.Column("type", sa.String(), server_default="study", nullable=False),
        sa.Column("kb_refs", sa.JSON(), server_default="[]", nullable=False),
        sa.Column("mastery_level", sa.String(), server_default="unknown", nullable=False),
        sa.Column("scheduled_date", sa.String(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["goal_id"], ["goals.id"]),
        sa.ForeignKeyConstraint(["plan_id"], ["plans.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tasks_goal_id", "tasks", ["goal_id"])
    op.create_index("ix_tasks_plan_id", "tasks", ["plan_id"])
    op.create_index("ix_tasks_scheduled_date", "tasks", ["scheduled_date"])

    op.create_table(
        "checkin_records",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("goal_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("date", sa.String(), nullable=False),
        sa.Column("mode", sa.String(), nullable=False),
        sa.Column("quick_status", sa.String(), nullable=True),
        sa.Column("natural_text", sa.Text(), nullable=True),
        sa.Column("completion_rate", sa.Float(), server_default="0.0", nullable=False),
        sa.Column("stats", sa.JSON(), server_default="{}", nullable=False),
        sa.Column("feedback", sa.Text(), server_default="", nullable=False),
        sa.Column("replan_triggered", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["goal_id"], ["goals.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_checkin_records_goal_id", "checkin_records", ["goal_id"])
    op.create_index("ix_checkin_records_user_id", "checkin_records", ["user_id"])
    op.create_index("ix_checkin_records_date", "checkin_records", ["date"])

    # knowledge_items: 无 kb_id（migration 49426109cb1d）、无 task_id（f2c8d1e04a7b）、无 note_id（g1h2i3j4k5l6）
    # embedding 为 JSON（migration d2e3f4g5h6i7 负责转换为 vector）
    op.create_table(
        "knowledge_items",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("goal_id", sa.String(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("source_type", sa.String(), server_default="upload", nullable=False),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("file_path", sa.Text(), nullable=True),
        sa.Column("tags", sa.JSON(), server_default="[]", nullable=False),
        sa.Column("embedding", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["goal_id"], ["goals.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_knowledge_items_user_id", "knowledge_items", ["user_id"])
    op.create_index("ix_knowledge_items_goal_id", "knowledge_items", ["goal_id"])

    op.create_table(
        "daily_schedules",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("date", sa.String(), nullable=False),
        sa.Column("blocks", sa.JSON(), server_default="[]", nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "date", name="uq_daily_schedule_user_date"),
    )
    op.create_index("ix_daily_schedules_user_id", "daily_schedules", ["user_id"])
    op.create_index("ix_daily_schedules_date", "daily_schedules", ["date"])

    op.create_table(
        "password_reset_tokens",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("token", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token"),
    )
    op.create_index("ix_password_reset_tokens_user_id", "password_reset_tokens", ["user_id"])
    op.create_index(
        "ix_password_reset_tokens_token", "password_reset_tokens", ["token"], unique=True
    )


def downgrade() -> None:
    op.drop_table("password_reset_tokens")
    op.drop_table("daily_schedules")
    op.drop_table("knowledge_items")
    op.drop_table("checkin_records")
    op.drop_table("tasks")
    op.drop_table("plans")
    op.drop_table("goals")
    op.drop_table("users")
