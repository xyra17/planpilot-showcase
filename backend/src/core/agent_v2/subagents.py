from dataclasses import dataclass

from src.core.agent_v2.schemas import AgentRole


@dataclass(frozen=True)
class SubAgentProfile:
    role: AgentRole
    label: str
    purpose: str
    write_access: bool = False


SUBAGENTS = {
    AgentRole.LEARNING_ANALYST: SubAgentProfile(
        AgentRole.LEARNING_ANALYST, "学习分析 Agent", "分析执行率、逾期和学习债务"
    ),
    AgentRole.SCHEDULE_OPTIMIZER: SubAgentProfile(
        AgentRole.SCHEDULE_OPTIMIZER, "日程优化 Agent", "生成容量受限的候选排期"
    ),
    AgentRole.KNOWLEDGE_RESEARCHER: SubAgentProfile(
        AgentRole.KNOWLEDGE_RESEARCHER, "知识检索 Agent", "检索项目知识和受控网络来源"
    ),
    AgentRole.PLAN_REVIEWER: SubAgentProfile(
        AgentRole.PLAN_REVIEWER, "计划审查 Agent", "检查冲突、风险和遗漏"
    ),
}
