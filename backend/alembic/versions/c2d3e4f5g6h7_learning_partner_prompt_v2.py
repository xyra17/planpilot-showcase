"""Deploy the learning-partner product voice as Coach prompt v2.

Revision ID: c2d3e4f5g6h7
Revises: b1c2d3e4f5g6
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Sequence
from datetime import datetime, timezone

import sqlalchemy as sa

from alembic import op

revision: str = "c2d3e4f5g6h7"
down_revision: str | None = "b1c2d3e4f5g6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


PROMPT_TEMPLATE = (
    "你是 PlanPilot 学习伙伴。只根据提供的行为证据解释建议，"
    "不得编造数据，不得声称已经修改计划。只输出一个 JSON 对象，字段为 "
    "proposal_type、title、summary、reasoning。proposal_type 必须严格等于 "
    "{expected_type}；reasoning 为 1 到 5 条简短中文理由。"
)


def _content_hash() -> str:
    rendered = json.dumps(
        {"template": PROMPT_TEMPLATE},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(rendered.encode("utf-8")).hexdigest()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def upgrade() -> None:
    bind = op.get_bind()
    prompts = sa.table(
        "prompt_versions",
        sa.column("id", sa.String()),
        sa.column("agent_type", sa.String()),
        sa.column("name", sa.String()),
        sa.column("version", sa.String()),
        sa.column("template", sa.Text()),
        sa.column("variables_schema", sa.JSON()),
        sa.column("output_schema", sa.JSON()),
        sa.column("content_hash", sa.String()),
        sa.column("status", sa.String()),
        sa.column("change_note", sa.Text()),
        sa.column("created_by", sa.String()),
        sa.column("created_at", sa.DateTime()),
    )
    deployments = sa.table(
        "agent_deployments",
        sa.column("id", sa.String()),
        sa.column("agent_type", sa.String()),
        sa.column("environment", sa.String()),
        sa.column("prompt_version_id", sa.String()),
        sa.column("model_config_id", sa.String()),
        sa.column("policy_version_id", sa.String()),
        sa.column("status", sa.String()),
        sa.column("revision", sa.Integer()),
        sa.column("deployed_by", sa.String()),
        sa.column("rollback_of_id", sa.String()),
        sa.column("deployed_at", sa.DateTime()),
        sa.column("created_at", sa.DateTime()),
    )

    prompt_id = bind.execute(
        sa.select(prompts.c.id).where(
            prompts.c.agent_type == "coach",
            prompts.c.name == "daily_coach_prompt",
            prompts.c.version == "coach-v2",
        )
    ).scalar_one_or_none()
    if prompt_id is None:
        prompt_id = str(uuid.uuid4())
        now = _utc_now()
        bind.execute(
            prompts.insert().values(
                id=prompt_id,
                agent_type="coach",
                name="daily_coach_prompt",
                version="coach-v2",
                template=PROMPT_TEMPLATE,
                variables_schema={"type": "object", "additionalProperties": False},
                output_schema={
                    "required": ["proposal_type", "title", "summary", "reasoning"]
                },
                content_hash=_content_hash(),
                status="approved",
                change_note="产品称呼统一为学习伙伴；行为与安全边界不变",
                created_by="system:migration",
                created_at=now,
            )
        )

    active_rows = bind.execute(
        sa.select(
            deployments.c.id,
            deployments.c.environment,
            deployments.c.prompt_version_id,
            deployments.c.model_config_id,
            deployments.c.policy_version_id,
            deployments.c.revision,
        ).where(
            deployments.c.agent_type == "coach",
            deployments.c.status == "active",
        )
    ).mappings()
    for active in active_rows:
        if active["prompt_version_id"] == prompt_id:
            continue
        now = _utc_now()
        bind.execute(
            deployments.update()
            .where(deployments.c.id == active["id"])
            .values(status="superseded")
        )
        bind.execute(
            deployments.insert().values(
                id=str(uuid.uuid4()),
                agent_type="coach",
                environment=active["environment"],
                prompt_version_id=prompt_id,
                model_config_id=active["model_config_id"],
                policy_version_id=active["policy_version_id"],
                status="active",
                revision=(active["revision"] or 0) + 1,
                deployed_by="system:migration",
                rollback_of_id=None,
                deployed_at=now,
                created_at=now,
            )
        )


def downgrade() -> None:
    """Reactivate the preceding deployment while retaining v2 audit history."""
    bind = op.get_bind()
    prompts = sa.table(
        "prompt_versions",
        sa.column("id", sa.String()),
        sa.column("agent_type", sa.String()),
        sa.column("name", sa.String()),
        sa.column("version", sa.String()),
    )
    deployments = sa.table(
        "agent_deployments",
        sa.column("id", sa.String()),
        sa.column("agent_type", sa.String()),
        sa.column("environment", sa.String()),
        sa.column("prompt_version_id", sa.String()),
        sa.column("status", sa.String()),
        sa.column("revision", sa.Integer()),
    )
    prompt_id = bind.execute(
        sa.select(prompts.c.id).where(
            prompts.c.agent_type == "coach",
            prompts.c.name == "daily_coach_prompt",
            prompts.c.version == "coach-v2",
        )
    ).scalar_one_or_none()
    if prompt_id is None:
        return

    active_rows = list(
        bind.execute(
            sa.select(
                deployments.c.id,
                deployments.c.environment,
                deployments.c.revision,
            ).where(
                deployments.c.agent_type == "coach",
                deployments.c.status == "active",
                deployments.c.prompt_version_id == prompt_id,
            )
        ).mappings()
    )
    for active in active_rows:
        previous_id = bind.execute(
            sa.select(deployments.c.id)
            .where(
                deployments.c.agent_type == "coach",
                deployments.c.environment == active["environment"],
                deployments.c.id != active["id"],
                deployments.c.revision < active["revision"],
            )
            .order_by(deployments.c.revision.desc())
            .limit(1)
        ).scalar_one_or_none()
        if previous_id is None:
            continue
        bind.execute(
            deployments.update()
            .where(deployments.c.id == active["id"])
            .values(status="superseded")
        )
        bind.execute(
            deployments.update()
            .where(deployments.c.id == previous_id)
            .values(status="active")
        )
