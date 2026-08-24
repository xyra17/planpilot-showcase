import re

from src.core.agent.state import AgentState

_CHECKIN_KEYWORDS = [
    "打卡",
    "打个卡",
    "今天学",
    "今日学",
    "完成了",
    "学习了",
    "复习了",
    "今天完成",
    "今日完成",
    "没完成",
    "未完成",
    "没有完成",
    "没背完",
    "只背了",
    "没读完",
    "只读了",
    "记录一下",
    "汇报",
    "进展",
    "学了",
    "实际投入",
    "投入了",
    "刚完成",
    "用时",
]
_GOAL_KEYWORDS = [
    "制定计划",
    "学习计划",
    "帮我规划",
    "想学",
    "制定学习",
    "设置目标",
    "新目标",
    "规划",
    "帮我制定",
    "开始制定",
    "帮我做计划",
    "我打算学",
    "我想开始学",
    "建立目标",
    "确认目标",
    "我要制定",
    "帮我建",
    "制定一个计划",
    "帮我整",
    "给我排",
    "做个计划",
    "排一下",
    "整一个计划",
    "搞个计划",
    "来个计划",
    "排个计划",
    "做一个计划",
    "帮我搞",
    "怎么开始",
]
_REPLAN_KEYWORDS = [
    "重新规划",
    "重规划",
    "调整计划",
    "重新制定",
    "重新安排",
    "修改计划",
    "更新计划",
    "计划跟不上",
    "计划太难",
    "进度落后",
    "想换成",
    "换成",
    "改成",
    "调整成",
]
_VERIFY_KEYWORDS = [
    "验收",
    "检验",
    "测测我",
    "考考我",
    "来考我",
    "测试我",
    "验证一下",
    "检验我",
    "出题考我",
    "检测我",
    "验一验",
    "出道题",
    "出一道题",
    "出几道题",
    "小测",
    "测验一下",
    "是不是真懂",
    "真正理解",
]


def _keyword_intent(text: str) -> str | None:
    # Hypothetical impact-analysis requests must stay conversational even when
    # their object contains “完成/未完成”; those words describe task state rather
    # than a submitted check-in.
    if any(
        re.search(pattern, text)
        for pattern in (
            r"(?:只|先)(?:分析|说明|说说|告诉).{0,12}(?:别|不要|不)(?:执行|修改|保存|写入)",
            r"(?:只分析|只说明|只说影响|只看影响|分析影响).{0,12}(?:别执行|不执行)?",
            r"(?:要是|假如|假设|如果).{0,40}(?:影响多大|会怎样|怎么样|什么影响|后果)",
        )
    ):
        return None
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

    # 明确动作使用确定性路由。其余消息直接进入聊天，避免在回答前串行调用一次模型。
    return {"intent": _keyword_intent(last) or "chat"}
