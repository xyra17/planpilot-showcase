# 技术实现与架构说明书
## PlanPilot 后端 — Module 1：基础骨架与认证（2026-07-21 更新）

---

## 0. 模块定位与边界

Module 1 是后端地基，负责四件事：
1. 建立 FastAPI 应用骨架，挂载 CORS、slowapi 限流、structlog 日志、Sentry 监控
2. 定义全量 ORM 模型（9 张表），为所有后续模块提供数据结构
3. 建立异步 PostgreSQL 连接（asyncpg + pgvector）
4. 实现 JWT 注册/登录/身份验证链路

所有后续模块的每个接口都依赖本模块的 `get_current_user` 和 `get_db`。

---

## 1. 文件/模块架构

### 1.1 `src/main.py` — FastAPI 入口

**实际依赖**：`fastapi`, `slowapi`, `structlog`, `sentry-sdk`

```python
# 关键初始化顺序
structlog.configure(...)               # JSON 结构化日志
sentry_sdk.init(dsn=...) if DSN       # Sentry（DSN 为空则跳过）
limiter = Limiter(key_func=..., storage_uri=redis_url)  # Redis 限流器

app = FastAPI(lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(CORSMiddleware, allow_origins=[...])
```

**lifespan 上下文管理器**：
- 启动时：`Base.metadata.create_all`（自动建表）→ `get_agent()`（预热 LangGraph 图）
- 关闭时：`close_pool()` → `engine.dispose()`

**挂载的路由器（共 10 个）**：

| 路由前缀 | 模块 |
|---------|------|
| `/api/v1/agent` | agent.py |
| `/api/v1/auth` | auth.py |
| `/api/v1/goals` | goals.py |
| `/api/v1/checkin` | checkin.py |
| `/api/v1/debts` | debt.py |
| `/api/v1/tasks` | tasks.py |
| `/api/v1/plans` | plans.py |
| `/api/v1/knowledge` | knowledge.py |
| `/api/v1/notifications` | notifications.py |
| `/api/v1/schedule` | schedule.py |

---

### 1.2 `src/config.py` — Pydantic Settings

```python
class Settings(BaseSettings):
    database_url: str              # postgresql+asyncpg://...
    secret_key: str
    access_token_expire_days: int = 7
    openai_api_key: str            # 本地 mlx-lm 用 "local"
    openai_base_url: str           # 本地: http://localhost:8080/v1
    model_name: str
    smart_api_key: str             # DeepSeek API Key
    smart_base_url: str            # https://api.deepseek.com
    smart_model_name: str          # deepseek-chat
    redis_url: str = "redis://localhost:6379/0"
    tavily_api_key: str = ""
    smtp_host: str; smtp_port: int; smtp_user: str; smtp_password: str; smtp_from_name: str
    sentry_dsn: str = ""           # 空字符串 = 不启用

    model_config = {"env_file": ".env"}
```

---

### 1.3 `src/database.py` — 异步 PostgreSQL

```python
engine = create_async_engine(settings.database_url, pool_pre_ping=True)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

class Base(DeclarativeBase): pass

async def get_db():          # FastAPI 依赖注入
    async with AsyncSessionLocal() as session:
        yield session
```

**注意**：数据库是 **PostgreSQL 16**，驱动为 **asyncpg**，配合 **pgvector** 扩展提供向量检索。所有 ORM 操作均为异步（`await db.execute(...)`）。

---

### 1.4 `src/models.py` — 全量 ORM 模型（9 张表）

所有主键均为 UUID 字符串（`new_uuid()` 生成），创建时间由 `server_default=func.now()` 由数据库填充。

#### 表 1：`users`

| 字段 | 类型 | 约束 |
|------|------|------|
| `id` | String PK | UUID |
| `email` | String | UNIQUE, NOT NULL, INDEX |
| `username` | String | UNIQUE, NOT NULL |
| `hashed_password` | String | NOT NULL |
| `is_active` | Boolean | default=True |
| `created_at` | DateTime | server_default |

关系：→ `goals`（one-to-many, cascade delete）、→ `checkin_records`（one-to-many）

---

#### 表 2：`goals`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String PK | UUID |
| `user_id` | String FK→users | INDEX |
| `type` | String | `exam` / `certification` / `skill` |
| `title` | String | |
| `deadline` | String | YYYY-MM-DD |
| `daily_hours` | Float | default=2.0 |
| `current_level` | String | default=`beginner` |
| `status` | String | `active` / `completed` / `paused` / `abandoned` |
| `meta` | JSON | 扩展字段（work_schedule、kb_id 等） |
| `created_at` | DateTime | |

关系：→ `tasks`（cascade）、→ `checkin_records`（cascade）、→ `plans`（cascade）

---

#### 表 3：`plans`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String PK | |
| `goal_id` | String FK→goals | INDEX |
| `version` | Integer | default=1，重规划递增 |
| `is_current` | Boolean | default=True，同一目标仅一条 is_current=True |
| `baseline` | JSON | 原始计划快照（生成时存入，重规划时不覆盖） |
| `content` | JSON | 当前执行中的计划内容 |
| `replan_reason` | Text | 重规划触发原因 |
| `created_at` | DateTime | |

