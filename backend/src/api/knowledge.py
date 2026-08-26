import os
import uuid
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete as sql_delete
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.core.time import utc_now
from src.database import get_db
from src.deps import get_current_user
from src.models import (
    Goal,
    KnowledgeBase,
    KnowledgeChunk,
    KnowledgeItem,
    KnowledgeItemFileVersion,
    KnowledgeItemGoalLink,
    KnowledgeItemLibraryLink,
    Task,
    User,
)
from src.services.object_storage import (
    ObjectStorageError,
    extension_for_reference,
    get_object_storage,
    reference_key,
)
from src.services.retrieval_service import retrieval_service
from src.services.ssrf_guard import UnsafeUrlError, normalize_public_http_url

router = APIRouter(prefix="/api/v1/knowledge", tags=["knowledge"])

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
INDEXABLE_EXTENSIONS = {"txt", "md", "json", "pdf", "docx", "csv", "xlsx", "pptx"}
ATTACHMENT_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}
ALLOWED_EXTENSIONS = INDEXABLE_EXTENSIONS | ATTACHMENT_EXTENSIONS
MIME_TYPES = {
    "txt": {"text/plain"},
    "md": {"text/plain", "text/markdown"},
    "json": {"application/json", "text/json", "text/plain"},
    "pdf": {"application/pdf"},
    "docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    "csv": {"text/csv", "application/csv", "text/plain"},
    "xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
    "pptx": {"application/vnd.openxmlformats-officedocument.presentationml.presentation"},
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
    kbIds: list[str]
    taskId: str
    status: str
    error: str | None
    retryCount: int
    contentLength: int
    summary: str
    sourceUrl: str | None
    content: str
    contentFormat: str


class KnowledgeFileVersionOut(BaseModel):
    id: str
    filename: str
    size: str
    createdAt: str


class KnowledgeBaseOut(BaseModel):
    id: str
    name: str
    description: str
    goal_id: str | None
    item_count: int
    created_at: str


class KnowledgeBaseCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = ""
    goal_id: str | None = None


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
    retrieval_method: str = "keyword_item"


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


NoteType = Literal["chat_note", "daily_log", "flash_card", "task_note", "quick_note"]
_NOTE_TYPES = {"chat_note", "daily_log", "flash_card", "task_note", "quick_note"}


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
    noteType: NoteType = "flash_card"
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
    noteType: NoteType | None = None
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


# ── Helpers ───────────────────────────────────────────────────


def _size_str(content: str, file_path: str | None, file_size_bytes: int = 0) -> str:
    sz = (
        file_size_bytes
        if file_size_bytes > 0
        else os.path.getsize(file_path)
        if file_path and os.path.exists(file_path)
        else len(content.encode())
    )
    return f"{sz / 1024 / 1024:.1f} MB" if sz >= 1024 * 1024 else f"{max(1, sz // 1024)} KB"


def _bytes_size_str(size: int) -> str:
    return f"{size / 1024 / 1024:.1f} MB" if size >= 1024 * 1024 else f"{max(1, size // 1024)} KB"


def _file_type(source_type: str, file_path: str | None) -> str:
    if file_path:
        ext = file_path.rsplit(".", 1)[-1].lower()
        if ext in ("xlsx", "xls", "csv"):
            return "excel"
        if ext in ("pdf", "docx", "doc", "txt", "md", "pptx", "ppt"):
            return ext
    return source_type


def _normalize_goal_ids(goal_ids: list[str] | None) -> list[str]:
    normalized: list[str] = []
    for goal_id in goal_ids or []:
        clean_id = goal_id.strip()
        if clean_id and clean_id not in normalized:
            normalized.append(clean_id)
    return normalized


def _normalize_kb_ids(kb_ids: list[str] | None) -> list[str]:
    normalized: list[str] = []
    for kb_id in kb_ids or []:
        clean_id = kb_id.strip()
        if clean_id and clean_id not in normalized:
            normalized.append(clean_id)
    return normalized


def _to_file_out(
    item: KnowledgeItem,
    *,
    goal_ids: list[str] | None = None,
    kb_ids: list[str] | None = None,
) -> KnowledgeFileOut:
    resolved_goal_ids = (
        _normalize_goal_ids(goal_ids)
        if goal_ids is not None
        else ([item.goal_id] if item.goal_id else [])
    )
    resolved_kb_ids = (
        _normalize_kb_ids(kb_ids) if kb_ids is not None else ([item.kb_id] if item.kb_id else [])
    )
    return KnowledgeFileOut(
        id=item.id,
        name=item.title,
        size=_size_str(item.content, item.file_path, item.file_size_bytes),
        uploadDate=item.created_at.strftime("%Y-%m-%d") if item.created_at else "",
        type=_file_type(item.source_type, item.file_path),
        goalIds=resolved_goal_ids,
        kbId=resolved_kb_ids[0] if resolved_kb_ids else "",
        kbIds=resolved_kb_ids,
        taskId=item.task_id or "",
        status=item.processing_status,
        error=item.processing_error,
        retryCount=item.retry_count,
        contentLength=item.content_length,
        summary=item.summary,
        sourceUrl=item.source_url,
        content=item.content,
        contentFormat=item.content_format,
    )


def _kb_to_out(kb: KnowledgeBase, item_count: int) -> KnowledgeBaseOut:
    return KnowledgeBaseOut(
        id=kb.id,
        name=kb.name,
        description=kb.description,
        goal_id=kb.goal_id,
        item_count=item_count,
        created_at=kb.created_at.strftime("%Y-%m-%d") if kb.created_at else "",
    )


async def _kb_item_count(kb_id: str, db: AsyncSession) -> int:
    return (
        await db.execute(
            select(func.count())
            .select_from(KnowledgeItemLibraryLink)
            .where(KnowledgeItemLibraryLink.kb_id == kb_id)
        )
    ).scalar_one()


async def _get_kb(kb_id: str, user_id: str, db: AsyncSession) -> KnowledgeBase:
    kb = (
        await db.execute(
            select(KnowledgeBase).where(KnowledgeBase.id == kb_id, KnowledgeBase.user_id == user_id)
        )
    ).scalar_one_or_none()
    if not kb:
        raise HTTPException(404, "知识库不存在")
    return kb


async def _get_user_goal(goal_id: str, user_id: str, db: AsyncSession) -> Goal:
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
    ).scalar_one_or_none()
    if not goal:
        raise HTTPException(404, "目标不存在")
    return goal


