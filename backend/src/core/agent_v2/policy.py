from src.core.agent_v2.registry import ToolSpec
from src.core.agent_v2.schemas import Effect, Risk


def requires_approval(tool: ToolSpec) -> bool:
    return (
        tool.requires_approval
        or tool.effect == Effect.WRITE
        or tool.risk in {Risk.MEDIUM, Risk.HIGH}
    )


def can_auto_execute(tool: ToolSpec) -> bool:
    return tool.effect in {Effect.READ, Effect.PROPOSE} and not requires_approval(tool)
