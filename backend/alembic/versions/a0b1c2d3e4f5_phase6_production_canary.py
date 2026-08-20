"""Phase 6 production hardening and canary release controls.

Revision ID: a0b1c2d3e4f5
Revises: z9a0b1c2d3e4
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a0b1c2d3e4f5"
down_revision: str | None = "z9a0b1c2d3e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _created_at() -> sa.Column:
    return sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now())


def upgrade() -> None:
    op.create_table(
        "offline_evaluation_gates",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "evaluation_run_id",
            sa.String(),
            sa.ForeignKey("evaluation_runs.id", ondelete="RESTRICT"),
            nullable=False,
            unique=True,
        ),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("criteria_version", sa.String(), nullable=False, server_default="production-gate-v1"),
        sa.Column("criteria", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("metrics_snapshot", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("failures", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("dataset_hash", sa.String(64), nullable=False),
        sa.Column("decided_by", sa.String(), nullable=False),
        sa.Column("decided_at", sa.DateTime(), nullable=False),
        _created_at(),
    )
    op.create_index("ix_offline_evaluation_gates_status", "offline_evaluation_gates", ["status"])

    op.create_table(
        "canary_releases",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "experiment_id",
            sa.String(),
            sa.ForeignKey("experiments.id", ondelete="RESTRICT"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "offline_gate_id",
            sa.String(),
            sa.ForeignKey("offline_evaluation_gates.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "baseline_deployment_id",
            sa.String(),
            sa.ForeignKey("agent_deployments.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("agent_type", sa.String(), nullable=False, server_default="coach"),
        sa.Column("environment", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="draft"),
        sa.Column("current_stage", sa.String(), nullable=False, server_default="internal"),
        sa.Column("traffic_percent", sa.Float(), nullable=False, server_default="0"),
        sa.Column("guardrails", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("created_by", sa.String(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        _created_at(),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint(
            "traffic_percent >= 0.0 AND traffic_percent <= 100.0",
            name="ck_canary_traffic_percent",
        ),
    )
    op.create_index("ix_canary_releases_offline_gate_id", "canary_releases", ["offline_gate_id"])
    op.create_index("ix_canary_releases_agent_type", "canary_releases", ["agent_type"])
    op.create_index("ix_canary_releases_environment", "canary_releases", ["environment"])
    op.create_index("ix_canary_releases_status", "canary_releases", ["status"])
    op.create_index("ix_canary_releases_current_stage", "canary_releases", ["current_stage"])
    op.create_table(
        "canary_stage_transitions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "canary_release_id",
            sa.String(),
            sa.ForeignKey("canary_releases.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("from_stage", sa.String(), nullable=True),
        sa.Column("to_stage", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("metrics_snapshot", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("actor", sa.String(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        _created_at(),
    )
    op.create_index(
        "ix_canary_stage_transitions_canary_release_id",
        "canary_stage_transitions",
        ["canary_release_id"],
    )
    op.create_index("ix_canary_stage_transitions_action", "canary_stage_transitions", ["action"])

    op.create_table(
        "prediction_observations",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "goal_id", sa.String(), sa.ForeignKey("goals.id", ondelete="CASCADE"), nullable=True
        ),
        sa.Column(
            "task_id", sa.String(), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=True
        ),
        sa.Column("prediction_type", sa.String(), nullable=False),
        sa.Column("algorithm_version", sa.String(), nullable=False),
        sa.Column("predicted_probability", sa.Float(), nullable=False),
        sa.Column("feature_snapshot", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("prediction_key", sa.String(64), nullable=False, unique=True),
        sa.Column("predicted_at", sa.DateTime(), nullable=False),
        sa.Column("outcome_due_at", sa.DateTime(), nullable=True),
        sa.Column("actual_outcome", sa.Boolean(), nullable=True),
        sa.Column("actual_value", sa.Float(), nullable=True),
        sa.Column("outcome_source", sa.String(), nullable=True),
        sa.Column("outcome_recorded_at", sa.DateTime(), nullable=True),
        _created_at(),
        sa.CheckConstraint(
            "predicted_probability >= 0.0 AND predicted_probability <= 1.0",
            name="ck_prediction_probability",
        ),
    )
    op.create_index("ix_prediction_observations_user_id", "prediction_observations", ["user_id"])
    op.create_index("ix_prediction_observations_goal_id", "prediction_observations", ["goal_id"])
    op.create_index("ix_prediction_observations_task_id", "prediction_observations", ["task_id"])
    op.create_index(
        "ix_prediction_observations_prediction_type",
        "prediction_observations",
        ["prediction_type"],
    )
    op.create_index(
        "ix_prediction_observations_algorithm_version",
        "prediction_observations",
        ["algorithm_version"],
    )
    op.create_index(
        "ix_prediction_observations_outcome_due_at",
        "prediction_observations",
        ["outcome_due_at"],
    )
    op.create_index(
        "ix_prediction_observations_actual_outcome",
        "prediction_observations",
        ["actual_outcome"],
    )
    op.create_index(
        "ix_prediction_observations_calibration",
        "prediction_observations",
        ["prediction_type", "algorithm_version", "predicted_at"],
    )
    op.create_table(
        "prediction_calibration_snapshots",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("prediction_type", sa.String(), nullable=False),
        sa.Column("algorithm_version", sa.String(), nullable=False),
        sa.Column("window_start", sa.DateTime(), nullable=False),
        sa.Column("window_end", sa.DateTime(), nullable=False),
        sa.Column("sample_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("outcome_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("brier_score", sa.Float(), nullable=True),
        sa.Column("expected_calibration_error", sa.Float(), nullable=True),
        sa.Column("buckets", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("status", sa.String(), nullable=False, server_default="insufficient_data"),
        sa.Column("calculated_at", sa.DateTime(), nullable=False),
        _created_at(),
        sa.UniqueConstraint(
            "prediction_type",
            "algorithm_version",
            "window_start",
            "window_end",
            name="uq_prediction_calibration_window",
        ),
    )
    op.create_index(
        "ix_prediction_calibration_snapshots_prediction_type",
        "prediction_calibration_snapshots",
        ["prediction_type"],
    )
    op.create_index(
        "ix_prediction_calibration_snapshots_algorithm_version",
        "prediction_calibration_snapshots",
        ["algorithm_version"],
    )
    op.create_index(
        "ix_prediction_calibration_snapshots_status",
        "prediction_calibration_snapshots",
        ["status"],
    )


def downgrade() -> None:
    op.drop_table("prediction_calibration_snapshots")
    op.drop_index("ix_prediction_observations_calibration", table_name="prediction_observations")
    op.drop_table("prediction_observations")
    op.drop_table("canary_stage_transitions")
    op.drop_table("canary_releases")
    op.drop_table("offline_evaluation_gates")
