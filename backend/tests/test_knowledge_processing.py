import pytest

from src.tasks.knowledge import (
    EMBEDDING_BATCH_SIZE,
    KnowledgeProcessingError,
    _embed_chunks,
    chunk_text,
    extract_text,
)


def test_extract_text_success():
    assert extract_text("学习资料".encode(), "txt") == "学习资料"


def test_extract_text_rejects_empty_content():
    with pytest.raises(KnowledgeProcessingError, match="未提取到文本"):
        extract_text(b"", "txt")


def test_extract_text_rejects_non_indexable_attachment():
    with pytest.raises(KnowledgeProcessingError, match="仅作为附件"):
        extract_text(b"image", "png")


def test_chunk_text_preserves_offsets_and_overlap():
    content = "第一段内容。" * 80 + "\n\n" + "第二段内容。" * 80
    chunks = chunk_text(content, target_chars=180, overlap_chars=30)

    assert len(chunks) > 2
    for index, (chunk, start, end) in enumerate(chunks):
        assert content[start:end] == chunk
        assert end > start
        if index:
            assert start < chunks[index - 1][2]


def test_chunk_text_rejects_invalid_parameters():
    with pytest.raises(ValueError, match="分块参数无效"):
        chunk_text("content", target_chars=100, overlap_chars=100)


async def test_embed_chunks_batches_and_preserves_order():
    class FakeEmbeddings:
        def __init__(self):
            self.batch_sizes = []

        async def create(self, *, model, input):
            self.batch_sizes.append(len(input))
            start = sum(self.batch_sizes[:-1])

            class Row:
                def __init__(self, value):
                    self.embedding = [float(value)] * 1536

            class Response:
                data = [Row(start + index) for index in range(len(input))]

            return Response()

    class FakeClient:
        embeddings = FakeEmbeddings()

    count = EMBEDDING_BATCH_SIZE + 3
    chunks = [(f"chunk-{index}", index, index + 1) for index in range(count)]
    result = await _embed_chunks([FakeClient()], "title", chunks)

    assert FakeClient.embeddings.batch_sizes == [EMBEDDING_BATCH_SIZE, 3]
    assert len(result) == count
    assert result[-1][0] == count - 1
