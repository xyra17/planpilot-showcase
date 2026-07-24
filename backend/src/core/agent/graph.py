import logging

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

from src.core.agent.nodes import chat as chat_node
from src.core.agent.nodes import checkin as checkin_node
from src.core.agent.nodes import confirm_replan as confirm_replan_node
from src.core.agent.nodes import intent as intent_node
from src.core.agent.nodes import planner as planner_node
from src.core.agent.nodes import replan_chat as replan_chat_node
from src.core.agent.nodes import verify as verify_node
from src.core.agent.state import AgentState
from src.core.agent.tools import chat_tools

logger = logging.getLogger(__name__)

_agent = None
_pool = None


def _route(state: AgentState) -> str:
    return state.get("intent") or "chat"


def _build_structure() -> StateGraph:
    g = StateGraph(AgentState)

    g.add_node("identify_intent", intent_node.node)
    g.add_node("setup_goal", planner_node.node)
    g.add_node("checkin", checkin_node.node)
    g.add_node("chat", chat_node.node)
    g.add_node("chat_tools", ToolNode(tools=chat_tools))
    g.add_node("replan_chat", replan_chat_node.node)
    g.add_node("confirm_replan", confirm_replan_node.node)
    g.add_node("verify", verify_node.node)

    g.add_edge(START, "identify_intent")
    g.add_conditional_edges(
        "identify_intent",
        _route,
        {
            "goal_setup": "setup_goal",
            "checkin": "checkin",
            "replan_request": "replan_chat",
            "verification": "verify",
            "chat": "chat",
        },
    )
    g.add_edge("setup_goal", END)
    g.add_edge("checkin", END)
    g.add_conditional_edges("chat", tools_condition, {"tools": "chat_tools", END: END})
    g.add_edge("chat_tools", "chat")
    g.add_edge("verify", END)
    g.add_edge("replan_chat", "confirm_replan")
    g.add_edge("confirm_replan", END)

    return g


async def get_agent():
    global _agent, _pool
    if _agent is not None:
        return _agent

    try:
        from psycopg_pool import AsyncConnectionPool
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
        from src.config import settings

        pg_url = settings.database_url.replace("+asyncpg", "")
        _pool = AsyncConnectionPool(conninfo=pg_url, max_size=5, open=False)
        await _pool.open(wait=True, timeout=10.0)
        checkpointer = AsyncPostgresSaver(_pool)
        await checkpointer.setup()
        _agent = _build_structure().compile(
            checkpointer=checkpointer,
            interrupt_before=["confirm_replan"],
        )
        logger.info("Agent initialized with AsyncPostgresSaver")
    except Exception as e:
        logger.warning("AsyncPostgresSaver init failed (%s) — falling back to MemorySaver", e)
        _agent = _build_structure().compile(checkpointer=MemorySaver())

    return _agent


async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
