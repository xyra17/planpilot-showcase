# 技术实现与架构说明书
## PlanPilot 后端 — Module 4：知识库与向量检索（2026-07-21）

---

## 0. 模块定位

Module 4 管理用户上传的学习资料（PDF/Word/Excel/TXT/Markdown/URL），提取全文、生成向量嵌入、支持语义检索和关键词搜索。涉及 `knowledge.py`、`pgvector` 扩展、Celery 异步向量化任务。

---

## 1. API 路由总览

前缀：`/api/v1/knowledge`，所有端点需要 JWT 认证。

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/upload` | 上传文件（支持 PDF/DOCX/XLSX/CSV/TXT/MD） |
| POST | `/url` | 导入 URL 网页内容 |
| GET | `/files` | 获取用户所有知识文件列表 |
| DELETE | `/{item_id}` | 删除知识条目（含本地文件） |
| POST | `/kbs` | 创建知识库 |
| GET | `/kbs` | 获取用户所有知识库 |
| GET | `/kbs/{kb_id}` | 获取单个知识库详情（含条目数） |
| PATCH | `/kbs/{kb_id}` | 更新知识库名称/描述 |
| DELETE | `/kbs/{kb_id}?delete_items=false` | 删除知识库（可选级联删除条目） |
| POST | `/kbs/{kb_id}/items/{item_id}` | 将知识条目移入指定知识库 |
| GET | `/search?q=keyword` | 混合检索（向量 + 关键词） |
| POST | `/notes` | 创建笔记（关联目标） |
| GET | `/notes?goalId=xxx` | 获取笔记列表 |
| GET | `/notes/{note_id}` | 获取单条笔记详情 |
| PATCH | `/notes/{note_id}` | 更新笔记 |
| DELETE | `/notes/{note_id}` | 删除笔记 |

---

## 2. 文件上传与文本提取

### 2.1 `POST /upload`

**请求格式**：`multipart/form-data`

| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | File | 必填，单文件 |
| `kb_id` | str | 可选，关联知识库 ID |
| `goal_ids` | str[] | 可选，关联多个目标 ID |
| `task_id` | str | 可选，关联任务 ID |

**处理流程**：

1. **保存文件**：`uploads/{uuid}_{original_name}`
2. **提取文本**：调用 `_extract_text(raw_bytes, extension)`
   - PDF：`pypdf.PdfReader` → 拼接所有页文本，最多 50,000 字符
   - DOCX：`python-docx` → 拼接所有段落
   - XLSX/XLS：`openpyxl` → 遍历所有 sheet，行拼接（tab 分隔）
   - CSV：`csv.reader` → 逐行拼接
   - TXT/MD：直接 `decode("utf-8")`
3. **创建记录**：`KnowledgeItem(title=文件名, content=提取文本, file_path=本地路径, source_type="upload", ...)`
4. **异步向量化**：
   ```python
   from src.tasks.vectorize import vectorize_item
   vectorize_item.apply_async(args=[item.id], countdown=2)
   ```

**响应**：`KnowledgeFileOut`（文件元信息 + 关联关系）

---

### 2.2 `POST /url`

**请求体**：

```python
class UrlImportRequest(BaseModel):
    url: str
    goal_id: str | None
    kb_id: str | None
```

**处理流程**：

1. 调用 Jina Reader API（或 httpx 直接抓取）：`https://r.jina.ai/{url}`
2. 提取 Markdown 格式正文，最多 50,000 字符
3. 创建 `KnowledgeItem(title=网页标题, content=正文, source_type="url", source_url=url, ...)`
4. 异步向量化（同上）

---

## 3. 向量检索（pgvector）

### 3.1 向量化任务

**Celery 任务**：`src/tasks/vectorize.py → vectorize_item`

```python
@celery_app.task
def vectorize_item(item_id: str):
    async def _main():
        async with AsyncSessionLocal() as db:
            item = await db.get(KnowledgeItem, item_id)
            if not item or not item.content:
                return
            # 调用 OpenAI Embedding API
            response = await openai_client.embeddings.create(
                model="text-embedding-3-small",
                input=item.content[:8000],  # 截断至 8K token
            )
            embedding = response.data[0].embedding  # list[float]，1536 维
            item.embedding = embedding
            await db.commit()
    asyncio.run(_main())
```

**入库后字段**：`knowledge_items.embedding` → `Vector(1536)` 类型（pgvector）

---

### 3.2 `GET /search?q=keyword`

**混合检索策略**（两阶段，2026-07-23 优化）：

#### 阶段 1：向量检索

**Embedding 客户端单例**：`_get_embed_clients()` 在模块级懒加载，本地模型优先，回退 Smart API，避免每次请求重建连接。

```python
# 模块级单例（knowledge.py 顶部）
_embed_clients: list | None = None

def _get_embed_clients() -> list:
    global _embed_clients
    if _embed_clients is None:
        # 按配置初始化，本地模型优先
        _embed_clients = [...]
    return _embed_clients
```

**查询流程**：

```python
for _client in _get_embed_clients():
    resp = await _client.embeddings.create(model="text-embedding-3-small", input=q[:2000])
    query_vec = resp.data[0].embedding
    break

stmt = (
    select(KnowledgeItem, (1 - embedding.op("<->")(cast(query_vec, Vector(1536)))).label("score"))
    .where(user_id == current_user.id, embedding.is_not(None))
    .order_by("score DESC").limit(limit)
)
```

