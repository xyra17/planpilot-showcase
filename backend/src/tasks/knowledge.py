import asyncio
import csv
import io
from datetime import datetime

from src.celery_app import celery_app

MAX_EXTRACTED_CHARS = 50_000
TEXT_EXTENSIONS = {"txt", "md", "pdf", "docx", "csv", "xlsx"}


class KnowledgeProcessingError(RuntimeError):
    pass


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
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from src.config import settings
    from src.models import KnowledgeItem

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
                item.processed_at = datetime.utcnow()
                await db.commit()
                return

            item.processing_status = "embedding"
            await db.commit()

            clients = []
            if settings.openai_base_url:
                clients.append(
                    AsyncOpenAI(
                        api_key=settings.openai_api_key or "local",
                        base_url=settings.openai_base_url,
                    )
                )
            if settings.smart_api_key:
                clients.append(
                    AsyncOpenAI(
                        api_key=settings.smart_api_key,
                        base_url=settings.smart_base_url or None,
                    )
                )
            if not clients:
                raise KnowledgeProcessingError("未配置可用的 Embedding 服务")

            last_error: Exception | None = None
            text = (item.title + "\n" + item.content)[:8000]
            for client in clients:
                try:
                    response = await client.embeddings.create(
                        model="text-embedding-3-small",
                        input=text,
                    )
                    embedding = response.data[0].embedding
                    if len(embedding) != 1536:
                        raise KnowledgeProcessingError(
                            f"Embedding 维度错误：期望 1536，实际 {len(embedding)}"
                        )
                    item.embedding = embedding
                    item.processing_status = "ready"
                    item.processing_error = None
                    item.processed_at = datetime.utcnow()
                    await db.commit()
                    return
                except Exception as exc:
                    last_error = exc

            raise KnowledgeProcessingError("所有 Embedding 服务均调用失败") from last_error
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
