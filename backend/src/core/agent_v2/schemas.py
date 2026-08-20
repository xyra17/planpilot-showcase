from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from src.core.time import utc_now

JSONValue = Any


class Effect(StrEnum):
    READ = "read"
    PROPOSE = "propose"
    WRITE = "write"
    DESTRUCTIVE = "destructive"
    EXTERNAL = "external"


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


class RunStatus(StrEnum):
    QUEUED = "queued"
    EXECUTING = "executing"
    WAITING_APPROVAL = "waiting_approval"
    RETRYING = "retrying"
    REPLANNING = "replanning"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    REJECTED = "rejected"
    CANCELLED = "cancelled"
    COMPENSATING = "compensating"
    ROLLED_BACK = "rolled_back"


class StepStatus(StrEnum):
    PENDING = "pending"
    READY = "ready"
    RUNNING = "running"
    RETRYING = "retrying"
    WAITING_APPROVAL = "waiting_approval"
    COMPLETED = "completed"
    FAILED = "failed"
    BLOCKED = "blocked"
    SKIPPED = "skipped"
    SUPERSEDED = "superseded"


class ErrorCategory(StrEnum):
    RETRYABLE = "retryable"
    RECOVERABLE = "recoverable"
    FATAL = "fatal"
    CANCELLED = "cancelled"
    BUDGET_EXCEEDED = "budget_exceeded"


class PolicyOutcome(StrEnum):
    ALLOW = "allow"
    REQUIRE_APPROVAL = "require_approval"
    DENY = "deny"


class ToolContext(BaseModel):
    user_id: str
    run_id: str
    step_id: str
    source_step_id: str | None = None
    lease_token: str | None = None


class OutputRef(BaseModel):
    step_id: str
    path: str | None = None


class ChangeOperation(BaseModel):
    operation_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    entity: str
    entity_id: str
    field: str
    before: JSONValue
    after: JSONValue
    label: str
    reason: str
    precondition: dict[str, JSONValue] = Field(default_factory=dict)
    source_step_id: str | None = None
    idempotency_key: str | None = None
    compensation: dict[str, JSONValue] = Field(default_factory=dict)


class ChangeSet(BaseModel):
    change_set_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    version: int = Field(default=1, ge=1)
    run_id: str | None = None
    plan_version: int = Field(default=1, ge=1)
    summary: str
    operations: list[ChangeOperation] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class PlanStep(BaseModel):
    index: int = Field(ge=0)
    step_id: str | None = None
    title: str
    agent_role: AgentRole
    tool_name: str
    input: dict[str, JSONValue] = Field(default_factory=dict)
    input_refs: dict[str, OutputRef] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list)
    on_failure: Literal["retry", "replan", "fail"] = "fail"
    rationale: str = ""

    @model_validator(mode="after")
    def populate_step_id(self) -> "PlanStep":
        if not self.step_id:
            self.step_id = f"step-{self.index}"
        return self


class AgentPlan(BaseModel):
    version: int = Field(default=1, ge=1)
    planner: Literal["deterministic", "model", "fallback"] = "deterministic"
    objective: dict[str, JSONValue] = Field(default_factory=dict)
    candidate_tools: list[str] = Field(default_factory=list)
    steps: list[PlanStep]
    rationale: str = ""
    estimated_tokens: int = Field(default=0, ge=0)


class AgentError(BaseModel):
    code: str
    category: ErrorCategory
    safe_message: str
    retry_after_seconds: int | None = None
    detail: dict[str, JSONValue] = Field(default_factory=dict)


class PolicyDecision(BaseModel):
    outcome: PolicyOutcome
    risk: Risk
    reasons: list[str] = Field(default_factory=list)
    obligations: list[str] = Field(default_factory=list)
    policy_version: str = "v2.2"
    evaluated_at: datetime = Field(default_factory=utc_now)


class CreateRunRequest(BaseModel):
    request: str = Field(min_length=2, max_length=2000)
    goal_id: str | None = None
    step_budget: int = Field(default=10, ge=1, le=20)
    token_budget: int = Field(default=20000, ge=1000, le=100000)


class ApprovalRequest(BaseModel):
    approval_id: str
    change_hash: str
    change_set_version: int | None = Field(default=None, ge=1)
    run_state_version: int | None = Field(default=None, ge=0)
    high_risk_confirmed: bool = False


class RejectRequest(BaseModel):
    approval_id: str
    reason: str | None = Field(default=None, max_length=500)


class EditApprovalRequest(BaseModel):
    change_set: ChangeSet


