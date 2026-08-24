from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from src.core.agent_v2.registry import ToolRegistry
from src.core.agent_v2.schemas import (
    AgentRole,
    Effect,
    EvidenceRef,
    KnowledgeResearcherRequest,
    KnowledgeResearcherResult,
    LearningAnalystRequest,
    LearningAnalystResult,
    PlanReviewerRequest,
    PlanReviewerResult,
    ScheduleOptimizerRequest,
    ScheduleOptimizerResult,
    SubAgentConclusion,
    SubAgentRequest,
    SubAgentResult,
    ToolContext,
)


@dataclass(frozen=True)
class CapabilityProfile:
    role: AgentRole
    label: str
    purpose: str
    output_kind: str


CAPABILITY_MODULES = {
    AgentRole.LEARNING_ANALYST: CapabilityProfile(
        AgentRole.LEARNING_ANALYST, "学习分析能力", "分析执行率、逾期和学习债务", "observation"
    ),
    AgentRole.SCHEDULE_OPTIMIZER: CapabilityProfile(
        AgentRole.SCHEDULE_OPTIMIZER,
        "计划与任务编排能力",
        "生成容量受限的任务与排期候选方案",
        "candidate",
    ),
    AgentRole.KNOWLEDGE_RESEARCHER: CapabilityProfile(
        AgentRole.KNOWLEDGE_RESEARCHER,
        "知识与证据能力",
        "检索项目知识和受控来源",
        "evidence",
    ),
    AgentRole.PLAN_REVIEWER: CapabilityProfile(
        AgentRole.PLAN_REVIEWER,
        "风险与影响审查能力",
        "检查容量、截止日期、冲突、删除风险和遗漏",
        "warning",
    ),
}

REQUEST_MODELS = {
    AgentRole.LEARNING_ANALYST: LearningAnalystRequest,
    AgentRole.SCHEDULE_OPTIMIZER: ScheduleOptimizerRequest,
    AgentRole.KNOWLEDGE_RESEARCHER: KnowledgeResearcherRequest,
    AgentRole.PLAN_REVIEWER: PlanReviewerRequest,
}

RESULT_MODELS = {
    AgentRole.LEARNING_ANALYST: LearningAnalystResult,
    AgentRole.SCHEDULE_OPTIMIZER: ScheduleOptimizerResult,
    AgentRole.KNOWLEDGE_RESEARCHER: KnowledgeResearcherResult,
    AgentRole.PLAN_REVIEWER: PlanReviewerResult,
}


async def invoke_capability(
    db: AsyncSession,
    *,
    registry: ToolRegistry,
    role: AgentRole,
    tool_name: str,
    request: SubAgentRequest,
    context: ToolContext,
) -> tuple[dict[str, Any], SubAgentResult]:
    request = REQUEST_MODELS[role].model_validate(request.model_dump())
    spec = registry.get(tool_name)
    if role == AgentRole.MAIN or spec.role != role or tool_name not in request.allowed_tools:
        raise PermissionError("从属能力调用超出授权范围")
    if spec.effect in {Effect.WRITE, Effect.DESTRUCTIVE, Effect.EXTERNAL}:
        raise PermissionError("受控能力模块不得调用副作用工具")
    output = await registry.invoke(db, spec, context, request.input_data)
    evidence: list[EvidenceRef] = []
    conclusions: list[SubAgentConclusion] = []
    data_types: list[str] = []
    if tool_name == "context.load":
        data_types = [key for key in ("goals", "tasks", "checkins") if output.get(key)]
        evidence = [
            EvidenceRef(
                source_type="goal", source_id=item.get("id"), label=str(item.get("title", "目标"))
            )
            for item in output.get("goals", [])[:5]
        ]
        evidence.extend(
            EvidenceRef(
                source_type="task", source_id=item.get("id"), label=str(item.get("title", "任务"))
            )
            for item in output.get("tasks", [])[:8]
        )
        evidence.extend(
            EvidenceRef(source_type="checkin", source_id=None, label=f"打卡 {item.get('date', '')}")
            for item in output.get("checkins", [])[:5]
        )
        conclusions = [
            SubAgentConclusion(
                text=f"已读取 {len(output.get('goals', []))} 个目标、{len(output.get('tasks', []))} 项任务和 {len(output.get('checkins', []))} 条打卡记录",
                kind="observation",
                evidence_ids=[item.evidence_id for item in evidence],
            )
        ]
    elif tool_name == "knowledge.search":
        data_types = ["knowledge"]
        evidence = [
            EvidenceRef(
                source_type="knowledge",
                source_id=item.get("id"),
                label=str(item.get("title", "知识")),
                excerpt=item.get("snippet"),
            )
            for item in output.get("results", [])[:8]
        ]
        conclusions = [
            SubAgentConclusion(
                text=f"检索到相关资料：{item.label}",
                kind="evidence",
                evidence_ids=[item.evidence_id],
            )
            for item in evidence
        ]
    elif tool_name == "analytics.execution_summary":
        data_types = [
            key for key in ("tasks", "checkins") if request.input_data.get("context", {}).get(key)
        ]
        evidence = [
            EvidenceRef(
                source_type="task", source_id=item.get("id"), label=str(item.get("title", "任务"))
            )
            for item in request.input_data.get("context", {}).get("tasks", [])[:8]
        ]
        conclusions = [
            SubAgentConclusion(
                text=f"近期完成率 {output.get('completion_rate', 0)}%，逾期任务 {output.get('overdue_count', len(output.get('overdue_tasks', [])))} 项",
                kind="observation",
                evidence_ids=[item.evidence_id for item in evidence],
                confidence=0.9,
            )
        ]
    elif tool_name.startswith("schedule.") or tool_name.startswith("tasks.preview"):
        data_types = ["tasks"]
        evidence = [
            EvidenceRef(
                source_type="task", source_id=item.get("id"), label=str(item.get("title", "任务"))
            )
            for item in request.input_data.get("context", {}).get("tasks", [])[:8]
        ]
        conclusions = [
            SubAgentConclusion(
                text=str(output.get("summary", "已生成候选变更方案")),
                kind="candidate",
                evidence_ids=[item.evidence_id for item in evidence],
                confidence=0.85,
            )
        ]
    elif tool_name == "plan.review":
        operations = request.input_data.get("change_set", {}).get("operations", [])
        evidence = [
            EvidenceRef(
                source_type="task",
                source_id=item.get("entity_id"),
                label=str(item.get("label", "任务变更")),
            )
            for item in operations[:10]
        ]
        conclusions = [
            SubAgentConclusion(
                text=warning,
                kind="warning",
                evidence_ids=[item.evidence_id for item in evidence],
            )
            for warning in output.get("warnings", [])
        ] or [
            SubAgentConclusion(
                text="方案未发现阻止审批的结构化风险",
                kind="observation",
                evidence_ids=[item.evidence_id for item in evidence],
            )
        ]
    profile = CAPABILITY_MODULES[role]
    result = RESULT_MODELS[role](
        summary=f"{profile.label} 已完成{profile.purpose}",
        evidence=evidence,
        warnings=list(output.get("warnings", [])),
        data_types_read=data_types,
        observation={"kind": profile.output_kind, "output": output},
        conclusions=conclusions,
    )
    return output, result
