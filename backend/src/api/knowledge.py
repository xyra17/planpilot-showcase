import os
import uuid
from datetime import UTC, datetime
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import Goal, KnowledgeBase, KnowledgeChunk, KnowledgeItem, Task, User

router = APIRouter(prefix="/api/v1/knowledge", tags=["knowledge"])

UPLOAD_DIR = "uploads"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
INDEXABLE_EXTENSIONS = {"txt", "md", "pdf", "docx", "csv", "xlsx"}
ATTACHMENT_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}
ALLOWED_EXTENSIONS = INDEXABLE_EXTENSIONS | ATTACHMENT_EXTENSIONS
MIME_TYPES = {
    "txt": {"text/plain"},
    "md": {"text/plain", "text/markdown"},
    "pdf": {"application/pdf"},
    "docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    "csv": {"text/csv", "application/csv", "text/plain"},
    "xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
    "png": {"image/png"},
    "jpg": {"image/jpeg"},
    "jpeg": {"image/jpeg"},
    "gif": {"image/gif"},
    "webp": {"image/webp"},
}


# ── Output schemas ────────────────────────────────────────────

class KnowledgeFileOut(BaseModel):
    id: str
    name: str
    size: str
    uploadDate: str
    type: str
    goalIds: list[str]
    kbId: str
    taskId: str
    status: str
    error: str | None
    retryCount: int
    contentLength: int


class KnowledgeBaseOut(BaseModel):
    id: str
    name: str
    description: str
    item_count: int
    created_at: str


class KnowledgeBaseCreate(BaseModel):
    name: str
    description: str = ""


class SearchResultOut(BaseModel):
    id: str
    title: str
    snippet: str
    score: float
    goal_id: str | None
    kb_id: str | None
    source_type: str
    source_url: str | None
    chunk_index: int | None = None
    start_char: int | None = None
    end_char: int | None = None
    citation: str