class ProactiveSuggestionRequest(BaseModel):
    goal_id: str | None = None
    lookback_days: int = Field(default=14, ge=7, le=90)


class PermissiveToolModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class StrictToolInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ContextLoadInput(StrictToolInput):
    goal_id: str | None = None
    lookback_days: int = Field(default=14, ge=7, le=90)


class ContextLoadOutput(PermissiveToolModel):
    goals: list[dict[str, JSONValue]] = Field(default_factory=list)
    tasks: list[dict[str, JSONValue]] = Field(default_factory=list)
    checkins: list[dict[str, JSONValue]] = Field(default_factory=list)
    lookback_days: int = 14


class AnalyticsInput(StrictToolInput):
    context: dict[str, JSONValue]


class AnalyticsOutput(PermissiveToolModel):
    completion_rate: float
    overdue_tasks: list[dict[str, JSONValue]] = Field(default_factory=list)
    needs_attention: bool = False


class RescheduleInput(StrictToolInput):
    context: dict[str, JSONValue]
    analysis: dict[str, JSONValue] = Field(default_factory=dict)
    excluded_weekdays: list[int] = Field(default_factory=list)
    request: str = ""
    goal_id: str | None = None


class ReviewInput(StrictToolInput):
    change_set: dict[str, JSONValue]


class ReviewOutput(PermissiveToolModel):
    approved_for_preview: bool
    warnings: list[str] = Field(default_factory=list)
    operation_count: int = 0


class ApplyChangesInput(StrictToolInput):
    change_set: dict[str, JSONValue]
    review: dict[str, JSONValue] = Field(default_factory=dict)


class ApplyChangesOutput(PermissiveToolModel):
    applied: list[dict[str, JSONValue]] = Field(default_factory=list)
    undo_operations: list[dict[str, JSONValue]] = Field(default_factory=list)
    count: int = 0


class KnowledgeSearchInput(StrictToolInput):
    query: str
    goal_id: str | None = None


class KnowledgeSearchOutput(PermissiveToolModel):
    query: str
    results: list[dict[str, JSONValue]] = Field(default_factory=list)


class EvidenceRef(BaseModel):
    evidence_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    source_type: Literal["goal", "task", "checkin", "knowledge", "calendar", "web"]
    source_id: str | None = None
    label: str
    excerpt: str | None = None


class SubAgentRequest(BaseModel):
    run_id: str
    objective: dict[str, JSONValue]
    input_data: dict[str, JSONValue]
    allowed_tools: list[str]


class SubAgentConclusion(BaseModel):
    text: str
    kind: Literal["observation", "candidate", "evidence", "warning"]
    evidence_ids: list[str] = Field(default_factory=list)
    confidence: float = Field(default=1.0, ge=0, le=1)


class SubAgentResult(BaseModel):
    summary: str
    evidence: list[EvidenceRef] = Field(default_factory=list)
    confidence: float = Field(default=1.0, ge=0, le=1)
    warnings: list[str] = Field(default_factory=list)
    data_types_read: list[str] = Field(default_factory=list)
    observation: dict[str, JSONValue] = Field(default_factory=dict)
    conclusions: list[SubAgentConclusion] = Field(default_factory=list)


class LearningAnalystRequest(SubAgentRequest):
    role: Literal[AgentRole.LEARNING_ANALYST] = AgentRole.LEARNING_ANALYST


class ScheduleOptimizerRequest(SubAgentRequest):
    role: Literal[AgentRole.SCHEDULE_OPTIMIZER] = AgentRole.SCHEDULE_OPTIMIZER


class KnowledgeResearcherRequest(SubAgentRequest):
    role: Literal[AgentRole.KNOWLEDGE_RESEARCHER] = AgentRole.KNOWLEDGE_RESEARCHER


class PlanReviewerRequest(SubAgentRequest):
    role: Literal[AgentRole.PLAN_REVIEWER] = AgentRole.PLAN_REVIEWER


class LearningAnalystResult(SubAgentResult):
    role: Literal[AgentRole.LEARNING_ANALYST] = AgentRole.LEARNING_ANALYST


class ScheduleOptimizerResult(SubAgentResult):
    role: Literal[AgentRole.SCHEDULE_OPTIMIZER] = AgentRole.SCHEDULE_OPTIMIZER


class KnowledgeResearcherResult(SubAgentResult):
    role: Literal[AgentRole.KNOWLEDGE_RESEARCHER] = AgentRole.KNOWLEDGE_RESEARCHER


class PlanReviewerResult(SubAgentResult):
    role: Literal[AgentRole.PLAN_REVIEWER] = AgentRole.PLAN_REVIEWER
