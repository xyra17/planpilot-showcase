"""add agent v2.4 planning history and monotonic event cursor

Revision ID: p0q1r2s3t4u5
Revises: o9p0q1r2s3t4
Create Date: 2026-07-27
"""

from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa

from alembic import op

revision: str = "p0q1r2s3t4u5"
down_revision: Union[str, None] = "o9p0q1r2s3t4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "agent_runs",
        sa.Column("plan_history", sa.JSON(), server_default=sa.text("'[]'::json"), nullable=False),
    )
    op.add_column(
        "agent_steps",
        sa.Column(
            "resolved_input_summary",
            sa.JSON(),
            server_default=sa.text("'{}'::json"),
            nullable=False,
        ),
    )
    op.execute(
        "UPDATE agent_runs SET plan_history = json_build_array("
        "json_build_object('version', plan_version, 'planner', 'legacy', 'steps', plan))"
    )
    op.execute("CREATE SEQUENCE agent_audit_event_sequence")
    op.add_column(
        "agent_audit_events",
        sa.Column("sequence", sa.BigInteger(), nullable=True),
    )
    op.execute(
        "WITH ordered AS ("
        "SELECT id, row_number() OVER (ORDER BY created_at, id) AS value "
        "FROM agent_audit_events"
        ") UPDATE agent_audit_events AS event "
        "SET sequence = ordered.value FROM ordered WHERE event.id = ordered.id"
    )
    op.execute(
        "SELECT setval('agent_audit_event_sequence', "
        "COALESCE((SELECT MAX(sequence) FROM agent_audit_events), 1), "
        "EXISTS(SELECT 1 FROM agent_audit_events))"
    )
    op.alter_column(
        "agent_audit_events",
        "sequence",
        server_default=sa.text("nextval('agent_audit_event_sequence')"),
        nullable=False,
    )
    op.create_index(
        "ix_agent_audit_events_sequence",
        "agent_audit_events",
        ["sequence"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_agent_audit_events_sequence", table_name="agent_audit_events")
    op.drop_column("agent_audit_events", "sequence")
    op.execute("DROP SEQUENCE agent_audit_event_sequence")
    op.drop_column("agent_steps", "resolved_input_summary")
    op.drop_column("agent_runs", "plan_history")