class SearchEvaluationCase(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    expected_item_ids: list[str] = Field(min_length=1)


class SearchEvaluationRequest(BaseModel):
    cases: list[SearchEvaluationCase] = Field(min_length=1, max_length=100)
    limit: int = Field(default=5, ge=1, le=20)
    goal_id: str | None = None


class ReindexResult(BaseModel):
    queued: int
    item_ids: list[str]


_NOTE_TYPES = {"chat_note", "daily_log", "flash_card", "task_note"}


class NoteOut(BaseModel):
    id: str
    goalId: str
    goalTitle: str
    taskId: str | None
    taskTitle: str
    taskAvailable: bool
    title: str
    content: str
    noteType: str
    date: str
    savedAt: str
    createdAt: str
    updatedAt: str
    attachmentIds: list[str] = []


class NoteCreate(BaseModel):
    goalId: str | None = None
    taskId: str | None = None
    title: str | None = None
    content: str = ""
    noteType: str = "flash_card"
    kb_id: str | None = None
    noteDate: str | None = None

    @field_validator("noteDate")
    @classmethod
    def validate_note_date(cls, v: str | None) -> str | None:
        if v is None:
            return v
        try:
            datetime.strptime(v, "%Y-%m-%d")
        except ValueError:
            raise ValueError("noteDate must be in YYYY-MM-DD format")
        return v


class NoteUpdate(BaseModel):
    title: str | None = None
    content: str | None = None
    goalId: str | None = None
    taskId: str | None = None


# ── Helpers ───────────────────────────────────────────────────

def _size_str(content: str, file_path: str | None) -> str:
    sz = os.path.getsize(file_path) if file_path and os.path.exists(file_path) else len(content.encode())
    return f"{sz / 1024 / 1024:.1f} MB" if sz >= 1024 * 1024 else f"{max(1, sz // 1024)} KB"


def _file_type(source_type: str, file_path: str | None) -> str:
    if file_path:
        ext = file_path.rsplit(".", 1)[-1].lower()
        if ext in ("xlsx", "xls", "csv"):
            return "excel"
        if ext in ("pdf", "docx", "doc", "txt", "md"):
            return ext
    return source_type


def _to_file_out(item: KnowledgeItem) -> KnowledgeFileOut:
    return KnowledgeFileOut(
        id=item.id,
        name=item.title,
        size=_size_str(item.content, item.file_path),
        uploadDate=item.created_at.strftime("%Y-%m-%d") if item.created_at else "",
        type=_file_type(item.source_type, item.file_path),
        goalIds=[item.goal_id] if item.goal_id else [],
        kbId=item.kb_id or "",
        taskId=item.task_id or "",
        status=item.processing_status,
        error=item.processing_error,
        retryCount=item.retry_count,
        contentLength=item.content_length,
    )


def _keyword_score(content: str, query: str) -> float:
    """简单关键词相关性打分（0-1），不依赖 pgvector。"""
    words = query.lower().split()
    content_lower = content.lower()
    hits = sum(1 for w in words if w in content_lower)
    return hits / max(len(words), 1)


# 模块级嵌入客户端单例，避免每次请求重建连接
_embed_clients: list | None = None


def _get_embed_clients() -> list:
    global _embed_clients
    if _embed_clients is None:
        from openai import AsyncOpenAI

        from src.config import settings
        _embed_clients = []
        if settings.embedding_api_key and settings.embedding_base_url:
            _embed_clients.append(
                AsyncOpenAI(
                    api_key=settings.embedding_api_key,
                    base_url=settings.embedding_base_url,
                )
            )
        elif settings.openai_base_url:
            _embed_clients.append(
                AsyncOpenAI(
                    api_key=settings.openai_api_key or "local",
                    base_url=settings.openai_base_url,
                )
            )
    return _embed_clients


def _kb_to_out(kb: KnowledgeBase, item_count: int) -> KnowledgeBaseOut:
    return KnowledgeBaseOut(
        id=kb.id,
        name=kb.name,
        description=kb.description,
        item_count=item_count,
        created_at=kb.created_at.strftime("%Y-%m-%d") if kb.created_at else "",
    )


async def _kb_item_count(kb_id: str, db: AsyncSession) -> int:
    return (await db.execute(
        select(func.count()).select_from(KnowledgeItem).where(KnowledgeItem.kb_id == kb_id)
    )).scalar_one()


async def _get_kb(kb_id: str, user_id: str, db: AsyncSession) -> KnowledgeBase:
    kb = (await db.execute(
        select(KnowledgeBase).where(KnowledgeBase.id == kb_id, KnowledgeBase.user_id == user_id)
    )).scalar_one_or_none()
    if not kb:
        raise HTTPException(404, "知识库不存在")
    return kb


async def _get_user_goal(goal_id: str, user_id: str, db: AsyncSession) -> Goal:
    goal = (await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id)
    )).scalar_one_or_none()
    if not goal:
        raise HTTPException(404, "目标不存在")
    return goal


async def _get_user_task(task_id: str, user_id: str, db: AsyncSession) -> Task:
    task = (await db.execute(
        select(Task)
        .join(Goal, Goal.id == Task.goal_id)
        .where(Task.id == task_id, Goal.user_id == user_id)
    )).scalar_one_or_none()
    if not task:
        raise HTTPException(404, "任务不存在")
    return task


def _dispatch_processing(item: KnowledgeItem) -> None:
    from src.tasks.knowledge import process_knowledge_item

    try:
        process_knowledge_item.apply_async(args=[item.id], countdown=2)
    except Exception as exc:
        # The row has already been committed. Preserve it and expose a retryable state.
        item.processing_status = "failed"
        item.processing_error = f"处理任务派发失败：{type(exc).__name__}"[:500]


