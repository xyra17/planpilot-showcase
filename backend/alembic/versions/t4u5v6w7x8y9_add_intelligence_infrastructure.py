"""add intelligence infrastructure

Revision ID: t4u5v6w7x8y9
Revises: s3t4u5v6w7x8
Create Date: 2026-07-29

Phase 2C-3: Pattern Analyzer 基础设施
- intelligence_cursors : Intelligence Layer 多 consumer 游标表
- pattern_evidences 幂等约束 : uq_pattern_evidence_event (pattern_id, learning_event_id)
  NULL learning_event_id（system_prior）不参与唯一约束（SQL 标准）
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision = "t4u5v6w7x8y9"
down_revision = "s3t4u5v6w7x8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── intelligence_cursors ───────────────────────────────────────────────
    op.create_table(
        "intelligence_cursors",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("consumer_name", sa.String(), nullable=False),
        sa.Column("last_event_id", sa.String(), nullable=True),
        sa.Column("last_processed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_unique_constraint(
        "uq_intelligence_cursors_consumer",
        "intelligence_cursors",
        ["consumer_name"],
    )

    # ── pattern_evidences 幂等约束 ──────────────────────────────────────────
    # (pattern_id, learning_event_id) 组合唯一
    # learning_event_id=NULL（system_prior）时 SQL 标准不触发唯一约束，无需特殊处理
    op.create_unique_constraint(
        "uq_pattern_evidence_event",
        "pattern_evidences",
        ["pattern_id", "learning_event_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_pattern_evidence_event", "pattern_evidences", type_="unique")
    op.drop_constraint("uq_intelligence_cursors_consumer", "intelligence_cursors", type_="unique")
    op.drop_table("intelligence_cursors")
