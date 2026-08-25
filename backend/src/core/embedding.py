"""统一的 OpenAI-compatible Embedding 客户端与查询入口。"""

import asyncio
from functools import lru_cache

from openai import AsyncOpenAI

from src.config import settings
from src.services.runtime_model_config import get_runtime_model_config


class EmbeddingUnavailableError(RuntimeError):
    """Embedding 未配置、不可用或返回内容不符合契约。"""


_embedding_semaphore = asyncio.Semaphore(settings.embedding_max_concurrency)


@lru_cache(maxsize=8)
def _embedding_client(base_url: str, api_key: str) -> AsyncOpenAI:
    return AsyncOpenAI(
        api_key=api_key or "local",
        base_url=base_url,
        timeout=settings.embedding_timeout_seconds,
        max_retries=settings.embedding_max_retries,
    )


def get_embedding_client() -> AsyncOpenAI | None:
    """只使用独立 Embedding 配置，避免误把生成模型端点当成向量服务。"""
    runtime = get_runtime_model_config()
    if not runtime.embedding_enabled or not runtime.embedding_base_url:
        return None
    return _embedding_client(runtime.embedding_base_url, runtime.embedding_api_key)


# Preserve the public cache-reset hook used by tests and operational reloads.
get_embedding_client.cache_clear = _embedding_client.cache_clear  # type: ignore[attr-defined]


async def embed_text(text: str) -> list[float]:
    runtime = get_runtime_model_config()
    client = get_embedding_client()
    if client is None:
        raise EmbeddingUnavailableError("未配置独立 Embedding 服务")

    async with _embedding_semaphore:
        response = await client.embeddings.create(
            model=runtime.embedding_model_name,
            input=text,
        )
    if not response.data:
        raise EmbeddingUnavailableError("Embedding 服务返回空结果")
    vector = response.data[0].embedding
    if len(vector) != runtime.embedding_dimensions:
        raise EmbeddingUnavailableError(
            f"Embedding 维度错误：期望 {runtime.embedding_dimensions}，实际 {len(vector)}"
        )
    return vector