@router.post("/reindex", response_model=ReindexResult)
async def reindex_legacy_items(
    limit: int = 100,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ReindexResult:
    """Queue legacy ready documents that do not have chunk-level indexes."""
    safe_limit = max(1, min(limit, 500))
    items = (await db.execute(
        select(KnowledgeItem)
        .where(
            KnowledgeItem.user_id == current_user.id,
            KnowledgeItem.processing_status == "ready",
            KnowledgeItem.source_type.in_({"upload", "url"}),
            ~KnowledgeItem.chunks.any(),
        )
        .order_by(KnowledgeItem.created_at.asc())
        .limit(safe_limit)
    )).scalars().all()

    for item in items:
        item.processing_status = "queued"
        item.processing_error = None
        item.retry_count = 0
    await db.commit()

    for item in items:
        _dispatch_processing(item)
    await db.commit()
    queued_items = [item for item in items if item.processing_status == "queued"]
    return ReindexResult(
        queued=len(queued_items),
        item_ids=[item.id for item in queued_items],
    )


def _utc_iso(value: datetime | None) -> str:
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _note_to_out(
    item: KnowledgeItem,
    goal_title: str,
    attachment_ids: list[str] | None = None,
    task_title: str = "",
    task_available: bool = False,
) -> NoteOut:
    created_at = _utc_iso(item.created_at)
    updated_at = _utc_iso(item.updated_at or item.created_at)
    return NoteOut(
        id=item.id,
        goalId=item.goal_id or "",
        goalTitle=goal_title,
        taskId=item.task_id or None,
        taskTitle=task_title or item.task_title_snapshot or "",
        taskAvailable=task_available,
        title=item.title or "",
        content=item.content,
        noteType=item.source_type,
        date=item.note_date or (item.created_at.strftime("%Y-%m-%d") if item.created_at else ""),
        savedAt=updated_at,
        createdAt=created_at,
        updatedAt=updated_at,
        attachmentIds=attachment_ids or [],
    )


async def _get_note(note_id: str, user_id: str, db: AsyncSession) -> KnowledgeItem:
    item = (await db.execute(
        select(KnowledgeItem).where(
            KnowledgeItem.id == note_id,
            KnowledgeItem.user_id == user_id,
            KnowledgeItem.source_type.in_(_NOTE_TYPES),
        )
    )).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "笔记不存在")
    return item


# ── Files ────────────────────────────────────────────────────

