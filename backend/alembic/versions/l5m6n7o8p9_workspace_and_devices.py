"""Add the shared cloud-workspace boundary and device registry.

Revision ID: l5m6n7o8p9
Revises: k4l5m6n7o8
"""

from collections.abc import Sequence
import uuid

import sqlalchemy as sa
from alembic import op

revision: str = "l5m6n7o8p9"
down_revision: str | None = "k4l5m6n7o8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


SCOPED_TABLES = (
    "goals",
    "knowledge_bases",
    "knowledge_items",
    "coach_conversations",
    "mastery_evidence",
)


def _workspace_id(user_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"planpilot:personal:{user_id}"))


def upgrade() -> None:
    op.create_table(
        "workspaces",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("owner_user_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("kind", sa.String(length=24), server_default="cloud", nullable=False),
        sa.Column("is_default", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("kind = 'cloud'", name="ck_workspaces_cloud_only"),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_workspaces_owner_user_id", "workspaces", ["owner_user_id"])
    op.create_index("ix_workspaces_owner_default", "workspaces", ["owner_user_id", "is_default"])
    op.create_table(
        "workspace_members",
        sa.Column("workspace_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("role", sa.String(length=24), server_default="owner", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("workspace_id", "user_id"),
    )
    op.create_table(
        "devices",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("installation_id", sa.String(length=120), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("platform", sa.String(length=40), nullable=False),
        sa.Column("app_version", sa.String(length=40), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "installation_id", name="uq_device_user_installation"),
    )
    op.create_index("ix_devices_user_id", "devices", ["user_id"])

    bind = op.get_bind()
    users = bind.execute(sa.text("SELECT id, username FROM users")).mappings().all()
    for user in users:
        workspace_id = _workspace_id(user["id"])
        bind.execute(
            sa.text("INSERT INTO workspaces (id, owner_user_id, name, kind, is_default, version) VALUES (:id, :uid, :name, 'cloud', true, 1)"),
            {"id": workspace_id, "uid": user["id"], "name": "我的学习空间"},
        )
        bind.execute(
            sa.text("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (:wid, :uid, 'owner')"),
            {"wid": workspace_id, "uid": user["id"]},
        )

    for table in SCOPED_TABLES:
        op.add_column(table, sa.Column("workspace_id", sa.String(), nullable=True))
        bind.execute(
            sa.text(
                f"UPDATE {table} SET workspace_id = workspaces.id FROM workspaces "
                f"WHERE {table}.user_id = workspaces.owner_user_id AND workspaces.is_default = true"
            )
        )
        op.alter_column(table, "workspace_id", nullable=False)
        op.create_foreign_key(
            f"fk_{table}_workspace_id", table, "workspaces", ["workspace_id"], ["id"], ondelete="CASCADE"
        )
        op.create_index(f"ix_{table}_workspace_id", table, ["workspace_id"])


def downgrade() -> None:
    for table in reversed(SCOPED_TABLES):
        op.drop_index(f"ix_{table}_workspace_id", table_name=table)
        op.drop_constraint(f"fk_{table}_workspace_id", table, type_="foreignkey")
        op.drop_column(table, "workspace_id")
    op.drop_index("ix_devices_user_id", table_name="devices")
    op.drop_table("devices")
    op.drop_table("workspace_members")
    op.drop_index("ix_workspaces_owner_default", table_name="workspaces")
    op.drop_index("ix_workspaces_owner_user_id", table_name="workspaces")
    op.drop_table("workspaces")
