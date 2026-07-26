import asyncio
import csv
import io
import re
import uuid
from datetime import UTC, datetime

from src.celery_app import celery_app

MAX_EXTRACTED_CHARS = 50_000
TEXT_EXTENSIONS = {"txt", "md", "pdf", "docx", "csv", "xlsx"}
CHUNK_TARGET_CHARS = 1200
CHUNK_OVERLAP_CHARS = 200
EMBEDDING_BATCH_SIZE = 32


class KnowledgeProcessingError(RuntimeError):
    pass


def utc_now() -> datetime:
    """Return naive UTC for the project's existing timestamp columns."""
    return datetime.now(UTC).replace(tzinfo=None)


def chunk_text(
    content: str,
    target_chars: int = CHUNK_TARGET_CHARS,
    overlap_chars: int = CHUNK_OVERLAP_CHARS,
) -> list[tuple[str, int, int]]:
    """Split text near paragraph/sentence boundaries while retaining source offsets."""
    normalized = content.strip()
    if not normalized:
        return []
    if target_chars <= 0 or overlap_chars < 0 or overlap_chars >= target_chars:
        raise ValueError("分块参数无效")

    chunks: list[tuple[str, int, int]] = []
    start = 0
    length = len(normalized)
    boundary_pattern = re.compile(r"\n\s*\n|(?<=[。！？.!?])\s+|\n")

    while start < length:
        ideal_end = min(start + target_chars, length)
        end = ideal_end
        if ideal_end < length:
            search_start = min(start + target_chars // 2, ideal_end)
            matches = list(boundary_pattern.finditer(normalized, search_start, ideal_end))
            if matches:
                end = matches[-1].end()

        chunk_start = start
        chunk_end = end
        while chunk_start < chunk_end and normalized[chunk_start].isspace():
            chunk_start += 1
        while chunk_end > chunk_start and normalized[chunk_end - 1].isspace():
            chunk_end -= 1
        if chunk_start < chunk_end:
            chunks.append((normalized[chunk_start:chunk_end], chunk_start, chunk_end))

        if end >= length:
            break
        next_start = max(end - overlap_chars, start + 1)
        while next_start < end and normalized[next_start].isspace():
            next_start += 1
        start = next_start

    return chunks


async def _embed_chunks(
    clients: list,
    title: str,
    chunks: list[tuple[str, int, int]],
    model: str = "qwen3-embedding-0.6b",
    dimensions: int = 1024,
) -> list[list[float]]:
    last_error: Exception | None = None
    inputs = [f"{title}\n{chunk}" for chunk, _, _ in chunks]
    for client in clients:
        try:
            embeddings: list[list[float]] = []
            for offset in range(0, len(inputs), EMBEDDING_BATCH_SIZE):
                response = await client.embeddings.create(
                    model=model,
                    input=inputs[offset:offset + EMBEDDING_BATCH_SIZE],
                )
                batch = [row.embedding for row in response.data]
                if len(batch) != len(inputs[offset:offset + EMBEDDING_BATCH_SIZE]):
                    raise KnowledgeProcessingError("Embedding 返回数量与分块数量不一致")
                if any(len(vector) != dimensions for vector in batch):
                    raise KnowledgeProcessingError(
                        f"Embedding 维度错误：期望 {dimensions}"
                    )
                embeddings.extend(batch)
            return embeddings
        except Exception as exc:
            last_error = exc
    raise KnowledgeProcessingError("所有 Embedding 服务均调用失败") from last_error


def extract_text(raw: bytes, ext: str) -> str:
    """Extract bounded text and raise a useful error instead of silently succeeding."""
    try:
        if ext in {"txt", "md"}:
            content = raw.decode("utf-8", errors="replace")
        elif ext == "pdf":
            import pypdf

            reader = pypdf.PdfReader(io.BytesIO(raw))
            if reader.is_encrypted:
                raise KnowledgeProcessingError("PDF 已加密，无法解析")
            content = "\n".join(page.extract_text() or "" for page in reader.pages)
        elif ext == "docx":
            import docx

            document = docx.Document(io.BytesIO(raw))
            content = "\n".join(paragraph.text for paragraph in document.paragraphs)
        elif ext == "csv":
            reader = csv.reader(io.StringIO(raw.decode("utf-8", errors="replace")))
            content = "\n".join(",".join(row) for row in reader)
        elif ext == "xlsx":
            import openpyxl

            workbook = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
            lines: list[str] = []
            for worksheet in workbook.worksheets:
                for row in worksheet.iter_rows(values_only=True):
                    lines.append("\t".join("" if value is None else str(value) for value in row))
            content = "\n".join(lines)
        else:
            raise KnowledgeProcessingError("该文件仅作为附件保存，不需要建立索引")
    except KnowledgeProcessingError:
        raise
    except Exception as exc:
        raise KnowledgeProcessingError(f"文件解析失败：{type(exc).__name__}") from exc

    content = content.strip()
    if not content:
        raise KnowledgeProcessingError("未提取到文本；扫描版 PDF 请先进行 OCR")
    return content[:MAX_EXTRACTED_CHARS]


@celery_app.task(
    name="src.tasks.knowledge.process_knowledge_item",
    bind=True,
    max_retries=3,
    default_retry_delay=60,
)
def process_knowledge_item(self, item_id: str):
    try:
        asyncio.run(_process(item_id))
    except Exception as exc:
        if self.request.retries >= self.max_retries:
            asyncio.run(_mark_failed(item_id, exc, self.request.retries))
            raise
        asyncio.run(_mark_retry(item_id, exc, self.request.retries + 1))
        raise self.retry(exc=exc)


# Backwards-compatible task name for workers or queued messages from the previous version.
@celery_app.task(name="src.tasks.knowledge.vectorize_item")
def vectorize_item(item_id: str):
    process_knowledge_item.delay(item_id)


async def _process(item_id: str) -> None:
    from openai import AsyncOpenAI
    from sqlalchemy import delete, select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from src.config import settings
    from src.models import KnowledgeChunk, KnowledgeItem

    engine = create_async_engine(settings.database_url)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with session_factory() as db:
            item = (
                await db.execute(select(KnowledgeItem).where(KnowledgeItem.id == item_id))
            ).scalar_one_or_none()
            if not item:
                return

            item.processing_error = None
            ext = item.file_path.rsplit(".", 1)[-1].lower() if item.file_path and "." in item.file_path else ""

            if item.source_type == "url" and item.source_url:
                import httpx

                item.processing_status = "parsing"
                await db.commit()
                try:
                    async with httpx.AsyncClient(timeout=30) as client:
                        response = await client.get(
                            f"https://r.jina.ai/{item.source_url}",
                            headers={"Accept": "text/plain"},
                        )
                        response.raise_for_status()
                    item.content = response.text[:MAX_EXTRACTED_CHARS].strip()
                except httpx.HTTPError as exc:
                    raise KnowledgeProcessingError("网址内容抓取失败") from exc
                if not item.content:
                    raise KnowledgeProcessingError("页面内容为空，无法导入")
                item.content_length = len(item.content)
                for line in item.content.splitlines():
                    if line.strip():
                        item.title = line.strip()[:120]
                        break
            elif item.file_path and ext in TEXT_EXTENSIONS:
                item.processing_status = "parsing"
                await db.commit()
                try:
                    with open(item.file_path, "rb") as file_handle:
                        item.content = extract_text(file_handle.read(), ext)
                except FileNotFoundError as exc:
                    raise KnowledgeProcessingError("原始文件不存在") from exc
                item.content_length = len(item.content)
            elif not item.content:
                # Binary attachments are usable without semantic indexing.
                item.processing_status = "ready"
                item.processed_at = utc_now()
                await db.commit()
                return

            chunks = chunk_text(item.content)
            if not chunks:
                raise KnowledgeProcessingError("文档内容为空，无法分块")

            item.processing_status = "embedding"
            await db.execute(delete(KnowledgeChunk).where(KnowledgeChunk.item_id == item.id))
            await db.commit()

            clients = []
            if settings.embedding_base_url:
                clients.append(
                    AsyncOpenAI(
                        api_key=settings.embedding_api_key or "local",
                        base_url=settings.embedding_base_url,
                        timeout=settings.embedding_timeout_seconds,
                        max_retries=settings.embedding_max_retries,
                    )
                )
            if not clients:
                raise KnowledgeProcessingError("未配置可用的 Embedding 服务")

            embeddings = await _embed_chunks(
                clients,
                item.title,
                chunks,
                model=settings.embedding_model_name,
                dimensions=settings.embedding_dimensions,
            )
            for index, ((chunk, start_char, end_char), embedding) in enumerate(
                zip(chunks, embeddings, strict=True)
            ):
                db.add(KnowledgeChunk(
                    id=str(uuid.uuid4()),
                    item_id=item.id,
                    chunk_index=index,
                    content=chunk,
                    start_char=start_char,
                    end_char=end_char,
                    embedding=embedding,
                ))

            # Retain a document-level vector for backwards compatibility.
            item.embedding = embeddings[0]
            item.processing_status = "ready"
            item.processing_error = None
            item.processed_at = utc_now()
            await db.commit()
    finally:
        await engine.dispose()


async def _mark_retry(item_id: str, exc: Exception, retry_count: int) -> None:
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from src.config import settings
    from src.models import KnowledgeItem

    engine = create_async_engine(settings.database_url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            item = (
                await db.execute(select(KnowledgeItem).where(KnowledgeItem.id == item_id))
            ).scalar_one_or_none()
            if item:
                item.processing_status = "queued"
                item.processing_error = str(exc)[:500]
                item.retry_count = retry_count
                await db.commit()
    finally:
        await engine.dispose()


async def _mark_failed(item_id: str, exc: Exception, retry_count: int) -> None:
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from src.config import settings
    from src.models import KnowledgeItem

    engine = create_async_engine(settings.database_url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            item = (
                await db.execute(select(KnowledgeItem).where(KnowledgeItem.id == item_id))
            ).scalar_one_or_none()
            if item:
                item.processing_status = "failed"
                item.processing_error = str(exc)[:500]
                item.retry_count = retry_count
                await db.commit()
    finally:
        await engine.dispose()