@router.get("/files")
async def list_files(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    items = (await db.execute(
        select(KnowledgeItem)
        .where(
            KnowledgeItem.user_id == current_user.id,
            KnowledgeItem.source_type.not_in(_NOTE_TYPES),
            KnowledgeItem.note_id.is_(None),
        )
        .order_by(KnowledgeItem.created_at.desc())
    )).scalars().all()
    return {"items": [_to_file_out(i) for i in items]}


@router.post("/upload", response_model=KnowledgeFileOut)
async def upload_file(
    file: UploadFile = File(...),
    kb_id: str | None = Form(None),
    goal_ids: list[str] = Form(default=[]),
    task_id: str | None = Form(None),
    note_id: str | None = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeFileOut:
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    filename = file.filename or "untitled"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(415, f"不支持的文件类型：.{ext}")
    content_type = (file.content_type or "").lower()
    if (
        content_type
        and content_type != "application/octet-stream"
        and content_type not in MIME_TYPES[ext]
    ):
        raise HTTPException(415, "文件扩展名与内容类型不匹配")

    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if not raw:
        raise HTTPException(400, "文件为空")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "文件不能超过 20 MB")
    if ext == "pdf" and not raw.startswith(b"%PDF"):
        raise HTTPException(415, "PDF 文件签名无效")
    if ext in {"docx", "xlsx"} and not raw.startswith(b"PK"):
        raise HTTPException(415, "Office 文件签名无效")

    goal_id = goal_ids[0] if goal_ids else None
    if len(goal_ids) > 1:
        raise HTTPException(422, "当前一个文件只能关联一个目标")
    if goal_id:
        await _get_user_goal(goal_id, current_user.id, db)
    if task_id:
        task = await _get_user_task(task_id, current_user.id, db)
        if goal_id and task.goal_id != goal_id:
            raise HTTPException(422, "任务不属于所选目标")
        goal_id = goal_id or task.goal_id
    if note_id:
        await _get_note(note_id, current_user.id, db)
    if kb_id:
        await _get_kb(kb_id, current_user.id, db)

    saved_path = os.path.join(UPLOAD_DIR, f"{uuid.uuid4()}.{ext}")
    try:
        with open(saved_path, "wb") as f:
            f.write(raw)
    except OSError as exc:
        raise HTTPException(500, "文件保存失败") from exc

    item = KnowledgeItem(
        id=str(uuid.uuid4()),
        user_id=current_user.id,
        goal_id=goal_id,
        kb_id=kb_id,
        task_id=task_id,
        note_id=note_id,
        title=filename,
        content="",
        source_type="upload",
        file_path=saved_path,
        processing_status="queued" if ext in INDEXABLE_EXTENSIONS else "ready",
        processed_at=(
            datetime.now(UTC).replace(tzinfo=None)
            if ext in ATTACHMENT_EXTENSIONS
            else None
        ),
    )
    try:
        db.add(item)
        await db.commit()
        await db.refresh(item)
    except Exception:
        try:
            os.remove(saved_path)
        except FileNotFoundError:
            pass
        raise
    if ext in INDEXABLE_EXTENSIONS:
        _dispatch_processing(item)
        if item.processing_status == "failed":
            await db.commit()

    return _to_file_out(item)


@router.post("/{item_id}/retry", response_model=KnowledgeFileOut)
async def retry_processing(
    item_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeFileOut:
    item = (await db.execute(
        select(KnowledgeItem).where(
            KnowledgeItem.id == item_id,
            KnowledgeItem.user_id == current_user.id,
        )
    )).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "文件不存在")
    if item.processing_status not in {"failed", "uploaded"}:
        raise HTTPException(409, "该文件当前不需要重试")
    item.processing_status = "queued"
    item.processing_error = None
    item.retry_count = 0
    await db.commit()
    _dispatch_processing(item)
    await db.commit()
    await db.refresh(item)
    return _to_file_out(item)


@router.delete("/{item_id}", status_code=204)
async def delete_item(
    item_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    item = (await db.execute(
        select(KnowledgeItem).where(
            KnowledgeItem.id == item_id,
            KnowledgeItem.user_id == current_user.id,
        )
    )).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "文件不存在")
    if item.file_path:
        try:
            os.remove(item.file_path)
        except FileNotFoundError:
            pass
    # 级联删除该笔记的专属附件
    attachments = (await db.execute(
        select(KnowledgeItem).where(KnowledgeItem.note_id == item_id)
    )).scalars().all()
    for att in attachments:
        if att.file_path:
            try:
                os.remove(att.file_path)
            except FileNotFoundError:
                pass
        await db.delete(att)
    await db.delete(item)
    await db.commit()


@router.get("/files/{file_id}/serve")
async def serve_file(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    item = (await db.execute(
        select(KnowledgeItem).where(
            KnowledgeItem.id == file_id,
            KnowledgeItem.user_id == current_user.id,
        )
    )).scalar_one_or_none()
    if not item or not item.file_path or not os.path.exists(item.file_path):
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(item.file_path, filename=item.title)


# ── Knowledge Bases ───────────────────────────────────────────

@router.get("/kbs")
async def list_kbs(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    rows = (await db.execute(
        select(KnowledgeBase, func.count(KnowledgeItem.id).label("cnt"))
        .outerjoin(KnowledgeItem, KnowledgeItem.kb_id == KnowledgeBase.id)
        .where(KnowledgeBase.user_id == current_user.id)
        .group_by(KnowledgeBase.id)
        .order_by(KnowledgeBase.created_at.desc())
    )).all()
    return {"items": [_kb_to_out(kb, cnt) for kb, cnt in rows]}


@router.post("/kbs", status_code=201)
async def create_kb(
    body: KnowledgeBaseCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeBaseOut:
    kb = KnowledgeBase(
        id=str(uuid.uuid4()),
        user_id=current_user.id,
        name=body.name,
        description=body.description,
    )
    db.add(kb)
    await db.commit()
    await db.refresh(kb)
    return _kb_to_out(kb, 0)


@router.get("/kbs/{kb_id}", response_model=KnowledgeBaseOut)
async def get_kb(
    kb_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeBaseOut:
    kb = await _get_kb(kb_id, current_user.id, db)
    return _kb_to_out(kb, await _kb_item_count(kb_id, db))


class KnowledgeBaseUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


@router.patch("/kbs/{kb_id}", response_model=KnowledgeBaseOut)
async def update_kb(
    kb_id: str,
    body: KnowledgeBaseUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeBaseOut:
    kb = await _get_kb(kb_id, current_user.id, db)
    if body.name is not None:
        kb.name = body.name
    if body.description is not None:
        kb.description = body.description
    await db.commit()
    await db.refresh(kb)
    return _kb_to_out(kb, await _kb_item_count(kb_id, db))


@router.delete("/kbs/{kb_id}", status_code=204)
async def delete_kb(
    kb_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    kb = (await db.execute(
        select(KnowledgeBase).where(KnowledgeBase.id == kb_id, KnowledgeBase.user_id == current_user.id)
    )).scalar_one_or_none()
    if not kb:
        raise HTTPException(404, "知识库不存在")
    # 解除关联的 items（不删除文件，只解除 kb_id）
    items = (await db.execute(
        select(KnowledgeItem).where(KnowledgeItem.kb_id == kb_id)
    )).scalars().all()
    for item in items:
        item.kb_id = None
    await db.delete(kb)
    await db.commit()


@router.post("/kbs/{kb_id}/items/{item_id}", status_code=200)
async def add_item_to_kb(
    kb_id: str,
    item_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _get_kb(kb_id, current_user.id, db)
    item = (await db.execute(
        select(KnowledgeItem).where(KnowledgeItem.id == item_id, KnowledgeItem.user_id == current_user.id)
    )).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "文件不存在")
    item.kb_id = kb_id
    await db.commit()
    return {"status": "ok"}


# ── Search ─────────────────────────────────────────────────────

@router.get("/search", response_model=list[SearchResultOut])
async def search_knowledge(
    q: str,
    goal_id: str | None = None,
    limit: int = 5,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[SearchResultOut]:
    if not q.strip():
        return []

    # 尝试语义向量搜索
    try:
        from pgvector.sqlalchemy import Vector
        from sqlalchemy import cast
        from sqlalchemy import text as sa_text

        query_vec = None
        for _client in _get_embed_clients():
            try:
                from src.config import settings

                resp = await _client.embeddings.create(
                    model=settings.embedding_model_name,
                    input=q[:2000],
                )
                query_vec = resp.data[0].embedding
                break
            except Exception:
                continue

        if query_vec:
            chunk_stmt = (
                select(
                    KnowledgeChunk,
                    KnowledgeItem,
                    (
                        1
                        - KnowledgeChunk.embedding.cosine_distance(
                            cast(query_vec, Vector(1024))
                        )
                    ).label("score"),
                )
                .join(KnowledgeItem, KnowledgeItem.id == KnowledgeChunk.item_id)
                .where(
                    KnowledgeItem.user_id == current_user.id,
                    KnowledgeItem.processing_status == "ready",
                    KnowledgeChunk.embedding.is_not(None),
                )
            )
            if goal_id:
                chunk_stmt = chunk_stmt.where(KnowledgeItem.goal_id == goal_id)
            chunk_stmt = chunk_stmt.order_by(sa_text("score DESC")).limit(limit)

            chunk_rows = (await db.execute(chunk_stmt)).all()
            chunk_results = []
            for chunk, item, score in chunk_rows:
                if float(score) < 0.3:
                    continue
                chunk_results.append(SearchResultOut(
                    id=item.id,
                    title=item.title,
                    snippet=chunk.content[:300].strip(),
                    score=round(float(score), 3),
                    goal_id=item.goal_id,
                    kb_id=item.kb_id,
                    source_type=item.source_type,
                    source_url=item.source_url,
                    chunk_index=chunk.chunk_index,
                    start_char=chunk.start_char,
                    end_char=chunk.end_char,
                    citation=f"{item.title} · 第 {chunk.chunk_index + 1} 段",
                ))
            if chunk_results:
                return chunk_results

            # Backwards compatibility for records not yet re-indexed into chunks.
            stmt = (
                select(
                    KnowledgeItem,
                    (
                        1
                        - KnowledgeItem.embedding.cosine_distance(
                            cast(query_vec, Vector(1024))
                        )
                    ).label("score"),
                )
                .where(
                    KnowledgeItem.user_id == current_user.id,
                    KnowledgeItem.embedding.is_not(None),
                    KnowledgeItem.processing_status == "ready",
                )
            )
            if goal_id:
                stmt = stmt.where(KnowledgeItem.goal_id == goal_id)
            stmt = stmt.order_by(sa_text("score DESC")).limit(limit)

            rows = (await db.execute(stmt)).all()
            # 过滤低相关度结果（得分 < 0.3 视为不相关）
            results = []
            for item, score in rows:
                if float(score) < 0.3:
                    continue
                idx = item.content.lower().find(q.lower().split()[0])
                start = max(0, idx - 50) if idx >= 0 else 0
                snippet = item.content[start:start + 200].strip()
                results.append(SearchResultOut(
                    id=item.id,
                    title=item.title,
                    snippet=snippet,
                    score=round(float(score), 3),
                    goal_id=item.goal_id,
                    kb_id=item.kb_id,
                    source_type=item.source_type,
                    source_url=item.source_url,
                    citation=item.title,
                ))
            if results:
                return results
    except Exception:
        pass

    # 降级：SQL ILIKE（比 Python 全扫描快，利用数据库索引）
    from sqlalchemy import or_

    q_safe = q.replace("%", r"\%").replace("_", r"\_")
    chunk_filter = KnowledgeChunk.content.ilike(f"%{q_safe}%")
    chunk_stmt = (
        select(KnowledgeChunk, KnowledgeItem)
        .join(KnowledgeItem, KnowledgeItem.id == KnowledgeChunk.item_id)
        .where(
            KnowledgeItem.user_id == current_user.id,
            KnowledgeItem.processing_status == "ready",
            chunk_filter,
        )
    )
    if goal_id:
        chunk_stmt = chunk_stmt.where(KnowledgeItem.goal_id == goal_id)
    chunk_rows = (await db.execute(chunk_stmt.limit(limit * 3))).all()
    chunk_scored = []
    for chunk, item in chunk_rows:
        score = _keyword_score(item.title + " " + chunk.content, q)
        chunk_scored.append(SearchResultOut(
            id=item.id,
            title=item.title,
            snippet=chunk.content[:300].strip(),
            score=round(score, 3),
            goal_id=item.goal_id,
            kb_id=item.kb_id,
            source_type=item.source_type,
            source_url=item.source_url,
            chunk_index=chunk.chunk_index,
            start_char=chunk.start_char,
            end_char=chunk.end_char,
            citation=f"{item.title} · 第 {chunk.chunk_index + 1} 段",
        ))
    if chunk_scored:
        chunk_scored.sort(key=lambda result: result.score, reverse=True)
        return chunk_scored[:limit]

    item_filter = or_(
        KnowledgeItem.title.ilike(f"%{q_safe}%"),
        KnowledgeItem.content.ilike(f"%{q_safe}%"),
    )
    stmt = (
        select(KnowledgeItem)
        .where(
            KnowledgeItem.user_id == current_user.id,
            KnowledgeItem.processing_status == "ready",
            item_filter,
        )
    )
    if goal_id:
        stmt = stmt.where(KnowledgeItem.goal_id == goal_id)
    stmt = stmt.limit(limit * 3)
    items = (await db.execute(stmt)).scalars().all()

    scored = []
    for item in items:
        score = _keyword_score(item.title + " " + item.content[:2000], q)
        idx = (item.title + " " + item.content).lower().find(q.lower().split()[0])
        start = max(0, idx - 50) if idx >= 0 else 0
        snippet = item.content[start:start + 200].strip()
        scored.append(SearchResultOut(
            id=item.id,
            title=item.title,
            snippet=snippet,
            score=round(score, 3),
            goal_id=item.goal_id,
            kb_id=item.kb_id,
            source_type=item.source_type,
            source_url=item.source_url,
            citation=item.title,
        ))

    scored.sort(key=lambda x: x.score, reverse=True)
    return scored[:limit]


@router.post("/search/evaluate")
async def evaluate_search_quality(
    body: SearchEvaluationRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Measure recall@k and MRR against a user-supplied relevance set."""
    case_results = []
    recall_total = 0.0
    reciprocal_rank_total = 0.0

    for case in body.cases:
        results = await search_knowledge(
            q=case.query,
            goal_id=body.goal_id,
            limit=body.limit,
            current_user=current_user,
            db=db,
        )
        ranked_ids = [result.id for result in results]
        expected = set(case.expected_item_ids)
        matched = expected.intersection(ranked_ids)
        recall = len(matched) / len(expected)
        first_rank = next(
            (index + 1 for index, item_id in enumerate(ranked_ids) if item_id in expected),
            None,
        )
        reciprocal_rank = 1 / first_rank if first_rank else 0.0
        recall_total += recall
        reciprocal_rank_total += reciprocal_rank
        case_results.append({
            "query": case.query,
            "expected_item_ids": case.expected_item_ids,
            "retrieved_item_ids": ranked_ids,
            "recall": round(recall, 4),
            "reciprocal_rank": round(reciprocal_rank, 4),
        })

    count = len(case_results)
    return {
        "limit": body.limit,
        "case_count": count,
        "recall_at_k": round(recall_total / count, 4),
        "mrr": round(reciprocal_rank_total / count, 4),
        "cases": case_results,
    }


# ── Chat Notes ────────────────────────────────────────────────

async def _goal_title(goal_id: str | None, user_id: str, db: AsyncSession) -> str:
    if not goal_id:
        return ""
    goal = (await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id)
    )).scalar_one_or_none()
    return goal.title if goal else ""


@router.get("/notes", response_model=list[NoteOut])
async def list_notes(
    goal_id: str | None = None,
    task_id: str | None = None,
    note_type: str | None = None,
    date: str | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[NoteOut]:
    stmt = (
        select(KnowledgeItem)
        .where(KnowledgeItem.user_id == current_user.id, KnowledgeItem.source_type.in_(_NOTE_TYPES))
    )
    if note_type and note_type in _NOTE_TYPES:
        stmt = stmt.where(KnowledgeItem.source_type == note_type)
    if goal_id:
        stmt = stmt.where(KnowledgeItem.goal_id == goal_id)
    if task_id:
        stmt = stmt.where(KnowledgeItem.task_id == task_id)
    if date:
        stmt = stmt.where(KnowledgeItem.note_date == date)
    stmt = stmt.order_by(KnowledgeItem.created_at.desc())
    items = (await db.execute(stmt)).scalars().all()
    goal_ids = {item.goal_id for item in items if item.goal_id}
    goals: dict[str, str] = {}
    if goal_ids:
        goals = {g.id: g.title for g in (await db.execute(
            select(Goal).where(Goal.id.in_(goal_ids), Goal.user_id == current_user.id)
        )).scalars()}
    task_ids = {item.task_id for item in items if item.task_id}
    tasks: dict[str, str] = {}
    if task_ids:
        tasks = {
            task.id: task.title
            for task in (
                await db.execute(
                    select(Task)
                    .join(Goal, Task.goal_id == Goal.id)
                    .where(Task.id.in_(task_ids), Goal.user_id == current_user.id)
                )
            ).scalars()
        }
    note_ids = [item.id for item in items]
    att_map: dict[str, list[str]] = {}
    if note_ids:
        att_rows = (await db.execute(
            select(KnowledgeItem.id, KnowledgeItem.note_id)
            .where(KnowledgeItem.note_id.in_(note_ids))
        )).all()
        for att_id, nid in att_rows:
            att_map.setdefault(nid, []).append(att_id)
    return [
        _note_to_out(
            item,
            goals.get(item.goal_id or "", ""),
            att_map.get(item.id),
            tasks.get(item.task_id or "", ""),
            bool(item.task_id and item.task_id in tasks),
        )
        for item in items
    ]


@router.get("/notes/{note_id}", response_model=NoteOut)
async def get_note(
    note_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NoteOut:
    item = await _get_note(note_id, current_user.id, db)
    task_title = ""
    task_available = False
    if item.task_id:
        task = await _get_user_task(item.task_id, current_user.id, db)
        task_title = task.title
        task_available = True
    return _note_to_out(
        item,
        await _goal_title(item.goal_id, current_user.id, db),
        task_title=task_title,
        task_available=task_available,
    )


class UrlImportBody(BaseModel):
    url: str
    goal_id: str | None = None
    kb_id: str | None = None


@router.post("/url", response_model=KnowledgeFileOut)
async def import_url(
    body: UrlImportBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeFileOut:
    parsed_url = urlparse(body.url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        raise HTTPException(422, "仅支持有效的 HTTP/HTTPS URL")
    if len(body.url) > 2048:
        raise HTTPException(422, "URL 过长")
    if body.goal_id:
        await _get_user_goal(body.goal_id, current_user.id, db)
    if body.kb_id:
        await _get_kb(body.kb_id, current_user.id, db)

    title = body.url.split("/")[-1][:120] or body.url[:120]

    item = KnowledgeItem(
        id=str(uuid.uuid4()),
        user_id=current_user.id,
        goal_id=body.goal_id,
        kb_id=body.kb_id,
        title=title,
        content="",
        source_type="url",
        source_url=body.url,
        processing_status="queued",
        content_length=0,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)

    _dispatch_processing(item)
    if item.processing_status == "failed":
        await db.commit()

    return _to_file_out(item)


@router.patch("/notes/{note_id}", response_model=NoteOut)
async def update_note(
    note_id: str,
    body: NoteUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NoteOut:
    item = await _get_note(note_id, current_user.id, db)
    if body.title is not None:
        item.title = body.title
    if body.content is not None:
        item.content = body.content
    if body.goalId is not None:
        if body.goalId == "":
            item.goal_id = None
        else:
            await _get_user_goal(body.goalId, current_user.id, db)
            item.goal_id = body.goalId
        if item.task_id:
            current_task = await _get_user_task(item.task_id, current_user.id, db)
            if current_task.goal_id != item.goal_id:
                item.task_id = None
    if "taskId" in body.model_fields_set:
        if not body.taskId:
            item.task_id = None
            item.task_title_snapshot = None
        else:
            task = await _get_user_task(body.taskId, current_user.id, db)
            if item.goal_id and task.goal_id != item.goal_id:
                raise HTTPException(422, "任务不属于所选目标")
            item.goal_id = item.goal_id or task.goal_id
            item.task_id = task.id
            item.task_title_snapshot = task.title
    await db.commit()
    await db.refresh(item)
    task_title = ""
    task_available = False
    if item.task_id:
        task = await _get_user_task(item.task_id, current_user.id, db)
        task_title = task.title
        task_available = True
    return _note_to_out(
        item,
        await _goal_title(item.goal_id, current_user.id, db),
        task_title=task_title,
        task_available=task_available,
    )


@router.post("/notes", status_code=201, response_model=NoteOut)
async def create_note(
    body: NoteCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NoteOut:
    goal_id = body.goalId or None
    task = None
    if body.taskId:
        task = await _get_user_task(body.taskId, current_user.id, db)
        if goal_id and task.goal_id != goal_id:
            raise HTTPException(422, "任务不属于所选目标")
        goal_id = goal_id or task.goal_id
    goal_title = await _goal_title(goal_id, current_user.id, db)

    # 验证 kb_id 所有权
    kb_id = body.kb_id
    if kb_id:
        kb = (await db.execute(
            select(KnowledgeBase).where(KnowledgeBase.id == kb_id, KnowledgeBase.user_id == current_user.id)
        )).scalar_one_or_none()
        if not kb:
            kb_id = None

    item = KnowledgeItem(
        id=str(uuid.uuid4()),
        user_id=current_user.id,
        goal_id=goal_id,
        task_id=body.taskId or None,
        task_title_snapshot=task.title if task else None,
        kb_id=kb_id,
        title=body.title or "",
        content=body.content,
        source_type=body.noteType,
        note_date=body.noteDate,
        processing_status="ready",
        processed_at=datetime.now(UTC).replace(tzinfo=None),
        content_length=len(body.content),
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return _note_to_out(
        item,
        goal_title,
        task_title=task.title if task else "",
        task_available=bool(task),
    )