async def _validate_goal_ids(
    goal_ids: list[str],
    user_id: str,
    db: AsyncSession,
) -> list[str]:
    normalized = _normalize_goal_ids(goal_ids)
    for goal_id in normalized:
        await _get_user_goal(goal_id, user_id, db)
    return normalized


async def _replace_file_goal_links(
    item: KnowledgeItem,
    goal_ids: list[str],
    user_id: str,
    db: AsyncSession,
) -> list[str]:
    normalized = await _validate_goal_ids(goal_ids, user_id, db)
    await db.execute(
        sql_delete(KnowledgeItemGoalLink).where(KnowledgeItemGoalLink.item_id == item.id)
    )
    item.goal_id = normalized[0] if normalized else None
    db.add_all([KnowledgeItemGoalLink(item_id=item.id, goal_id=goal_id) for goal_id in normalized])
    return normalized


async def _validate_kb_ids(
    kb_ids: list[str],
    user_id: str,
    db: AsyncSession,
) -> list[str]:
    normalized = _normalize_kb_ids(kb_ids)
    for kb_id in normalized:
        await _get_kb(kb_id, user_id, db)
    return normalized


async def _replace_file_library_links(
    item: KnowledgeItem,
    kb_ids: list[str],
    user_id: str,
    db: AsyncSession,
) -> list[str]:
    normalized = await _validate_kb_ids(kb_ids, user_id, db)
    await db.execute(
        sql_delete(KnowledgeItemLibraryLink).where(KnowledgeItemLibraryLink.item_id == item.id)
    )
    item.kb_id = normalized[0] if normalized else None
    db.add_all([KnowledgeItemLibraryLink(item_id=item.id, kb_id=kb_id) for kb_id in normalized])
    return normalized


