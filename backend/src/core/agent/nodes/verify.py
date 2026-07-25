from langchain_core.messages import SystemMessage
from langchain_openai import ChatOpenAI
from sqlalchemy import select

from src.config import settings
from src.core.agent.state import AgentState
from src.database import AsyncSessionLocal
from src.models import Goal

_SYSTEM_TPL = """你是 PlanPilot 验收助手，当前目标：「{goal_title}」。
根据该目标的学习内容，生成一道深度检验理解的问题。
要求：
- 聚焦原理理解、应用场景或知识点间的联系，而非可直接搜索的事实
- 问题简洁（30字以内），紧扣「{goal_title}」相关知识
- 末尾加上"（请直接回复你的答案，我来评估）"
只输出问题本身，不加其他内容。"""


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
        model=settings.smart_pro_model_name,
        api_key=settings.smart_api_key,
        base_url=settings.smart_base_url or None,
        max_tokens=200,
    )
    messages = [SystemMessage(content=_SYSTEM_TPL.format(goal_title=goal_title))] + list(state.get("messages", []))
    response = await llm.ainvoke(messages)
    return {"messages": [response]}
