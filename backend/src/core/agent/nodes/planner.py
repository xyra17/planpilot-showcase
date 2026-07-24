import json
import logging

from langchain_core.messages import AIMessage, SystemMessage
from langchain_openai import ChatOpenAI

from src.config import settings
from src.core.agent.state import AgentState

logger = logging.getLogger(__name__)

_SYSTEM = """你是 PlanPilot 计划生成专家。根据用户提供的目标信息，生成结构化学习计划。

规划原则（必须遵守）：
1. 每7天安排1个 buffer 日（不排任务，用于复习或缓冲）
2. 前20%时间夯实基础概念，中60%深化与练习，后20%综合复习与模拟
3. 每个学习任务聚焦单一知识点，时长15-60分钟，避免过长
4. 根据用户当前水平调整难度曲线，beginner 从入门资料切入
5. 在难点/高频考点处标注 difficulty_warning，资料类任务附 resource_hint

严格按以下 JSON 格式输出，不加任何多余文字：
{
  "plan_summary": "一句话概述",
  "total_weeks": 数字,
  "weekly_hours": 数字,
  "phases": [{"name": "阶段名", "duration_weeks": 数字, "focus": "重点内容"}],
  "sample_tasks": [{"title": "任务名", "estimated_mins": 数字, "type": "study|review|practice"}],
  "difficulty_warnings": ["注意：XX 是高频难点，建议多留时间"],
  "resource_hints": ["推荐：XX 教材第N章 / XX 视频课"]
}"""


async def node(state: AgentState) -> dict:
    llm = ChatOpenAI(
        model=settings.smart_model_name,
        api_key=settings.smart_api_key,
        base_url=settings.smart_base_url or None,
        max_tokens=2048,
        streaming=True,
    )
    messages = [SystemMessage(content=_SYSTEM)] + list(state.get("messages", []))
    response = await llm.ainvoke(messages)

    structured = None
    try:
        content = response.content
        start, end = content.find("{"), content.rfind("}") + 1
        if start != -1 and end > start:
            structured = json.loads(content[start:end])
    except Exception as e:
        logger.warning("planner JSON parse failed: %s | raw: %.200s", e, response.content)
        # 返回错误提示消息，让前端能感知
        error_msg = AIMessage(content="抱歉，计划生成失败，请重新描述你的目标后再试。")
        return {"messages": [error_msg], "structured_output": None}

    return {"messages": [response], "structured_output": structured}
