import pytest

from src.tasks.knowledge import KnowledgeProcessingError, extract_text


def test_extract_text_success():
    assert extract_text("学习资料".encode(), "txt") == "学习资料"


def test_extract_text_rejects_empty_content():
    with pytest.raises(KnowledgeProcessingError, match="未提取到文本"):
        extract_text(b"", "txt")


def test_extract_text_rejects_non_indexable_attachment():
    with pytest.raises(KnowledgeProcessingError, match="仅作为附件"):
        extract_text(b"image", "png")