---

#### 表 4：`tasks`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String PK | |
| `goal_id` | String FK→goals | INDEX |
| `plan_id` | String FK→plans | nullable, INDEX |
| `title` | String | |
| `description` | Text | nullable |
| `estimated_mins` | Integer | default=30 |
| `actual_mins` | Integer | nullable |
| `status` | String | `pending` / `completed` / `partial` / `skipped` |
| `type` | String | `study` / `review` / `practice` |
| `kb_refs` | JSON | 关联知识条目 ID 列表 |
| `mastery_level` | String | `L1` / `L2` / `L3` / `unknown` |
| `priority` | String | `low` / `medium` / `high` |
| `scheduled_date` | String | YYYY-MM-DD, INDEX |
| `completed_at` | DateTime | nullable |
| `created_at` | DateTime | |

---

#### 表 5：`checkin_records`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String PK | |
| `goal_id` | String FK→goals | INDEX |
| `user_id` | String FK→users | INDEX |
| `date` | String | YYYY-MM-DD, INDEX |
| `mode` | String | `task_list` / `quick` / `daily` / `natural` |
| `quick_status` | String | `all_done` / `mostly_done` / `half_done` / `barely_done` / `explain` |
| `natural_text` | Text | nullable |
| `completion_rate` | Float | 0.0–1.0 |
| `stats` | JSON | 各模式汇总数据 |
| `feedback` | Text | AI 生成的当日反馈 |
| `replan_triggered` | Boolean | 是否触发重规划 |
| `created_at` | DateTime | |

---

#### 表 6：`knowledge_bases`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String PK | |
| `user_id` | String FK→users | INDEX |
| `name` | String | 知识库名称 |
| `description` | Text | default="" |
| `created_at` | DateTime | |

---

#### 表 7：`knowledge_items`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String PK | |
| `user_id` | String FK→users | INDEX |
| `goal_id` | String FK→goals | nullable, INDEX |
| `kb_id` | String FK→knowledge_bases | nullable, INDEX |
| `task_id` | String FK→tasks | nullable, INDEX |
| `title` | Text | |
| `content` | Text | 提取的全文（最多 50,000 字符） |
| `source_type` | String | `upload` / `url` / `search` / `system` |
| `source_url` | Text | nullable |
| `file_path` | Text | nullable，本地存储路径 |
| `tags` | JSON | 标签列表 |
| `embedding` | Vector(1536) | pgvector，用于余弦相似度搜索 |
| `created_at` | DateTime | |

---

#### 表 8：`daily_brief_caches`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String PK | |
| `user_id` | String FK→users(CASCADE) | INDEX |
| `date` | String | YYYY-MM-DD, INDEX |
| `content` | JSON | DailyBriefOut 序列化结果 |
| `is_read` | Boolean | default=False |
| `generated_by` | String | `celery` / `on_demand` |
| `generated_at` | DateTime | server_default |

唯一约束：`uq_daily_brief_cache_user_date`（user_id + date）

---

#### 表 9：`daily_schedules`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String PK | |
| `user_id` | String FK→users | INDEX |
| `date` | String | YYYY-MM-DD, INDEX |
| `blocks` | JSON | `ScheduleBlock[]` 时间块列表 |
| `updated_at` | DateTime | server_default + onupdate |

唯一约束：`uq_daily_schedule_user_date`（user_id + date）

---

#### 表 10：`learning_debts`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String PK | |
| `goal_id` | String FK→goals(CASCADE) | INDEX |
| `task_id` | String FK→tasks(SET NULL) | nullable, INDEX |
| `content` | Text | 债务描述（未完成的学习内容） |
| `estimated_hours` | Float | default=0.0 |
| `skip_reason` | Text | nullable |
| `impact` | String | `low` / `medium` / `high` |
| `status` | String | `open` / `resolved` |
| `created_at` | DateTime | |

> **注**：实际共 10 张表（models.py 中含上述全部），`learning_debts` 是第 10 张。

---

### 1.5 `src/deps.py` — JWT 依赖

```python
ALGORITHM = "HS256"

def create_access_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=settings.access_token_expire_days)
    return jwt.encode({"sub": user_id, "exp": expire}, settings.secret_key, algorithm=ALGORITHM)

async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    # 解码 JWT → 查询 User → 返回 User 对象
    # 失败时抛出 HTTP 401
```

---

### 1.6 `src/api/auth.py` — 认证路由

