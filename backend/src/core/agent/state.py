from typing import Annotated, Any

from langgraph.graph.message import add_messages
from typing_extensions import TypedDict


class AgentState(TypedDict, total=False):
    messages: Annotated[list, add_messages]
    intent: str
    goal_id: str
    user_id: str
    structured_output: dict[str, Any]
    pending_confirmation: dict[str, Any]
    user_confirmed: bool
    checkin_rate: float
    checkin_text: str
    debt_items: list[dict[str, Any]]
    pilo_preferences: dict[str, Any]
