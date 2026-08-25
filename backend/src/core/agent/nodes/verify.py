from langchain_core.messages import SystemMessage
from sqlalchemy import select

from src.core.agent.persona import PILO_IDENTITY
from src.core.agent.state import AgentState
from src.core.llm_quality import compact_text
from src.core.llm_router import create_interactive_llm
from src.database import AsyncSessionLocal
from src.models import Goal

_SYSTEM_TPL = (
    PILO_IDENTITY
    + """
当前任务：作为 Pilo 掌握验证助手，围绕目标「{goal_title}」检验用户的真实理解。
根据该目标的学习内容，生成一道深度检验理解的问题。
要求：
- 聚焦原理理解、应用场景或知识点间的联系，而非可直接搜索的事实
- 问题简洁（30字以内），紧扣「{goal_title}」相关知识
- 末尾加上"（请直接回复你的答案，我来评估）"
只输出问题本身，不加其他内容。"""
)


async def node(state: AgentState) -> dict:
    goal_title = "当前目标"
    goal_id = state.get("goal_id")
    if goal_id:
        try:
            async with AsyncSessionLocal() as db:
                row = (await db.execute(select(Goal.title).where(Goal.id == goal_id))).first()
            if row:
                goal_title = row.title
        except Exception:
            pass

    llm = create_interactive_llm(max_tokens=200)
    messages = [SystemMessage(content=_SYSTEM_TPL.format(goal_title=goal_title))] + list(
        state.get("messages", [])
    )
    response = await llm.ainvoke(messages)
    response.content = compact_text(response.content, 55)
    return {"messages": [response]}
