"""Link learning insights to approval-gated action runs."""

import sqlalchemy as sa

from alembic import op

revision: str = "b5c6d7e8f9g0"
down_revision: str | None = "a4b5c6d7e8f9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("decision_proposals", sa.Column("action_capability", sa.String(), nullable=True))
    op.add_column(
        "decision_proposals",
        sa.Column("action_seed", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.add_column("decision_proposals", sa.Column("converted_run_id", sa.String(), nullable=True))
    op.create_foreign_key(
        "fk_decision_proposals_converted_run_id_agent_runs",
        "decision_proposals",
        "agent_runs",
        ["converted_run_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_decision_proposals_converted_run_id",
        "decision_proposals",
        ["converted_run_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_decision_proposals_converted_run_id", table_name="decision_proposals")
    op.drop_constraint(
        "fk_decision_proposals_converted_run_id_agent_runs",
        "decision_proposals",
        type_="foreignkey",
    )
    op.drop_column("decision_proposals", "converted_run_id")
    op.drop_column("decision_proposals", "action_seed")
    op.drop_column("decision_proposals", "action_capability")
