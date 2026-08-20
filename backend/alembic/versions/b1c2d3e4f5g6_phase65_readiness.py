"""Phase 6.5 distributed runtime, timezone, observations and traces.

Revision ID: b1c2d3e4f5g6
Revises: a0b1c2d3e4f5
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b1c2d3e4f5g6"
down_revision: str | None = "a0b1c2d3e4f5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("timezone", sa.String(64), nullable=False, server_default="Asia/Shanghai"),
    )
    op.create_table(
        "agent_trace_spans",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("trace_id", sa.String(), nullable=False),
        sa.Column("span_id", sa.String(), nullable=False, unique=True),
        sa.Column("parent_span_id", sa.String(), nullable=True),
        sa.Column(
            "agent_invocation_id",
            sa.String(),
            sa.ForeignKey("agent_invocations.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "user_id", sa.String(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column(
            "goal_id", sa.String(), sa.ForeignKey("goals.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("span_kind", sa.String(), nullable=False, server_default="internal"),
        sa.Column("status", sa.String(), nullable=False, server_default="ok"),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=False),
        sa.Column("latency_ms", sa.Float(), nullable=False, server_default="0"),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("estimated_cost", sa.Float(), nullable=True),
        sa.Column("attributes", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("error_category", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    for column in (
        "trace_id",
        "parent_span_id",
        "agent_invocation_id",
        "user_id",
        "goal_id",
        "status",
        "error_category",
    ):
        op.create_index(f"ix_agent_trace_spans_{column}", "agent_trace_spans", [column])
    op.create_index(
        "ix_agent_trace_spans_trace_started", "agent_trace_spans", ["trace_id", "started_at"]
    )

    op.create_table(
        "canary_observations",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "canary_release_id",
            sa.String(),
            sa.ForeignKey("canary_releases.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "experiment_id",
            sa.String(),
            sa.ForeignKey("experiments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "variant_id",
            sa.String(),
            sa.ForeignKey("experiment_variants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id", sa.String(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column(
            "agent_invocation_id",
            sa.String(),
            sa.ForeignKey("agent_invocations.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "proposal_id",
            sa.String(),
            sa.ForeignKey("decision_proposals.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("observation_type", sa.String(), nullable=False),
        sa.Column("metric_name", sa.String(), nullable=False),
        sa.Column("metric_value", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("attribution_window", sa.String(), nullable=False, server_default="immediate"),
        sa.Column("dedupe_key", sa.String(200), nullable=False, unique=True),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    for column in (
        "canary_release_id",
        "experiment_id",
        "variant_id",
        "user_id",
        "agent_invocation_id",
        "proposal_id",
        "observation_type",
        "metric_name",
    ):
        op.create_index(f"ix_canary_observations_{column}", "canary_observations", [column])
    op.create_index(
        "ix_canary_observations_release_metric",
        "canary_observations",
        ["canary_release_id", "observation_type", "metric_name"],
    )


def downgrade() -> None:
    op.drop_table("canary_observations")
    op.drop_table("agent_trace_spans")
    op.drop_column("users", "timezone")
