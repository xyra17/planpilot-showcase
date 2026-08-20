"""Phase 5 production-grade learning agent control plane.

Revision ID: z9a0b1c2d3e4
Revises: y8z9a0b1c2d3
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "z9a0b1c2d3e4"
down_revision: str | None = "y8z9a0b1c2d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now())]


def upgrade() -> None:
    op.add_column(
        "users", sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.false())
    )
    op.create_index("ix_users_is_admin", "users", ["is_admin"])

    op.create_table(
        "prompt_versions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("agent_type", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("version", sa.String(), nullable=False),
        sa.Column("template", sa.Text(), nullable=False),
        sa.Column("variables_schema", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("output_schema", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="draft"),
        sa.Column("change_note", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(), nullable=False),
        *_timestamps(),
        sa.UniqueConstraint("agent_type", "name", "version", name="uq_prompt_agent_name_version"),
    )
    op.create_table(
        "model_configs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("version", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("model_name", sa.String(), nullable=False),
        sa.Column("temperature", sa.Float(), nullable=False, server_default="0.2"),
        sa.Column("max_tokens", sa.Integer(), nullable=False, server_default="700"),
        sa.Column("timeout_ms", sa.Integer(), nullable=False, server_default="60000"),
        sa.Column("retry_policy", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("credential_alias", sa.String(), nullable=False, server_default="default"),
        sa.Column("status", sa.String(), nullable=False, server_default="draft"),
        sa.Column("created_by", sa.String(), nullable=False),
        *_timestamps(),
        sa.UniqueConstraint("name", "version", name="uq_model_config_version"),
    )
    op.create_table(
        "agent_policy_versions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("agent_type", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("version", sa.String(), nullable=False),
        sa.Column("rules", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("rules_schema_version", sa.String(), nullable=False, server_default="v1"),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="draft"),
        sa.Column("change_note", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(), nullable=False),
        sa.Column("approved_by", sa.String(), nullable=True),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        *_timestamps(),
        sa.UniqueConstraint("agent_type", "name", "version", name="uq_policy_agent_name_version"),
    )
    op.create_table(
        "agent_deployments",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("agent_type", sa.String(), nullable=False),
        sa.Column("environment", sa.String(), nullable=False),
        sa.Column(
            "prompt_version_id",
            sa.String(),
            sa.ForeignKey("prompt_versions.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "model_config_id",
            sa.String(),
            sa.ForeignKey("model_configs.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "policy_version_id",
            sa.String(),
            sa.ForeignKey("agent_policy_versions.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("deployed_by", sa.String(), nullable=False),
        sa.Column(
            "rollback_of_id",
            sa.String(),
            sa.ForeignKey("agent_deployments.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("deployed_at", sa.DateTime(), nullable=False),
        *_timestamps(),
    )
    op.create_index(
        "uq_agent_deployment_active",
        "agent_deployments",
        ["agent_type", "environment"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
        sqlite_where=sa.text("status = 'active'"),
    )

    op.create_table(
        "evaluation_datasets",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("version", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("source_type", sa.String(), nullable=False, server_default="curated"),
        sa.Column(
            "context_schema_version",
            sa.String(),
            nullable=False,
            server_default="decision-context-v2",
        ),
        sa.Column(
            "label_schema_version", sa.String(), nullable=False, server_default="agent-label-v1"
        ),
        sa.Column("split", sa.String(), nullable=False, server_default="validation"),
        sa.Column("status", sa.String(), nullable=False, server_default="draft"),
        sa.Column("case_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("created_by", sa.String(), nullable=False),
        *_timestamps(),
        sa.UniqueConstraint("name", "version", name="uq_eval_dataset_version"),
    )
    op.create_table(
        "evaluation_cases",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "dataset_id",
            sa.String(),
            sa.ForeignKey("evaluation_datasets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("case_key", sa.String(), nullable=False),
        sa.Column("category", sa.String(), nullable=False),
        sa.Column("input_context", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("expected_output", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("reference_evidence", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("safety_expectations", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("label_source", sa.String(), nullable=False, server_default="curated"),
        sa.Column("label_confidence", sa.Float(), nullable=False, server_default="1"),
        *_timestamps(),
        sa.UniqueConstraint("dataset_id", "case_key", name="uq_eval_case_key"),
    )
    op.create_table(
        "evaluation_runs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "dataset_id",
            sa.String(),
            sa.ForeignKey("evaluation_datasets.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "prompt_version_id",
            sa.String(),
            sa.ForeignKey("prompt_versions.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "model_config_id",
            sa.String(),
            sa.ForeignKey("model_configs.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "policy_version_id",
            sa.String(),
            sa.ForeignKey("agent_policy_versions.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "baseline_run_id",
            sa.String(),
            sa.ForeignKey("evaluation_runs.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("status", sa.String(), nullable=False, server_default="queued"),
        sa.Column("seed", sa.Integer(), nullable=True),
        sa.Column("summary_metrics", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("created_by", sa.String(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        *_timestamps(),
    )
    op.create_table(
        "experiments",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False, unique=True),
        sa.Column("hypothesis", sa.Text(), nullable=False),
        sa.Column("agent_type", sa.String(), nullable=False),
        sa.Column("environment", sa.String(), nullable=False, server_default="production"),
        sa.Column("status", sa.String(), nullable=False, server_default="draft"),
        sa.Column("allocation_percent", sa.Float(), nullable=False, server_default="0"),
        sa.Column("primary_metric", sa.String(), nullable=False),
        sa.Column("secondary_metrics", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("guardrail_metrics", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("eligibility_rules", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("minimum_sample_size", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("analysis_plan", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("created_by", sa.String(), nullable=False),
        sa.Column("approved_by", sa.String(), nullable=True),
        sa.Column("start_at", sa.DateTime(), nullable=True),
        sa.Column("end_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "experiment_variants",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "experiment_id",
            sa.String(),
            sa.ForeignKey("experiments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("display_name", sa.String(), nullable=False),
        sa.Column("traffic_weight", sa.Float(), nullable=False),
        sa.Column(
            "prompt_version_id",
            sa.String(),
            sa.ForeignKey("prompt_versions.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "model_config_id",
            sa.String(),
            sa.ForeignKey("model_configs.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "policy_version_id",
            sa.String(),
            sa.ForeignKey("agent_policy_versions.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("is_control", sa.Boolean(), nullable=False, server_default=sa.false()),
        *_timestamps(),
        sa.UniqueConstraint("experiment_id", "key", name="uq_experiment_variant"),
    )
    op.create_table(
        "experiment_assignments",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "experiment_id",
            sa.String(),
            sa.ForeignKey("experiments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "variant_id",
            sa.String(),
            sa.ForeignKey("experiment_variants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("bucket", sa.Integer(), nullable=False),
        sa.Column("assignment_version", sa.String(), nullable=False, server_default="v1"),
        sa.Column("eligibility_snapshot", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("assigned_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("experiment_id", "user_id", name="uq_experiment_assignment_user"),
    )

    op.create_table(
        "agent_invocations",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id", sa.String(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column(
            "goal_id", sa.String(), sa.ForeignKey("goals.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("agent_type", sa.String(), nullable=False),
        sa.Column(
            "agent_run_id",
            sa.String(),
            sa.ForeignKey("agent_runs.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "agent_step_id",
            sa.String(),
            sa.ForeignKey("agent_steps.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "proposal_id",
            sa.String(),
            sa.ForeignKey("decision_proposals.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "prompt_version_id",
            sa.String(),
            sa.ForeignKey("prompt_versions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "model_config_id",
            sa.String(),
            sa.ForeignKey("model_configs.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "policy_version_id",
            sa.String(),
            sa.ForeignKey("agent_policy_versions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "experiment_id",
            sa.String(),
            sa.ForeignKey("experiments.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "variant_id",
            sa.String(),
            sa.ForeignKey("experiment_variants.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("input_context_hash", sa.String(64), nullable=False),
        sa.Column("prompt_render_hash", sa.String(64), nullable=True),
        sa.Column("output", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("latency_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("total_tokens", sa.Integer(), nullable=True),
        sa.Column("estimated_cost", sa.Float(), nullable=True),
        sa.Column("success", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("fallback", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("error_category", sa.String(), nullable=True),
        sa.Column("trace_id", sa.String(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=False),
        *_timestamps(),
        sa.UniqueConstraint("trace_id", name="uq_agent_invocation_trace"),
    )
    op.create_table(
        "experiment_exposures",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "assignment_id",
            sa.String(),
            sa.ForeignKey("experiment_assignments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "agent_invocation_id",
            sa.String(),
            sa.ForeignKey("agent_invocations.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("context_hash", sa.String(64), nullable=False),
        sa.Column("exposed_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "evaluation_results",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "evaluation_run_id",
            sa.String(),
            sa.ForeignKey("evaluation_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "case_id",
            sa.String(),
            sa.ForeignKey("evaluation_cases.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "agent_invocation_id",
            sa.String(),
            sa.ForeignKey("agent_invocations.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("actual_output", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("recommendation_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("planning_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("evidence_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("safety_passed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("safety_findings", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("latency_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("token_usage", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("evaluator_versions", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("passed", sa.Boolean(), nullable=False, server_default=sa.false()),
        *_timestamps(),
        sa.UniqueConstraint("evaluation_run_id", "case_id", name="uq_eval_result_case"),
    )
    op.create_table(
        "agent_feedback_events",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "goal_id", sa.String(), sa.ForeignKey("goals.id", ondelete="SET NULL"), nullable=True
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
        sa.Column(
            "source_event_id",
            sa.String(),
            sa.ForeignKey("learning_events.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("feedback_type", sa.String(), nullable=False),
        sa.Column("value", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("attribution_window", sa.String(), nullable=False, server_default="immediate"),
        sa.Column("metric_version", sa.String(), nullable=False, server_default="v1"),
        sa.Column("dedupe_key", sa.String(200), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        *_timestamps(),
        sa.UniqueConstraint("dedupe_key", name="uq_agent_feedback_dedupe"),
    )
    op.create_table(
        "agent_metrics_daily",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("metric_date", sa.String(), nullable=False),
        sa.Column("agent_type", sa.String(), nullable=False),
        sa.Column("prompt_version_id", sa.String(), nullable=True),
        sa.Column("model_config_id", sa.String(), nullable=True),
        sa.Column("policy_version_id", sa.String(), nullable=True),
        sa.Column("experiment_id", sa.String(), nullable=True),
        sa.Column("variant_id", sa.String(), nullable=True),
        sa.Column("segment_key", sa.String(), nullable=False, server_default="all"),
        sa.Column("dimension_key", sa.String(64), nullable=False),
        sa.Column("metric_version", sa.String(), nullable=False, server_default="v1"),
        sa.Column("metrics", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("health_status", sa.String(), nullable=False, server_default="healthy"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint(
            "metric_date",
            "agent_type",
            "dimension_key",
            "metric_version",
            name="uq_agent_metrics_daily_dimensions",
        ),
    )
    op.create_table(
        "agent_incidents",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("severity", sa.String(), nullable=False),
        sa.Column("agent_type", sa.String(), nullable=False),
        sa.Column(
            "deployment_id",
            sa.String(),
            sa.ForeignKey("agent_deployments.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "experiment_id",
            sa.String(),
            sa.ForeignKey("experiments.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("trigger_metric", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("evidence_snapshot", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("status", sa.String(), nullable=False, server_default="open"),
        sa.Column("action_taken", sa.String(), nullable=True),
        sa.Column(
            "rollback_deployment_id",
            sa.String(),
            sa.ForeignKey("agent_deployments.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("resolution_note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("resolved_by", sa.String(), nullable=True),
    )

    index_map = {
        "prompt_versions": ["agent_type", "content_hash", "status"],
        "model_configs": ["status"],
        "agent_policy_versions": ["agent_type", "content_hash", "status"],
        "agent_deployments": [
            "agent_type",
            "environment",
            "prompt_version_id",
            "model_config_id",
            "policy_version_id",
            "status",
        ],
        "evaluation_datasets": ["status"],
        "evaluation_cases": ["dataset_id", "category"],
        "evaluation_runs": ["dataset_id", "prompt_version_id", "model_config_id", "status"],
        "experiments": ["agent_type", "status"],
        "experiment_variants": ["experiment_id"],
        "experiment_assignments": ["experiment_id", "user_id"],
        "agent_invocations": [
            "user_id",
            "goal_id",
            "agent_type",
            "agent_run_id",
            "proposal_id",
            "prompt_version_id",
            "model_config_id",
            "experiment_id",
            "variant_id",
            "input_context_hash",
            "success",
            "fallback",
            "error_category",
            "trace_id",
        ],
        "experiment_exposures": ["assignment_id"],
        "evaluation_results": ["evaluation_run_id", "case_id", "passed"],
        "agent_feedback_events": [
            "user_id",
            "goal_id",
            "agent_invocation_id",
            "proposal_id",
            "feedback_type",
        ],
        "agent_metrics_daily": ["metric_date", "agent_type", "health_status"],
        "agent_incidents": ["severity", "agent_type", "status"],
    }
    for table, columns in index_map.items():
        for column in columns:
            op.create_index(f"ix_{table}_{column}", table, [column])


def downgrade() -> None:
    for table in (
        "agent_incidents",
        "agent_metrics_daily",
        "agent_feedback_events",
        "evaluation_results",
        "experiment_exposures",
        "agent_invocations",
        "experiment_assignments",
        "experiment_variants",
        "experiments",
        "evaluation_runs",
        "evaluation_cases",
        "evaluation_datasets",
        "agent_deployments",
        "agent_policy_versions",
        "model_configs",
        "prompt_versions",
    ):
        op.drop_table(table)
    op.drop_index("ix_users_is_admin", table_name="users")
    op.drop_column("users", "is_admin")
