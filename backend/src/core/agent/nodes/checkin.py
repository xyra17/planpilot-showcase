from langchain_core.messages import SystemMessage
from langchain_openai import ChatOpenAI
from sqlalchemy import select

from src.config import settings
from src.core.agent.state import AgentState
from src.database import AsyncSessionLocal
from src.models import Goal

_SYSTEM_TPL = """你是 PlanPilot 学习助教，负责引导用户完成「{goal_title}」的今日打卡。

规则：
- 如果用户只是表示要打卡，先询问：今天「{goal_title}」的学习任务完成得怎么样？
- 如果用户已经汇报了完成情况，给出简短积极的回应（2-3句），肯定努力并给出一个具体建议。

语气友好简洁，用中文回复。"""

_RATE_KEYWORDS = {
    1.0: ["全部完成", "全做完", "都完成", "完成了所有", "100%"],
    0.75: ["大部分", "差不多", "基本完成", "大概完成", "75%"],
    0.5:  ["一半", "50%", "完成一半", "部分完成"],
    0.25: ["一点点", "很少", "没怎么", "几乎没", "25%"],
    0.0:  ["没完成", "没做", "没有学", "0%"],
}


def _estimate_rate(text: str) -> float:
    for rate, keywords in sorted(_RATE_KEYWORDS.items(), reverse=True):
        for kw in keywords:
            if kw in text:
                return rate
    return 0.5  # 默认50%


async def node(state: AgentState) -> dict:
    msgs = state.get("messages", [])
    last_text = msgs[-1].content if msgs else ""

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
        max_tokens=256,
        streaming=True,
    )
    system = _SYSTEM_TPL.format(goal_title=goal_title)
    messages = [SystemMessage(content=system)] + list(msgs)
    response = await llm.ainvoke(messages)

    return {
        "messages": [response],
        "checkin_rate": _estimate_rate(last_text),
        "checkin_text": last_text,
    }
