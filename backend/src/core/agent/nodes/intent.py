from langchain_core.messages import HumanMessage, SystemMessage

from src.core.agent.state import AgentState
from src.core.llm_router import create_routine_llm

_SYSTEM = """判断用户消息的意图，只输出以下之一的英文单词，不加任何解释：
goal_setup - 用户想要设定新目标或制定/修改学习计划（例如："我想学Python"、"帮我整个计划"、"给我排一下课程"、"我打算开始学设计"、"做个英语学习计划"、"帮我建一个目标"）
checkin - 用户在汇报今日学习进展
replan_request - 用户请求重新规划/调整学习计划
verification - 用户想要验收/检验学习掌握情况
chat - 其他所有对话"""

_CHECKIN_KEYWORDS = [
    "打卡", "今天学", "今日学", "完成了", "学习了", "复习了",
    "今天完成", "今日完成", "汇报", "进展", "学了",
]
_GOAL_KEYWORDS = [
    "制定计划", "学习计划", "帮我规划", "想学", "制定学习",
    "设置目标", "新目标", "规划", "帮我制定",
    "开始制定", "帮我做计划", "我打算学", "我想开始学", "建立目标",
    "确认目标", "我要制定", "帮我建", "制定一个计划",
    "帮我整", "给我排", "做个计划", "排一下", "整一个计划",
    "搞个计划", "来个计划", "排个计划", "做一个计划", "帮我搞",
]
_REPLAN_KEYWORDS = [
    "重新规划", "重规划", "调整计划", "重新制定", "重新安排",
    "修改计划", "更新计划", "计划跟不上", "计划太难", "进度落后",
]
_VERIFY_KEYWORDS = [
    "验收", "检验", "测测我", "考考我", "来考我", "测试我",
    "验证一下", "检验我", "出题考我", "检测我", "验一验",
]


def _keyword_intent(text: str) -> str | None:
    for kw in _REPLAN_KEYWORDS:
        if kw in text:
            return "replan_request"
    for kw in _VERIFY_KEYWORDS:
        if kw in text:
            return "verification"
    for kw in _CHECKIN_KEYWORDS:
        if kw in text:
            return "checkin"
    for kw in _GOAL_KEYWORDS:
        if kw in text:
            return "goal_setup"
    return None


async def node(state: AgentState) -> dict:
    msgs = state.get("messages", [])
    last = msgs[-1].content if msgs else ""

    # 关键词优先
    intent = _keyword_intent(last)
    if intent:
        return {"intent": intent}

    # 关键词无法判断时由本地模型分类，服务不可用则自动回退 Flash。
    llm = create_routine_llm(max_tokens=10)
    result = await llm.ainvoke(
        [SystemMessage(content=_SYSTEM), HumanMessage(content=last)]
    )
    raw = result.content.strip().lower()
    if "replan" in raw:
        intent = "replan_request"
    elif "verif" in raw:
        intent = "verification"
    elif "goal" in raw:
        intent = "goal_setup"
    elif "checkin" in raw:
        intent = "checkin"
    else:
        intent = "chat"
    return {"intent": intent}
