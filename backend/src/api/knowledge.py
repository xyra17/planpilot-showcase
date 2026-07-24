import csv
import io
import os
import uuid
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import Goal, KnowledgeBase, KnowledgeItem, Task, User

router = APIRouter(prefix="/api/v1/knowledge", tags=["knowledge"])

UPLOAD_DIR = "uploads"
_MAX_CONTENT = 50_000


def _extract_text(raw: bytes, ext: str) -> str:
    try:
        if ext in ("txt", "md"):
            return raw.decode("utf-8", errors="replace")[:_MAX_CONTENT]
        if ext == "pdf":
            import pypdf
            reader = pypdf.PdfReader(io.BytesIO(raw))
            return "\n".join(p.extract_text() or "" for p in reader.pages)[:_MAX_CONTENT]
        if ext == "docx":
            import docx as _docx
            doc = _docx.Document(io.BytesIO(raw))
            return "\n".join(p.text for p in doc.paragraphs)[:_MAX_CONTENT]
        if ext == "csv":
            text = raw.decode("utf-8", errors="replace")
            reader = csv.reader(io.StringIO(text))
            return "\n".join(",".join(row) for row in reader)[:_MAX_CONTENT]
        if ext in ("xlsx", "xls"):
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
            lines = []
            for ws in wb.worksheets:
                for row in ws.iter_rows(values_only=True):
                    lines.append("\t".join("" if v is None else str(v) for v in row))
            return "\n".join(lines)[:_MAX_CONTENT]
    except Exception:
        pass
    return ""


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


_NOTE_TYPES = {"chat_note", "daily_log", "flash_card", "task_note"}


class NoteOut(BaseModel):
    id: str
    goalId: str
    goalTitle: str
    taskId: str | None
    title: str
    content: str
    noteType: str
    date: str
    savedAt: str
    attachmentIds: list[str] = []


class NoteCreate(BaseModel):
    goalId: str | None = None
    taskId: str | None = None
    title: str | None = None
    content: str
    noteType: str = "flash_card"
    kb_id: str | None = None