async def _get_user_task(task_id: str, user_id: str, db: AsyncSession) -> Task:
    task = (
        await db.execute(
            select(Task)
            .join(Goal, Goal.id == Task.goal_id)
            .where(Task.id == task_id, Goal.user_id == user_id)
        )
    ).scalar_one_or_none()
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


async def _get_user_file(item_id: str, user_id: str, db: AsyncSession) -> KnowledgeItem:
    item = (
        await db.execute(
            select(KnowledgeItem)
            .options(
                selectinload(KnowledgeItem.goal_links),
                selectinload(KnowledgeItem.library_links),
            )
            .where(
                KnowledgeItem.id == item_id,
                KnowledgeItem.user_id == user_id,
                KnowledgeItem.source_type.not_in(_NOTE_TYPES),
                KnowledgeItem.note_id.is_(None),
            )
        )
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "资料不存在")
    return item


async def _archive_current_file(item: KnowledgeItem, db: AsyncSession) -> KnowledgeItemFileVersion:
    storage = get_object_storage()
    if not item.file_path or not await storage.exists(item.file_path):
        raise HTTPException(409, "当前资料没有可归档的原文件")
    ext = extension_for_reference(item.file_path) or "bin"
    version_id = str(uuid.uuid4())
    try:
        version_path = await storage.copy(
            item.file_path, f"knowledge/versions/{item.id}/{version_id}.{ext}"
        )
    except ObjectStorageError as exc:
        raise HTTPException(500, "旧版本保存失败") from exc
    version = KnowledgeItemFileVersion(
        id=version_id,
        item_id=item.id,
        file_path=version_path,
        filename=item.title,
        size_bytes=await storage.size(version_path) or 0,
        content=item.content,
        content_format=item.content_format,
    )
    db.add(version)
    return version


async def _prune_file_versions(item_id: str, db: AsyncSession, keep: int = 10) -> None:
    await db.flush()
    stale_versions = (
        (
            await db.execute(
                select(KnowledgeItemFileVersion)
                .where(KnowledgeItemFileVersion.item_id == item_id)
                .order_by(KnowledgeItemFileVersion.created_at.desc())
                .offset(keep)
            )
        )
        .scalars()
        .all()
    )
    for version in stale_versions:
        await get_object_storage().delete(version.file_path)
        await db.delete(version)


