from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.core.embedding import EmbeddingUnavailableError, embed_text, get_embedding_client


@pytest.fixture(autouse=True)
def clear_embedding_client():
    get_embedding_client.cache_clear()
    yield
    get_embedding_client.cache_clear()


@pytest.mark.asyncio
async def test_embed_text_uses_dedicated_embedding_configuration():
    client = MagicMock()
    client.embeddings.create = AsyncMock(
        return_value=SimpleNamespace(
            data=[SimpleNamespace(embedding=[0.1] * 1024)]
        )
    )
    with patch("src.core.embedding.get_embedding_client", return_value=client):
        result = await embed_text("测试")

    assert len(result) == 1024
    client.embeddings.create.assert_awaited_once()


@pytest.mark.asyncio
async def test_embed_text_rejects_wrong_dimension():
    client = MagicMock()
    client.embeddings.create = AsyncMock(
        return_value=SimpleNamespace(data=[SimpleNamespace(embedding=[0.1] * 8)])
    )
    with patch("src.core.embedding.get_embedding_client", return_value=client):
        with pytest.raises(EmbeddingUnavailableError, match="维度错误"):
            await embed_text("测试")
