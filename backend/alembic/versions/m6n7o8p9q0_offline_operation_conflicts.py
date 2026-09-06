"""Add conservative offline operation and conflict staging.

Revision ID: m6n7o8p9q0
Revises: l5m6n7o8p9
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "m6n7o8p9q0"
down_revision: str | None = "l5m6n7o8p9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "offline_operations",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("workspace_id", sa.String(), nullable=False),
        sa.Column("device_id", sa.String(), nullable=False),
        sa.Column("operation_id", sa.String(length=120), nullable=False),
        sa.Column("operation_type", sa.String(length=16), nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.String(length=120), nullable=True),
        sa.Column("base_version", sa.Integer(), nullable=False),
        sa.Column("server_version", sa.Integer(), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("local_snapshot", sa.JSON(), server_default=sa.text("'{}'"), nullable=False),
        sa.Column("server_snapshot", sa.JSON(), server_default=sa.text("'{}'"), nullable=False),
        sa.Column("status", sa.String(length=24), server_default="queued", nullable=False),
        sa.Column("resolution", sa.String(length=24), nullable=True),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "operation_type IN ('create', 'update', 'delete')",
            name="ck_offline_operation_type",
        ),
        sa.CheckConstraint(
            "entity_type IN ('goal', 'task', 'note', 'knowledge_item')",
            name="ck_offline_entity_type",
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'conflict', 'ready_copy', 'resolved')",
            name="ck_offline_operation_status",
        ),
        sa.CheckConstraint(
            "resolution IS NULL OR resolution IN ('keep_server', 'keep_both')",
            name="ck_offline_operation_resolution",
        ),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "operation_id", name="uq_offline_operation_user_id"),
    )
    op.create_index("ix_offline_operations_user_id", "offline_operations", ["user_id"])
    op.create_index("ix_offline_operations_workspace_id", "offline_operations", ["workspace_id"])
    op.create_index("ix_offline_operations_device_id", "offline_operations", ["device_id"])
    op.create_index("ix_offline_operations_status", "offline_operations", ["status"])
    op.create_index(
        "ix_offline_operations_user_status", "offline_operations", ["user_id", "status"]
    )


def downgrade() -> None:
    op.drop_index("ix_offline_operations_user_status", table_name="offline_operations")
    op.drop_index("ix_offline_operations_status", table_name="offline_operations")
    op.drop_index("ix_offline_operations_device_id", table_name="offline_operations")
    op.drop_index("ix_offline_operations_workspace_id", table_name="offline_operations")
    op.drop_index("ix_offline_operations_user_id", table_name="offline_operations")
    op.drop_table("offline_operations")
