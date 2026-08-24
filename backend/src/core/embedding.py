"""统一的 OpenAI-compatible Embedding 客户端与查询入口。"""

import asyncio
from functools import lru_cache

from openai import AsyncOpenAI

from src.config import settings


class EmbeddingUnavailableError(RuntimeError):
    """Embedding 未配置、不可用或返回内容不符合契约。"""


_embedding_semaphore = asyncio.Semaphore(settings.embedding_max_concurrency)


@lru_cache(maxsize=1)
def get_embedding_client() -> AsyncOpenAI | None:
    """只使用独立 Embedding 配置，避免误把生成模型端点当成向量服务。"""
    if not settings.embedding_base_url:
        return None
    return AsyncOpenAI(
        api_key=settings.embedding_api_key or "local",
        base_url=settings.embedding_base_url,
        timeout=settings.embedding_timeout_seconds,
        max_retries=settings.embedding_max_retries,
    )


async def embed_text(text: str) -> list[float]:
    client = get_embedding_client()
    if client is None:
        raise EmbeddingUnavailableError("未配置独立 Embedding 服务")

    async with _embedding_semaphore:
        response = await client.embeddings.create(
            model=settings.embedding_model_name,
            input=text,
        )
    if not response.data:
        raise EmbeddingUnavailableError("Embedding 服务返回空结果")
    vector = response.data[0].embedding
    if len(vector) != settings.embedding_dimensions:
        raise EmbeddingUnavailableError(
            f"Embedding 维度错误：期望 {settings.embedding_dimensions}，实际 {len(vector)}"
        )
    return vector