class NoteUpdate(BaseModel):
    title: str | None = None
    content: str | None = None


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
        if settings.openai_base_url:
            _embed_clients.append(
                AsyncOpenAI(api_key=settings.openai_api_key or "local", base_url=settings.openai_base_url)
            )
        if settings.smart_api_key:
            _embed_clients.append(
                AsyncOpenAI(api_key=settings.smart_api_key, base_url=settings.smart_base_url or None)
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


def _note_to_out(item: KnowledgeItem, goal_title: str, attachment_ids: list[str] | None = None) -> NoteOut:
    return NoteOut(
        id=item.id,
        goalId=item.goal_id or "",
        goalTitle=goal_title,
        taskId=item.task_id or None,
        title=item.title or "",
        content=item.content,
        noteType=item.source_type,
        date=item.created_at.strftime("%Y-%m-%d") if item.created_at else "",
        savedAt=item.created_at.isoformat() if item.created_at else "",
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
    saved_path = os.path.join(UPLOAD_DIR, f"{uuid.uuid4()}.{ext}")
    raw = await file.read()
    with open(saved_path, "wb") as f:
        f.write(raw)
    content = _extract_text(raw, ext)

    if kb_id:
        kb = (await db.execute(
            select(KnowledgeBase).where(KnowledgeBase.id == kb_id, KnowledgeBase.user_id == current_user.id)
        )).scalar_one_or_none()
        if not kb:
            kb_id = None

    goal_id = goal_ids[0] if goal_ids else None

    if task_id:
        task = (await db.execute(
            select(Task).where(Task.id == task_id, Task.goal_id == goal_id)
        )).scalar_one_or_none()
        if not task:
            task_id = None

    item = KnowledgeItem(
        id=str(uuid.uuid4()),
        user_id=current_user.id,
        goal_id=goal_id,
        kb_id=kb_id,
        task_id=task_id,
        note_id=note_id,
        title=filename,
        content=content,
        source_type="upload",
        file_path=saved_path,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    # 向量化派发
    from src.tasks.knowledge import vectorize_item
    vectorize_item.apply_async(args=[item.id], countdown=2)

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
        from sqlalchemy import cast, text as sa_text

        query_vec = None
        for _client in _get_embed_clients():
            try:
                resp = await _client.embeddings.create(model="text-embedding-3-small", input=q[:2000])
                query_vec = resp.data[0].embedding
                break
            except Exception:
                continue

        if query_vec:
            stmt = (
                select(
                    KnowledgeItem,
                    (1 - KnowledgeItem.embedding.op("<->")(cast(query_vec, Vector(1536)))).label("score"),
                )
                .where(
                    KnowledgeItem.user_id == current_user.id,
                    KnowledgeItem.embedding.is_not(None),
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
                ))
            if results:
                return results
    except Exception:
        pass

    # 降级：SQL ILIKE（比 Python 全扫描快，利用数据库索引）
    from sqlalchemy import or_

    q_safe = q.replace("%", r"\%").replace("_", r"\_")
    ilike_filter = or_(
        KnowledgeItem.title.ilike(f"%{q_safe}%"),
        KnowledgeItem.content.ilike(f"%{q_safe}%"),
    )
    stmt = (
        select(KnowledgeItem)
        .where(KnowledgeItem.user_id == current_user.id, ilike_filter)
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
        ))

    scored.sort(key=lambda x: x.score, reverse=True)
    return scored[:limit]


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
        stmt = stmt.where(func.date(KnowledgeItem.created_at) == date)
    stmt = stmt.order_by(KnowledgeItem.created_at.desc())
    items = (await db.execute(stmt)).scalars().all()
    goal_ids = {item.goal_id for item in items if item.goal_id}
    goals: dict[str, str] = {}
    if goal_ids:
        goals = {g.id: g.title for g in (await db.execute(
            select(Goal).where(Goal.id.in_(goal_ids), Goal.user_id == current_user.id)
        )).scalars()}
    note_ids = [item.id for item in items]
    att_map: dict[str, list[str]] = {}
    if note_ids:
        att_rows = (await db.execute(
            select(KnowledgeItem.id, KnowledgeItem.note_id)
            .where(KnowledgeItem.note_id.in_(note_ids))
        )).all()
        for att_id, nid in att_rows:
            att_map.setdefault(nid, []).append(att_id)
    return [_note_to_out(item, goals.get(item.goal_id or "", ""), att_map.get(item.id)) for item in items]


@router.get("/notes/{note_id}", response_model=NoteOut)
async def get_note(
    note_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NoteOut:
    item = await _get_note(note_id, current_user.id, db)
    return _note_to_out(item, await _goal_title(item.goal_id, current_user.id, db))


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
    import httpx
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"https://r.jina.ai/{body.url}", headers={"Accept": "text/plain"})
        content = resp.text[:_MAX_CONTENT]
    except Exception:
        raise HTTPException(400, "无法解析该 URL，请检查地址是否有效")

    if not content.strip():
        raise HTTPException(400, "页面内容为空，无法导入")

    title = body.url.split("/")[-1][:120] or body.url[:120]
    # 取第一行非空内容作为标题
    for line in content.splitlines():
        if line.strip():
            title = line.strip()[:120]
            break

    goal_id = body.goal_id
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
        kb_id=kb_id,
        title=title,
        content=content,
        source_type="url",
        source_url=body.url,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)

    # 异步向量化
    from src.tasks.knowledge import vectorize_item
    vectorize_item.apply_async(args=[item.id], countdown=2)

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
        if body.title is None:
            item.title = body.content[:80]
    await db.commit()
    await db.refresh(item)
    return _note_to_out(item, await _goal_title(item.goal_id, current_user.id, db))


@router.post("/notes", status_code=201, response_model=NoteOut)
async def create_note(
    body: NoteCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NoteOut:
    goal_title = await _goal_title(body.goalId or None, current_user.id, db)

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
        goal_id=body.goalId or None,
        task_id=body.taskId or None,
        kb_id=kb_id,
        title=body.title or body.content[:80],
        content=body.content,
        source_type=body.noteType,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return _note_to_out(item, goal_title)
