from src.core.agent.state import AgentState


def pilo_preference_context(state: AgentState) -> str:
    preferences = state.get("pilo_preferences") or {}

    tone = {
        "warm": "温暖、具体，不空泛鼓励",
        "direct": "直接给结论和下一步",
        "socratic": "先用一两个具体问题启发，再给建议",
    }.get(preferences.get("tone"), "清晰、友好")

    initiative = {
        "quiet": "只答当前问题",
        "balanced": "必要时补一个轻量下一步",
        "proactive": "补一个具体跟进动作及原因",
    }.get(preferences.get("initiative"), "必要时补一个轻量下一步")

    detail = {
        "brief": "2-4 句，只留结论和下一步",
        "balanced": "简短说明结论、依据和下一步",
        "deep": "说明依据、取舍和备选方案，避免重复",
    }.get(preferences.get("detail"), "简短说明结论和下一步")

    celebration = "具体肯定真实进展" if preferences.get("celebrateProgress", True) else "不主动庆祝"

    return (
        f"\n【回答偏好】语气：{tone}；主动性：{initiative}；篇幅：{detail}；进展：{celebration}。"
    )
