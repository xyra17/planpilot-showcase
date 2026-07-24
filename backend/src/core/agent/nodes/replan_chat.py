from langchain_core.messages import SystemMessage
from langchain_openai import ChatOpenAI
from sqlalchemy import select

from src.config import settings
from src.core.agent.state import AgentState
from src.database import AsyncSessionLocal
from src.models import Goal

_SYSTEM_TPL = """你是 PlanPilot 学习助教。用户请求重新规划「{goal_title}」的学习计划。
用1-2句话确认你将根据近期打卡情况重新生成更合理的计划，询问用户是否确认。用中文回复，语气友好简洁。"""


async def node(state: AgentState) -> dict:
    goal_title = "当前目标"
    goal_id = state.get("goal_id")
    if goal_id:
        try:
            async with AsyncSessionLocal() as db:
                row = (await db.execute(
                    select(Goal.title).where(Goal.id == goal_id)
                )).first()
            if row:
                goal_title = row.title
        except Exception:
            pass

    llm = ChatOpenAI(
        model=settings.smart_model_name or settings.model_name,
        api_key=settings.smart_api_key or settings.openai_api_key,
        base_url=settings.smart_base_url or settings.openai_base_url or None,
        max_tokens=200,
        streaming=True,
    )
    messages = [SystemMessage(content=_SYSTEM_TPL.format(goal_title=goal_title))] + list(state.get("messages", []))
    response = await llm.ainvoke(messages)
    return {
        "messages": [response],
        "pending_confirmation": {
            "type": "replan",
            "goal_id": goal_id,
        },
    }
