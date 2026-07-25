"""模型输出的确定性质量约束。"""

import re


def compact_text(text: str, max_chars: int) -> str:
    """移除常见 Markdown 装饰，并把界面短文本限制在指定长度。"""
    normalized = re.sub(r"[*_`#>]", "", text).strip()
    normalized = re.sub(r"\s+", " ", normalized)
    if len(normalized) <= max_chars:
        return normalized

    sentence_end = -1
    for marker in ("。", "！", "？", "；"):
        pos = normalized.find(marker)
        if 0 <= pos < max_chars:
            sentence_end = max(sentence_end, pos)
    if sentence_end >= 0:
        return normalized[: sentence_end + 1]
    return normalized[: max_chars - 1].rstrip("，,；;：: ") + "…"


def enforce_chinese_only(text: str) -> str:
    """用于明确“只用中文”契约，移除模型偶发夹带的拉丁字母单词。"""
    normalized = re.sub(r"[A-Za-z]+", "", text)
    normalized = re.sub(r"[ \t]+", " ", normalized)
    normalized = re.sub(r" *\n *", "\n", normalized)
    return normalized.strip()


def ensure_nonempty_text(text: str, fallback: str) -> str:
    """避免推理 token 耗尽或安全阻断造成前端空白消息。"""
    return text if text.strip() else fallback
