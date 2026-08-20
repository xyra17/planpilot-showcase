"""add domain versions and event linkage

Revision ID: t7u8v9w0x1y2
Revises: s6t7u8v9w0x1
"""

from alembic import op
import sqlalchemy as sa

revision = "t7u8v9w0x1y2"
down_revision = "s6t7u8v9w0x1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "goals", sa.Column("version", sa.Integer(), server_default="1", nullable=False)
    )
    op.add_column(
        "tasks", sa.Column("version", sa.Integer(), server_default="1", nullable=False)
    )
    op.create_unique_constraint(
        "uq_goal_versions_goal_version", "goal_versions", ["goal_id", "version"]
    )
    op.add_column("learning_events", sa.Column("correlation_id", sa.String(), nullable=True))
    op.add_column("learning_events", sa.Column("causation_id", sa.String(), nullable=True))
    op.add_column("learning_events", sa.Column("idempotency_key", sa.String(), nullable=True))
    op.create_index(
        "ix_learning_events_correlation_id", "learning_events", ["correlation_id"]
    )
    op.create_index("ix_learning_events_causation_id", "learning_events", ["causation_id"])
    op.create_unique_constraint(
        "uq_learning_events_idempotency_key", "learning_events", ["idempotency_key"]
    )
    op.add_column(
        "decision_proposals",
        sa.Column("application_snapshot", sa.JSON(), server_default="{}", nullable=False),
    )
    op.add_column(
        "prediction_observations", sa.Column("target_version", sa.Integer(), nullable=True)
    )
    op.add_column(
        "prediction_observations", sa.Column("target_id", sa.String(), nullable=True)
    )
    op.create_index(
        "ix_prediction_observations_target_id", "prediction_observations", ["target_id"]
    )
    op.add_column(
        "prediction_observations", sa.Column("target_scheduled_date", sa.String(), nullable=True)
    )
    op.add_column(
        "prediction_observations", sa.Column("outcome_event_id", sa.String(), nullable=True)
    )
    op.drop_constraint(
        "prediction_observations_task_id_fkey",
        "prediction_observations",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "prediction_observations_task_id_fkey",
        "prediction_observations",
        "tasks",
        ["task_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_prediction_observations_outcome_event",
        "prediction_observations",
        "learning_events",
        ["outcome_event_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_prediction_observations_outcome_event_id",
        "prediction_observations",
        ["outcome_event_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_prediction_observations_outcome_event_id", table_name="prediction_observations"
    )
    op.drop_constraint(
        "prediction_observations_task_id_fkey",
        "prediction_observations",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "prediction_observations_task_id_fkey",
        "prediction_observations",
        "tasks",
        ["task_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.drop_constraint(
        "fk_prediction_observations_outcome_event",
        "prediction_observations",
        type_="foreignkey",
    )
    op.drop_column("prediction_observations", "outcome_event_id")
    op.drop_column("prediction_observations", "target_scheduled_date")
    op.drop_index("ix_prediction_observations_target_id", table_name="prediction_observations")
    op.drop_column("prediction_observations", "target_id")
    op.drop_column("prediction_observations", "target_version")
    op.drop_column("decision_proposals", "application_snapshot")
    op.drop_constraint(
        "uq_learning_events_idempotency_key", "learning_events", type_="unique"
    )
    op.drop_index("ix_learning_events_causation_id", table_name="learning_events")
    op.drop_index("ix_learning_events_correlation_id", table_name="learning_events")
    op.drop_column("learning_events", "idempotency_key")
    op.drop_column("learning_events", "causation_id")
    op.drop_column("learning_events", "correlation_id")
    op.drop_constraint("uq_goal_versions_goal_version", "goal_versions", type_="unique")
    op.drop_column("tasks", "version")
    op.drop_column("goals", "version")