@router.post("/reindex", response_model=ReindexResult)
async def reindex_legacy_items(
    limit: int = 100,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ReindexResult:
    """Queue legacy ready documents that do not have chunk-level indexes."""
    safe_limit = max(1, min(limit, 500))
    items = (
        (
            await db.execute(
                select(KnowledgeItem)
                .options(
                    selectinload(KnowledgeItem.goal_links),
                    selectinload(KnowledgeItem.library_links),
                )
                .where(
                    KnowledgeItem.user_id == current_user.id,
                    KnowledgeItem.processing_status == "ready",
                    KnowledgeItem.source_type.in_({"upload", "url"}),
                    ~KnowledgeItem.chunks.any(),
                )
                .order_by(KnowledgeItem.created_at.asc())
                .limit(safe_limit)
            )
        )
        .scalars()
        .all()
    )

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
    item = (
        await db.execute(
            select(KnowledgeItem).where(
                KnowledgeItem.id == note_id,
                KnowledgeItem.user_id == user_id,
                KnowledgeItem.source_type.in_(_NOTE_TYPES),
            )
        )
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "笔记不存在")
    return item


# ── Files ────────────────────────────────────────────────────


@router.get("/files")
async def list_files(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    items = (
        (
            await db.execute(
                select(KnowledgeItem)
                .options(
                    selectinload(KnowledgeItem.goal_links),
                    selectinload(KnowledgeItem.library_links),
                )
                .where(
                    KnowledgeItem.user_id == current_user.id,
                    KnowledgeItem.source_type.not_in(_NOTE_TYPES),
                    KnowledgeItem.note_id.is_(None),
                )
                .order_by(KnowledgeItem.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return {
        "items": [
            _to_file_out(
                item,
                goal_ids=[link.goal_id for link in item.goal_links],
                kb_ids=[link.kb_id for link in item.library_links],
            )
            for item in items
        ]
    }


class KnowledgeFileUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    summary: str | None = Field(default=None, max_length=4000)
    kb_id: str | None = None
    kb_ids: list[str] | None = None
    goal_ids: list[str] | None = None
    goal_id: str | None = None
    content: str | None = None
    content_format: Literal["plain", "markdown", "html"] | None = None


@router.patch("/files/{item_id}", response_model=KnowledgeFileOut)
async def update_file_metadata(
    item_id: str,
    body: KnowledgeFileUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeFileOut:
    item = (
        await db.execute(
            select(KnowledgeItem)
            .where(
                KnowledgeItem.id == item_id,
                KnowledgeItem.user_id == current_user.id,
                KnowledgeItem.source_type.not_in(_NOTE_TYPES),
                KnowledgeItem.note_id.is_(None),
            )
            .options(
                selectinload(KnowledgeItem.goal_links),
                selectinload(KnowledgeItem.library_links),
            )
        )
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "资料不存在")
    if body.title is not None:
        item.title = body.title.strip()
    if body.summary is not None:
        item.summary = body.summary.strip()
    if body.content is not None:
        item.content = body.content
        item.content_length = len(body.content)
    if body.content_format is not None:
        item.content_format = body.content_format
    linked_kb_ids = [link.kb_id for link in item.library_links]
    if "kb_ids" in body.model_fields_set:
        linked_kb_ids = await _replace_file_library_links(
            item, body.kb_ids or [], current_user.id, db
        )
    elif "kb_id" in body.model_fields_set:
        linked_kb_ids = await _replace_file_library_links(
            item, [body.kb_id] if body.kb_id else [], current_user.id, db
        )
    linked_goal_ids = [link.goal_id for link in item.goal_links]
    if "goal_ids" in body.model_fields_set:
        linked_goal_ids = await _replace_file_goal_links(
            item,
            body.goal_ids or [],
            current_user.id,
            db,
        )
    elif "goal_id" in body.model_fields_set:
        linked_goal_ids = await _replace_file_goal_links(
            item,
            [body.goal_id] if body.goal_id else [],
            current_user.id,
            db,
        )
    await db.commit()
    await db.refresh(item)
    return _to_file_out(item, goal_ids=linked_goal_ids, kb_ids=linked_kb_ids)


@router.post("/upload", response_model=KnowledgeFileOut)
async def upload_file(
    file: UploadFile = File(...),
    kb_id: str | None = Form(None),
    kb_ids: list[str] = Form(default=[]),
    goal_ids: list[str] = Form(default=[]),
    task_id: str | None = Form(None),
    note_id: str | None = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeFileOut:
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
    if ext in {"docx", "xlsx", "pptx"} and not raw.startswith(b"PK"):
        raise HTTPException(415, "Office 文件签名无效")

    goal_ids = await _validate_goal_ids(goal_ids, current_user.id, db)
    if task_id:
        task = await _get_user_task(task_id, current_user.id, db)
        if task.goal_id not in goal_ids:
            goal_ids.append(task.goal_id)
    if note_id:
        await _get_note(note_id, current_user.id, db)
    requested_kb_ids = [*kb_ids, *([kb_id] if kb_id else [])]
    kb_ids = await _validate_kb_ids(requested_kb_ids, current_user.id, db)

    storage = get_object_storage()
    try:
        saved_path = await storage.put(
            f"knowledge/{current_user.id}/{uuid.uuid4()}.{ext}",
            raw,
            content_type or "application/octet-stream",
        )
    except ObjectStorageError as exc:
        raise HTTPException(500, "文件保存失败") from exc

    item = KnowledgeItem(
        id=str(uuid.uuid4()),
        user_id=current_user.id,
        goal_id=goal_ids[0] if goal_ids else None,
        kb_id=kb_ids[0] if kb_ids else None,
        task_id=task_id,
        note_id=note_id,
        title=filename,
        content="",
        source_type="upload",
        file_path=saved_path,
        file_size_bytes=len(raw),
        processing_status="queued" if ext in INDEXABLE_EXTENSIONS else "ready",
        processed_at=(utc_now() if ext in ATTACHMENT_EXTENSIONS else None),
    )
    try:
        db.add(item)
        db.add_all(
            [KnowledgeItemGoalLink(item_id=item.id, goal_id=goal_id) for goal_id in goal_ids]
        )
        db.add_all(
            [
                KnowledgeItemLibraryLink(item_id=item.id, kb_id=linked_kb_id)
                for linked_kb_id in kb_ids
            ]
        )
        await db.commit()
        await db.refresh(item)
    except Exception:
        await storage.delete(saved_path)
        raise
    if ext in INDEXABLE_EXTENSIONS:
        _dispatch_processing(item)
        if item.processing_status == "failed":
            await db.commit()

    return _to_file_out(item, goal_ids=goal_ids, kb_ids=kb_ids)


@router.post("/{item_id}/retry", response_model=KnowledgeFileOut)
async def retry_processing(
    item_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeFileOut:
    item = (
        await db.execute(
            select(KnowledgeItem)
            .options(
                selectinload(KnowledgeItem.goal_links),
                selectinload(KnowledgeItem.library_links),
            )
            .where(
                KnowledgeItem.id == item_id,
                KnowledgeItem.user_id == current_user.id,
            )
        )
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "文件不存在")
    if item.processing_status not in {"failed", "uploaded"}:
        raise HTTPException(409, "该文件当前不需要重试")
    linked_goal_ids = [link.goal_id for link in item.goal_links]
    linked_kb_ids = [link.kb_id for link in item.library_links]
    item.processing_status = "queued"
    item.processing_error = None
    item.retry_count = 0
    await db.commit()
    _dispatch_processing(item)
    await db.commit()
    await db.refresh(item)
    return _to_file_out(item, goal_ids=linked_goal_ids, kb_ids=linked_kb_ids)


@router.delete("/{item_id}", status_code=204)
async def delete_item(
    item_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    item = (
        await db.execute(
            select(KnowledgeItem).where(
                KnowledgeItem.id == item_id,
                KnowledgeItem.user_id == current_user.id,
            )
        )
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "文件不存在")

    async def delete_stored_assets(target: KnowledgeItem) -> None:
        storage = get_object_storage()
        references = {
            reference
            for reference in (
                target.file_path,
                getattr(target, "media_playback_path", None),
                getattr(target, "media_poster_path", None),
                getattr(target, "media_waveform_path", None),
            )
            if reference
        }
        versions = (
            (
                await db.execute(
                    select(KnowledgeItemFileVersion).where(
                        KnowledgeItemFileVersion.item_id == target.id
                    )
                )
            )
            .scalars()
            .all()
        )
        references.update(version.file_path for version in versions)
        for reference in references:
            await storage.delete(reference)

    await delete_stored_assets(item)
    # 级联删除该笔记的专属附件
    attachments = (
        (await db.execute(select(KnowledgeItem).where(KnowledgeItem.note_id == item_id)))
        .scalars()
        .all()
    )
    for att in attachments:
        await delete_stored_assets(att)
        await db.delete(att)
    await db.delete(item)
    await db.commit()


@router.get("/files/{file_id}/serve")
async def serve_file(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    item = (
        await db.execute(
            select(KnowledgeItem).where(
                KnowledgeItem.id == file_id,
                KnowledgeItem.user_id == current_user.id,
            )
        )
    ).scalar_one_or_none()
    storage = get_object_storage()
    if not item or not item.file_path or not await storage.exists(item.file_path):
        raise HTTPException(status_code=404, detail="文件不存在")
    try:
        body = await storage.read(item.file_path)
    except ObjectStorageError as exc:
        raise HTTPException(status_code=404, detail="文件不存在") from exc
    encoded_name = quote(item.title, safe="")
    return Response(
        body,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}"},
    )


@router.get("/files/{item_id}/versions", response_model=list[KnowledgeFileVersionOut])
async def list_file_versions(
    item_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[KnowledgeFileVersionOut]:
    await _get_user_file(item_id, current_user.id, db)
    versions = (
        (
            await db.execute(
                select(KnowledgeItemFileVersion)
                .where(KnowledgeItemFileVersion.item_id == item_id)
                .order_by(KnowledgeItemFileVersion.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return [
        KnowledgeFileVersionOut(
            id=version.id,
            filename=version.filename,
            size=_bytes_size_str(version.size_bytes),
            createdAt=version.created_at.strftime("%Y-%m-%d %H:%M") if version.created_at else "",
        )
        for version in versions
    ]


@router.post("/files/{item_id}/replace", response_model=KnowledgeFileOut)
async def replace_file(
    item_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeFileOut:
    item = await _get_user_file(item_id, current_user.id, db)
    if item.source_type != "upload" or not item.file_path:
        raise HTTPException(409, "只有上传的本地文件可以替换")

    filename = file.filename or item.title
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    current_ext = extension_for_reference(item.file_path) or "bin"
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(415, f"不支持的文件类型：.{ext}")
    if ext != current_ext:
        raise HTTPException(415, f"替换文件必须保持 .{current_ext} 格式")
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
    if ext in {"docx", "xlsx", "pptx"} and not raw.startswith(b"PK"):
        raise HTTPException(415, "Office 文件签名无效")

    await _archive_current_file(item, db)
    storage = get_object_storage()
    try:
        target_key = (
            reference_key(item.file_path)
            if item.file_path.startswith("object://")
            else f"knowledge/{current_user.id}/{uuid.uuid4()}.{ext}"
        )
        old_path = item.file_path
        item.file_path = await storage.put(
            target_key, raw, content_type or "application/octet-stream"
        )
        if old_path != item.file_path:
            await storage.delete(old_path)
    except ObjectStorageError as exc:
        await db.rollback()
        raise HTTPException(500, "替换文件保存失败") from exc

    item.content = ""
    item.file_size_bytes = len(raw)
    item.content_format = "markdown" if ext == "md" else "plain"
    item.content_length = 0
    item.embedding = None
    item.processing_error = None
    item.retry_count = 0
    item.processing_status = "queued" if ext in INDEXABLE_EXTENSIONS else "ready"
    item.processed_at = utc_now() if ext in ATTACHMENT_EXTENSIONS else None
    await db.execute(sql_delete(KnowledgeChunk).where(KnowledgeChunk.item_id == item.id))
    await _prune_file_versions(item.id, db)
    await db.commit()
    await db.refresh(item)
    if ext in INDEXABLE_EXTENSIONS:
        _dispatch_processing(item)
        if item.processing_status == "failed":
            await db.commit()
    return _to_file_out(
        item,
        goal_ids=[link.goal_id for link in item.goal_links],
        kb_ids=[link.kb_id for link in item.library_links],
    )


@router.post("/files/{item_id}/versions/{version_id}/restore", response_model=KnowledgeFileOut)
async def restore_file_version(
    item_id: str,
    version_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeFileOut:
    item = await _get_user_file(item_id, current_user.id, db)
    version = (
        await db.execute(
            select(KnowledgeItemFileVersion).where(
                KnowledgeItemFileVersion.id == version_id,
                KnowledgeItemFileVersion.item_id == item.id,
            )
        )
    ).scalar_one_or_none()
    storage = get_object_storage()
    if not version or not await storage.exists(version.file_path):
        raise HTTPException(404, "历史版本不存在")
    await _archive_current_file(item, db)
    ext = extension_for_reference(version.file_path) or "bin"
    try:
        restored_path = await storage.copy(
            version.file_path, f"knowledge/{current_user.id}/{uuid.uuid4()}.{ext}"
        )
    except ObjectStorageError as exc:
        await db.rollback()
        raise HTTPException(500, "历史版本恢复失败") from exc
    old_path = item.file_path
    item.file_path = restored_path
    item.file_size_bytes = version.size_bytes
    item.title = version.filename
    item.content = version.content
    item.content_format = version.content_format
    item.content_length = len(version.content)
    item.embedding = None
    item.processing_error = None
    item.retry_count = 0
    item.processing_status = "queued" if ext in INDEXABLE_EXTENSIONS else "ready"
    item.processed_at = utc_now() if ext in ATTACHMENT_EXTENSIONS else None
    await db.execute(sql_delete(KnowledgeChunk).where(KnowledgeChunk.item_id == item.id))
    await _prune_file_versions(item.id, db)
    await db.commit()
    if old_path and old_path != restored_path:
        await storage.delete(old_path)
    await db.refresh(item)
    if ext in INDEXABLE_EXTENSIONS:
        _dispatch_processing(item)
        if item.processing_status == "failed":
            await db.commit()
    return _to_file_out(
        item,
        goal_ids=[link.goal_id for link in item.goal_links],
        kb_ids=[link.kb_id for link in item.library_links],
    )


# ── Knowledge Bases ───────────────────────────────────────────


@router.get("/kbs")
async def list_kbs(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    rows = (
        await db.execute(
            select(KnowledgeBase, func.count(KnowledgeItemLibraryLink.item_id).label("cnt"))
            .outerjoin(
                KnowledgeItemLibraryLink,
                KnowledgeItemLibraryLink.kb_id == KnowledgeBase.id,
            )
            .where(KnowledgeBase.user_id == current_user.id)
            .group_by(KnowledgeBase.id)
            .order_by(KnowledgeBase.created_at.desc())
        )
    ).all()
    return {"items": [_kb_to_out(kb, cnt) for kb, cnt in rows]}


@router.post("/kbs", status_code=201)
async def create_kb(
    body: KnowledgeBaseCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeBaseOut:
    if body.goal_id:
        await _get_user_goal(body.goal_id, current_user.id, db)
    kb = KnowledgeBase(
        id=str(uuid.uuid4()),
        user_id=current_user.id,
        goal_id=body.goal_id,
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
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    goal_id: str | None = None


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
    if "goal_id" in body.model_fields_set:
        if body.goal_id:
            await _get_user_goal(body.goal_id, current_user.id, db)
        kb.goal_id = body.goal_id
    await db.commit()
    await db.refresh(kb)
    return _kb_to_out(kb, await _kb_item_count(kb_id, db))


@router.delete("/kbs/{kb_id}", status_code=204)
async def delete_kb(
    kb_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    kb = (
        await db.execute(
            select(KnowledgeBase).where(
                KnowledgeBase.id == kb_id, KnowledgeBase.user_id == current_user.id
            )
        )
    ).scalar_one_or_none()
    if not kb:
        raise HTTPException(404, "知识库不存在")
    # 删除文件夹只解除索引，不删除物理资料。
    items = (
        (await db.execute(select(KnowledgeItem).where(KnowledgeItem.kb_id == kb_id)))
        .scalars()
        .all()
    )
    for item in items:
        remaining_id = (
            await db.execute(
                select(KnowledgeItemLibraryLink.kb_id)
                .where(
                    KnowledgeItemLibraryLink.item_id == item.id,
                    KnowledgeItemLibraryLink.kb_id != kb_id,
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        item.kb_id = remaining_id
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
    item = (
        await db.execute(
            select(KnowledgeItem).where(
                KnowledgeItem.id == item_id, KnowledgeItem.user_id == current_user.id
            )
        )
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "文件不存在")
    existing = (
        await db.execute(
            select(KnowledgeItemLibraryLink).where(
                KnowledgeItemLibraryLink.item_id == item_id,
                KnowledgeItemLibraryLink.kb_id == kb_id,
            )
        )
    ).scalar_one_or_none()
    if not existing:
        db.add(KnowledgeItemLibraryLink(item_id=item_id, kb_id=kb_id))
    if not item.kb_id:
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
    unified_results = await retrieval_service.search(
        db,
        user_id=current_user.id,
        query=q,
        goal_id=goal_id,
        limit=limit,
    )
    return [SearchResultOut(**result.to_dict()) for result in unified_results]
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
        case_results.append(
            {
                "query": case.query,
                "expected_item_ids": case.expected_item_ids,
                "retrieved_item_ids": ranked_ids,
                "recall": round(recall, 4),
                "reciprocal_rank": round(reciprocal_rank, 4),
            }
        )

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
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
    ).scalar_one_or_none()
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
    stmt = select(KnowledgeItem).where(
        KnowledgeItem.user_id == current_user.id, KnowledgeItem.source_type.in_(_NOTE_TYPES)
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
        goals = {
            g.id: g.title
            for g in (
                await db.execute(
                    select(Goal).where(Goal.id.in_(goal_ids), Goal.user_id == current_user.id)
                )
            ).scalars()
        }
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
        att_rows = (
            await db.execute(
                select(KnowledgeItem.id, KnowledgeItem.note_id).where(
                    KnowledgeItem.note_id.in_(note_ids)
                )
            )
        ).all()
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
    title: str | None = Field(default=None, max_length=255)
    goal_ids: list[str] | None = None
    goal_id: str | None = None
    kb_id: str | None = None
    kb_ids: list[str] | None = None


@router.post("/url", response_model=KnowledgeFileOut)
async def import_url(
    body: UrlImportBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeFileOut:
    try:
        source_url = await normalize_public_http_url(body.url)
    except UnsafeUrlError as exc:
        raise HTTPException(422, str(exc)) from exc
    requested_goal_ids = (
        body.goal_ids or []
        if "goal_ids" in body.model_fields_set
        else ([body.goal_id] if body.goal_id else [])
    )
    goal_ids = await _validate_goal_ids(requested_goal_ids, current_user.id, db)
    requested_kb_ids = body.kb_ids or []
    if body.kb_id:
        requested_kb_ids.append(body.kb_id)
    kb_ids = await _validate_kb_ids(requested_kb_ids, current_user.id, db)

    title = (
        body.title.strip()
        if body.title and body.title.strip()
        else (source_url.split("/")[-1][:120] or source_url[:120])
    )

    item = KnowledgeItem(
        id=str(uuid.uuid4()),
        user_id=current_user.id,
        goal_id=goal_ids[0] if goal_ids else None,
        kb_id=kb_ids[0] if kb_ids else None,
        title=title,
        content="",
        source_type="url",
        source_url=source_url,
        processing_status="queued",
        content_length=0,
    )
    db.add(item)
    db.add_all([KnowledgeItemGoalLink(item_id=item.id, goal_id=goal_id) for goal_id in goal_ids])
    db.add_all([KnowledgeItemLibraryLink(item_id=item.id, kb_id=kb_id) for kb_id in kb_ids])
    await db.commit()
    await db.refresh(item)

    _dispatch_processing(item)
    if item.processing_status == "failed":
        await db.commit()

    return _to_file_out(item, goal_ids=goal_ids, kb_ids=kb_ids)


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
    if body.noteType is not None:
        # 对话摘录与任务笔记由对应业务流程维护，不允许在笔记中心改写其语义。
        if item.source_type in {"chat_note", "task_note"} or body.noteType in {
            "chat_note",
            "task_note",
        }:
            raise HTTPException(422, "系统生成的笔记类型不能转换")
        item.source_type = body.noteType
    if "noteDate" in body.model_fields_set:
        item.note_date = body.noteDate
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
        kb = (
            await db.execute(
                select(KnowledgeBase).where(
                    KnowledgeBase.id == kb_id, KnowledgeBase.user_id == current_user.id
                )
            )
        ).scalar_one_or_none()
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
        processed_at=utc_now(),
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
