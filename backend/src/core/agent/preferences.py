from src.core.agent.state import AgentState


def pilo_preference_context(state: AgentState) -> str:
    preferences = state.get("pilo_preferences") or {}

    tone = {
        "warm": "先表达理解，再清晰地给出建议；语气温暖、平和，不说空泛的鼓励。",
        "direct": "直截了当地指出关键问题和下一步，减少寒暄，但保持尊重。",
        "socratic": "优先用一到两个具体问题帮助用户形成判断，再补充必要建议。",
    }.get(preferences.get("tone"), "先理解用户，再清晰给出建议。")

    initiative = {
        "quiet": "只回答当前问题，不额外推动新行动或追问。",
        "balanced": "发现明确风险或机会时，可以提出一个轻量的下一步。",
        "proactive": "在回答后主动提出一个具体跟进动作，并说明为什么值得现在做。",
    }.get(preferences.get("initiative"), "必要时提出一个轻量的下一步。")

    detail = {
        "brief": "默认控制在 2-4 句，只保留结论和下一步。",
        "balanced": "默认使用简短段落，解释结论、依据和下一步。",
        "deep": "可以更深入地解释依据、取舍和备选方案，但避免重复。",
    }.get(preferences.get("detail"), "默认使用简短段落回答。")

    celebration = (
        "当用户确实取得进展时，可以具体指出进步在哪里。"
        if preferences.get("celebrateProgress", True)
        else "不要主动庆祝或夸奖，只客观确认进展。"
    )

    return (
        "\n\n【Pilo 陪伴偏好】\n"
        f"- 对话语气：{tone}\n"
        f"- 主动程度：{initiative}\n"
        f"- 信息密度：{detail}\n"
        f"- 进展回应：{celebration}\n"
        "偏好不能覆盖健康、安全、隐私和用户确认边界。"
    )
