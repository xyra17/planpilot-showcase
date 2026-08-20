from src.core.agent_v2.registry import ToolSpec
from src.core.agent_v2.schemas import (
    AgentRole,
    ChangeSet,
    Effect,
    PolicyDecision,
    PolicyOutcome,
    Risk,
)


def evaluate_policy(
    tool: ToolSpec,
    *,
    role: AgentRole | None = None,
    change_set: ChangeSet | None = None,
    run_kind: str = "user",
) -> PolicyDecision:
    effective_role = role or tool.role
    reasons: list[str] = []
    obligations: list[str] = []
    risk = tool.risk
    if effective_role != AgentRole.MAIN and tool.effect in {
        Effect.WRITE,
        Effect.DESTRUCTIVE,
        Effect.EXTERNAL,
    }:
        return PolicyDecision(
            outcome=PolicyOutcome.DENY, risk=Risk.HIGH, reasons=["从属 Agent 不得执行副作用工具"]
        )
    operations = change_set.operations if change_set else []
    if any(operation.field == "__delete__" for operation in operations):
        risk = Risk.HIGH
        reasons.append("变更集包含删除操作")
    if len(operations) > 10:
        reasons.append("变更规模超过 10 项")
    if (
        tool.effect in {Effect.WRITE, Effect.DESTRUCTIVE, Effect.EXTERNAL}
        or risk in {Risk.MEDIUM, Risk.HIGH}
        or tool.requires_approval
    ):
        obligations.extend(["approved_change_hash", "current_run_state", "read_back_verification"])
        if run_kind == "suggestion":
            reasons.append("主动建议 Run 的副作用必须由用户确认")
        return PolicyDecision(
            outcome=PolicyOutcome.REQUIRE_APPROVAL,
            risk=risk,
            reasons=reasons or ["工具包含副作用"],
            obligations=obligations,
        )
    return PolicyDecision(outcome=PolicyOutcome.ALLOW, risk=risk, reasons=["低风险只读或提案工具"])


def requires_approval(tool: ToolSpec) -> bool:
    return evaluate_policy(tool).outcome == PolicyOutcome.REQUIRE_APPROVAL


def can_auto_execute(tool: ToolSpec) -> bool:
    return tool.effect in {Effect.READ, Effect.PROPOSE} and not requires_approval(tool)