**Rate Limiting**：`/login` 端点附加 `@limiter.limit("10/minute")`（IP 维度，Redis 存储）。

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/api/v1/auth/register` | 注册，返回 JWT Token + UserOut |
| POST | `/api/v1/auth/login` | 登录（限流 10次/分钟），返回 JWT Token + UserOut |
| POST | `/api/v1/auth/logout` | 服务端登出（将 token jti 写入 Redis 黑名单），返回 204 |
| GET | `/api/v1/auth/me` | 获取当前用户信息 |
| PATCH | `/api/v1/auth/me` | 更新用户名/邮箱 |
| DELETE | `/api/v1/auth/me` | 注销账号（级联删除所有数据 + 本地文件） |
| POST | `/api/v1/auth/change-password` | 修改密码（需验证当前密码），成功返回 204 |
| POST | `/api/v1/auth/forgot-password` | 发送密码重置邮件（防枚举、限流 3次/小时） |
| POST | `/api/v1/auth/reset-password` | 凭重置 token 设置新密码 |

**登录流程**：
1. 按 email 查询用户
2. `passlib.CryptContext.verify(password, hashed_password)`
3. 检查 `is_active`
4. `create_access_token(user.id)` → 返回 token

**`POST /logout`**：

**作用**：服务端登出 — 将当前 Token 的 `jti` 写入 Redis 黑名单，使 Token 在7天有效期内立即失效。  
**无需请求体**：从 `Authorization: Bearer <token>` 读取 Token。  
**流程**：解码 JWT 提取 `jti` 和 `exp` → 计算剩余 TTL（`exp - now`）→ `redis.setex("bl:{jti}", ttl, "1")` → 返回 204 No Content。  
**幂等性**：Token 无效或已过期时同样返回 204，不报错。

---

**`POST /change-password`**：

```python
class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str
```

**作用**：已登录用户主动修改密码，需要先验证当前密码（防止会话被盗后静默改密）。  
**流程**：`verify(current_password, user.hashed_password)` → 失败抛 400 → `bcrypt.hash(new_password)` → 写回 `user.hashed_password` → 返回 204 No Content。

---

**`POST /forgot-password`**：

```python
class ForgotPasswordRequest(BaseModel):
    email: str
```

**作用**：用户忘记密码时触发邮件重置流程。  
**防枚举**：无论 email 是否存在，始终返回 `{"message": "如果该邮箱已注册，您将收到重置邮件"}`（200），不暴露账号是否存在。  
**限流**：`@limiter.limit("3/hour")`（IP 维度）。  
**流程**：查询 email → 若用户存在，生成随机 `reset_token`（32 bytes hex）+ 设置 `reset_token_expires_at = utcnow() + 1h` → 写入 `users` 表 → `aiosmtplib` 发送包含重置链接的邮件。

---

**`POST /reset-password`**：

```python
class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str
```

**作用**：用户点击邮件中的链接后，凭一次性 token 设置新密码。  
**流程**：按 `token` 查询用户 → 检查 `reset_token_expires_at > utcnow()`（过期返回 400）→ `bcrypt.hash(new_password)` 写入 → 清空 `reset_token` 和 `reset_token_expires_at`（token 一次性失效）→ 返回 200。

---

## 2. 数据库迁移（Alembic）

迁移链（按依赖顺序）：

```
f2c8d1e04a7b  ← 基础表（users/goals/tasks/checkin_records）
    ↓
a1b2c3d4e5f6  ← daily_brief_caches
    ↓
b4c5d6e7f8a9  ← pgvector 扩展 + knowledge_items.embedding
    ↓
c1d2e3f4a5b6  ← learning_debts + knowledge_bases + knowledge_items
    ↓
d2e3f4g5h6i7  ← daily_schedules + plans
```

执行迁移：
```bash
cd /Users/Admin/Desktop/PlanPilot/backend
alembic upgrade head
```

---

## 3. 环境配置（`.env`）

```env
DATABASE_URL=postgresql+asyncpg://planpilot:password@localhost:5432/planpilot
SECRET_KEY=planpilot-dev-secret-key-change-in-production-32chars
ACCESS_TOKEN_EXPIRE_DAYS=7

# 本地 mlx-lm（chat 回复）
OPENAI_API_KEY=local
OPENAI_BASE_URL=http://localhost:8080/v1
MODEL_NAME=/path/to/model

# DeepSeek（intent 路由 + planner）
SMART_API_KEY=sk-xxx
SMART_BASE_URL=https://api.deepseek.com
SMART_MODEL_NAME=deepseek-chat

# QQ 邮箱 SMTP
SMTP_HOST=smtp.qq.com
SMTP_PORT=587
SMTP_USER=xxx@qq.com
SMTP_PASSWORD=授权码

# Sentry（留空则不启用）
SENTRY_DSN=
```

---

## 4. Docker Compose 启动

```bash
cd /Users/Admin/Desktop/PlanPilot/backend
docker compose up -d
```

服务列表：

| 服务 | 说明 |
|------|------|
| `api` | FastAPI 主服务，port 8000 |
| `worker` | Celery Worker（daily_brief / deviation / reminder 任务） |
| `beat` | Celery Beat 定时调度 |
| `db` | PostgreSQL 16 + pgvector |
| `redis` | Redis 7（Celery Broker + slowapi 限流存储） |
