from langchain_core.messages import AIMessage

from src.core.agent.state import AgentState


async def node(state: AgentState) -> dict:
    if state.get("user_confirmed"):
        return {
            "pending_replan": True,
            "pending_confirmation": None,
            "user_confirmed": False,
        }
    msg = AIMessage(content="好的，保持当前计划，继续加油！")
    return {
        "messages": [msg],
        "pending_replan": False,
        "pending_confirmation": None,
        "user_confirmed": False,
    }
