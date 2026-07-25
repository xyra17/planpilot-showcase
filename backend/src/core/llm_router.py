"""PlanPilot 的生成模型路由。

日常任务优先使用本地 MLX 模型，调用失败时自动回退 DeepSeek Flash；
复杂重规划与最终审核显式使用 DeepSeek Pro。
"""

from collections.abc import Sequence
from typing import Any

from langchain_openai import ChatOpenAI

from src.config import settings


def _local_llm(**kwargs: Any) -> ChatOpenAI:
    return ChatOpenAI(
        model=settings.model_name,
        api_key=settings.openai_api_key or "local",
        base_url=settings.openai_base_url or None,
        timeout=settings.local_model_timeout_seconds,
        max_retries=0,
        extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        **kwargs,
    )


def _flash_llm(**kwargs: Any) -> ChatOpenAI:
    return ChatOpenAI(
        model=settings.smart_model_name,
        api_key=settings.smart_api_key,
        base_url=settings.smart_base_url or None,
        **kwargs,
    )


def create_routine_llm(*, tools: Sequence[Any] | None = None, **kwargs: Any) -> Any:
    """创建“本地优先、Flash 回退”的日常任务模型。"""
    candidates: list[Any] = []
    if settings.local_model_enabled and settings.openai_base_url:
        candidates.append(_local_llm(**kwargs))
    if settings.smart_api_key and settings.smart_model_name:
        candidates.append(_flash_llm(**kwargs))
    if not candidates:
        raise RuntimeError("没有可用的日常模型：请配置本地模型或 DeepSeek Flash")

    if tools:
        candidates = [candidate.bind_tools(tools) for candidate in candidates]

    primary, *fallbacks = candidates
    return primary.with_fallbacks(fallbacks) if fallbacks else primary


def create_pro_llm(**kwargs: Any) -> ChatOpenAI:
    """创建仅用于复杂重规划和最终质量审核的 DeepSeek Pro。"""
    if not settings.smart_api_key or not settings.smart_pro_model_name:
        raise RuntimeError("DeepSeek Pro 未配置")
    return ChatOpenAI(
        model=settings.smart_pro_model_name,
        api_key=settings.smart_api_key,
        base_url=settings.smart_base_url or None,
        **kwargs,
    )
