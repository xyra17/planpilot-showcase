from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class Effect(StrEnum):
    READ = "read"
    PROPOSE = "propose"
    WRITE = "write"


class Risk(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class AgentRole(StrEnum):
    MAIN = "main"
    LEARNING_ANALYST = "learning_analyst"
    SCHEDULE_OPTIMIZER = "schedule_optimizer"
    KNOWLEDGE_RESEARCHER = "knowledge_researcher"
    PLAN_REVIEWER = "plan_reviewer"


class ToolContext(BaseModel):
    user_id: str
    run_id: str
    step_id: str


class ChangeOperation(BaseModel):
    entity: str
    entity_id: str
    field: str
    before: Any
    after: Any
    label: str
    reason: str


class ChangeSet(BaseModel):
    summary: str
    operations: list[ChangeOperation] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class PlanStep(BaseModel):
    index: int
    title: str
    agent_role: AgentRole
    tool_name: str
    input: dict[str, Any] = Field(default_factory=dict)
    depends_on: list[int] = Field(default_factory=list)


class CreateRunRequest(BaseModel):
    request: str = Field(min_length=2, max_length=2000)
    goal_id: str | None = None
    step_budget: int = Field(default=10, ge=1, le=20)
    token_budget: int = Field(default=20000, ge=1000, le=100000)


class ApprovalRequest(BaseModel):
    approval_id: str
    change_hash: str


class RejectRequest(BaseModel):
    approval_id: str
    reason: str | None = Field(default=None, max_length=500)


class EditApprovalRequest(BaseModel):
    change_set: ChangeSet


class ProactiveSuggestionRequest(BaseModel):
    goal_id: str | None = None
    lookback_days: int = Field(default=14, ge=7, le=90)
