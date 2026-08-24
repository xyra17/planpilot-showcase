from src.core.agent_v2.registry import ToolSpec
from src.core.agent_v2.schemas import (
    AgentRole,
    ChangeSet,
    Effect,
    PolicyDecision,
    PolicyOutcome,
    ReviewOutput,
    Risk,
)


def evaluate_policy(
    tool: ToolSpec,
    *,
    role: AgentRole | None = None,
    change_set: ChangeSet | None = None,
    review: ReviewOutput | dict | None = None,
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
            outcome=PolicyOutcome.DENY,
            risk=Risk.HIGH,
            reasons=["受控能力模块不得执行副作用工具"],
        )
    operations = change_set.operations if change_set else []
    review_output = (
        review
        if isinstance(review, ReviewOutput)
        else ReviewOutput.model_validate(review)
        if review
        else None
    )
    findings = review_output.findings if review_output else []
    finding_codes = [finding.code for finding in findings]
    blockers = [finding for finding in findings if finding.blocking]
    if blockers:
        return PolicyDecision(
            outcome=PolicyOutcome.DENY,
            risk=Risk.HIGH,
            reasons=[finding.message for finding in blockers],
            obligations=["resolve_blocking_review_findings"],
            review_finding_codes=finding_codes,
        )
    if any(finding.severity in {"high", "critical"} for finding in findings):
        risk = Risk.HIGH
        reasons.extend(
            finding.message for finding in findings if finding.severity in {"high", "critical"}
        )
        obligations.append("explicit_high_risk_confirmation")
    elif any(finding.severity == "medium" for finding in findings):
        if risk == Risk.LOW:
            risk = Risk.MEDIUM
        reasons.extend(finding.message for finding in findings if finding.severity == "medium")
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
        obligations.extend(
            [
                "approved_change_hash",
                "current_run_state",
                "review_findings_verified",
                "read_back_verification",
            ]
        )
        if run_kind == "suggestion":
            reasons.append("主动建议 Run 的副作用必须由用户确认")
        return PolicyDecision(
            outcome=PolicyOutcome.REQUIRE_APPROVAL,
            risk=risk,
            reasons=reasons or ["工具包含副作用"],
            obligations=list(dict.fromkeys(obligations)),
            review_finding_codes=finding_codes,
        )
    return PolicyDecision(
        outcome=PolicyOutcome.ALLOW,
        risk=risk,
        reasons=["低风险只读或提案工具"],
        review_finding_codes=finding_codes,
    )


def requires_approval(tool: ToolSpec) -> bool:
    return evaluate_policy(tool).outcome == PolicyOutcome.REQUIRE_APPROVAL


def can_auto_execute(tool: ToolSpec) -> bool:
    return tool.effect in {Effect.READ, Effect.PROPOSE} and not requires_approval(tool)