**得分阈值过滤（2026-07-23 新增）**：向量结果中 `score < 0.3` 的条目直接丢弃，避免低相关度噪音。只有通过阈值的结果才返回，否则进入降级。

- `<->` 是 pgvector 余弦距离算子（0=相同，2=完全相反），`1 - distance` 转为相似度
- 只查 `embedding IS NOT NULL` 的记录（新上传文件需等待 Celery 向量化完成）

#### 阶段 2：SQL ILIKE 降级

当向量检索无结果（嵌入服务不可用或全低于阈值）时，降级为 SQL 关键词匹配，**不再加载全量文档到 Python 内存**：

```python
q_safe = q.replace("%", r"\%").replace("_", r"\_")  # 转义特殊字符
stmt = select(KnowledgeItem).where(
    KnowledgeItem.user_id == current_user.id,
    or_(
        KnowledgeItem.title.ilike(f"%{q_safe}%"),
        KnowledgeItem.content.ilike(f"%{q_safe}%"),
    )
).limit(limit * 3)
```

数据库层过滤，只返回命中行；Python 层再用 `_keyword_score()` 排序。

**SearchResultOut**：

```python
class SearchResultOut(BaseModel):
    id: str
    title: str
    snippet: str           # 命中词前后 200 字符
    score: float           # 向量检索为相似度（0-1），关键词检索为词频比（0-1）
    goal_id: str | None
    kb_id: str | None
```

---

## 4. 知识库（KnowledgeBase）

**用途**：将尚未关联目标的知识条目分组管理，在前端知识页显示为「待分类」分区。一旦条目关联了目标（`goal_id` 不为空），则不再显示于该分区，而是归入对应目标视图。

新建目标时通过 `pending_kb` 原子创建的知识库，其配套上传的文件/URL/笔记直接关联目标，不写入 `kb_id`，不进入「待分类」。

### 4.1 `POST /kbs`

```python
class KnowledgeBaseCreate(BaseModel):
    name: str
    description: str = ""
```

创建后返回 `KnowledgeBaseOut`：

```python
class KnowledgeBaseOut(BaseModel):
    id: str
    name: str
    description: str
    item_count: int        # COUNT(knowledge_items WHERE kb_id=...)
    created_at: str
```

### 4.2 `GET /kbs`

返回用户所有知识库 + 每个库的条目数。

### 4.3 `GET /kbs/{kb_id}`

**作用**：获取单个知识库详情（含 `item_count`）。  
校验 `kb.user_id == current_user.id`，不存在或不属于当前用户返回 404。

### 4.4 `PATCH /kbs/{kb_id}`

```python
class KnowledgeBaseUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
```

**作用**：更新知识库名称或描述，返回更新后的 `KnowledgeBaseOut`。

### 4.5 `DELETE /kbs/{kb_id}?delete_items=false`

**作用**：删除知识库。  
- `delete_items=false`（默认）：仅删除 KB 记录，关联的 `KnowledgeItem` 的 `kb_id` 置为 `null`，条目进入「待分类」。  
- `delete_items=true`：级联删除所有关联条目（含本地文件）。

### 4.6 `POST /kbs/{kb_id}/items/{item_id}`

**作用**：将已有知识条目移入指定知识库（前端「待分类」拖动归档入 KB）。  
**流程**：校验 KB 和 Item 均属于当前用户 → `item.kb_id = kb_id` → 返回更新后的 `KnowledgeFileOut`。

---

## 5. 笔记（Note）

**笔记本质**：`source_type="system"` 的 `KnowledgeItem`，`content` 为用户手写文本，关联到目标。

### 5.1 `POST /notes`

```python
class NoteCreate(BaseModel):
    goalId: str
    content: str
    kb_id: str | None = None   # 手动上传到「待分类」时传入；新建目标时不传
```

创建后自动：
- `title = content 前 50 字符 + "..."`
- `source_type = "system"`
- `goal_id = goalId`
- 异步向量化

### 5.2 `GET /notes/{note_id}`

**作用**：获取单条笔记详情（`id / title / content / goal_id / kb_id / created_at`）。  
校验 `item.user_id == current_user.id`，不存在或越权返回 404。

### 5.3 `PATCH /notes/{note_id}`

```python
class NoteUpdate(BaseModel):
    content: str | None = None
```

更新后重新向量化（清空原 `embedding`，派发新任务）。

---

## 6. 删除逻辑

`DELETE /{item_id}`：

1. 校验 `item.user_id == current_user.id`
2. 删除本地文件：`os.remove(item.file_path)` if exists
3. 删除数据库记录：`await db.delete(item)`

---

## 7. pgvector 扩展安装

Alembic 迁移 `b4c5d6e7f8a9_add_pgvector_extension.py`：

```python
def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.add_column("knowledge_items", sa.Column("embedding", Vector(1536), nullable=True))
    op.create_index("ix_knowledge_items_embedding", "knowledge_items", ["embedding"], postgresql_using="ivfflat")
```

**索引类型**：`hnsw`（Hierarchical Navigable Small World）

> **变更记录（2026-07-23）**  
> **原索引**：`ivfflat`（`lists=100`） — 构建快，但召回率随数据量增长下降明显（50万条时约 87%）。  
> **新索引**：`hnsw`（`m=16, ef_construction=64`） — 召回率稳定在 97%+，查询延迟 O(log N) 增长。  
> **迁移文件**：`alembic/versions/e1f2a3b4c5d6_upgrade_embedding_index_to_hnsw.py`，执行 `alembic upgrade head` 生效。  
> **回滚**：`alembic downgrade -1` 可恢复 ivfflat 索引。
