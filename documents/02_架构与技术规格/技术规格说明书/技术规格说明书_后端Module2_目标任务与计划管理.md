# 技术实现与架构说明书
## PlanPilot 后端 — Module 2：目标、任务与计划管理（2026-07-23）

---

## 0. 模块定位

Module 2 管理学习目标的全生命周期：创建目标、AI 生成宏观计划、按日分配任务、查询进度。涉及 `goals.py`、`tasks.py`、`plans.py` 三个路由文件和 `Goal / Plan / Task` 三张表。

---

## 1. API 路由总览

### 1.1 `src/api/goals.py` — 目标管理

前缀：`/api/v1/goals`，所有端点需要 JWT 认证。

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/` | 获取当前用户所有目标（按创建时间倒序） |
| POST | `/` | 创建目标（type/title/deadline/daily_hours/...） |
| GET | `/{goal_id}` | 获取单个目标详情 |
| PATCH | `/{goal_id}` | 更新目标字段（status/title/deadline/daily_hours/work_schedule/kb_id） |
| DELETE | `/{goal_id}?delete_kb=false` | 删除目标（级联删除 tasks/plans/checkins，可选删除关联知识库） |
| GET | `/{goal_id}/progress` | 获取目标进度统计 |
| GET | `/{goal_id}/tasks` | 获取目标下所有任务简要列表（id + title） |
| GET | `/{goal_id}/plan` | 获取当前计划（含阶段明细和任务列表） |

#### GoalCreate Schema（创建参数）

```python
class GoalCreate(BaseModel):
    type: str           # 见下方 GoalType 枚举
    title: str
    deadline: str       # YYYY-MM-DD（必须晚于今日）
    daily_hours: float  # 0.5–12
    current_level: str  # "beginner" | "intermediate" | "advanced"
    work_schedule: str  # "weekday" | "weekend" | "all"
    kb_id: str | None   # 关联已有知识库 ID
    meta: dict          # 额外字段（work_schedule/kb_id 会被提取到 meta 存储）
    pending_kb: PendingKb | None = None  # 与目标原子创建的新知识库
```

#### GoalType 枚举（2026-07-23 扩展至 6 类）

| 值 | 中文标签 | 典型场景 |
|----|---------|---------|
| `exam` | 备考 | 高考、考研、公务员、专升本等 |
| `certification` | 认证 | CPA、CFA、PMP、软考等 |
| `skill` | 技能 | 编程、设计、数据分析等 |
| `reading` | 阅读 | 读书计划、精读论文、主题阅读等 |
| `language` | 语言学习 | 英语、日语、法语等 |
| `habit` | 习惯养成 | 运动、冥想、写作、早起等 |

**版本变更说明（2026-07-23）**：原版本只有 `exam / certification / skill` 3 类，本次扩展至 6 类。新增类型对应不同的 AI 计划生成策略（详见 Module 5 § 3），前端 `GOAL_TYPES` 常量、`GoalType` TypeScript 类型定义、新建/编辑页面选择器均已同步更新。

**受影响的前端文件**：
- `frontend/lib/stores/goalStore.ts` — `GoalType` 类型定义
- `frontend/app/(dashboard)/dashboard/goals/new/page.tsx` — 创建页选择器
- `frontend/app/(dashboard)/dashboard/goals/[id]/edit/page.tsx` — 编辑页选择器
- `frontend/components/goal/PlanModeSelector.tsx` — 意图选项按类型分支

**PendingKb**（新建知识库并与目标原子绑定）：
```python
class PendingKb(BaseModel):
    name: str
    description: str = ""
```

**原子创建逻辑**：若请求携带 `pending_kb`，后端在同一 SQLAlchemy 事务中先 `db.add(kb)` + `db.flush()` 获取 `kb.id`，再创建 Goal 并写入 `kb_id`。任一步骤失败则整体回滚，不会出现"有知识库无目标"的孤立记录。

前端在 `goals/new/page.tsx` 中：用户点击「新建知识库」打开右侧抽屉，可在同一抽屉内填写名称、描述，并选择性上传文件、添加网址、写入笔记。目标提交后后端原子创建 Goal + KB，前端随即静默上传预收集的内容（`POST /api/v1/knowledge/upload`、`/url`、`/notes`），上传时只传 `goal_id`/`goal_ids`，**不传 `kb_id`**——内容直接归属目标，不进入「待分类」。完成后弹出生成计划确认。

#### ProgressOut Schema（进度统计）

```python
class ProgressOut(BaseModel):
    goal_id: str
    title: str
    deadline: str
    total_tasks: int
    completed_tasks: int
    avg_completion_rate: float    # 近7日平均，0.0–1.0
    streak_days: int              # 连续打卡天数（不含 natural 模式）
    debt_count: int               # 超期未完成任务数
    days_ahead_or_behind: int     # 正=超前，负=落后天数（线性外推）
    estimated_completion_date: str
```

**streak_days 计算逻辑**：从今天（或昨天，若今日未打卡）向前连续查找 `checkin_records`，`mode != "natural"` 才计入。

**days_ahead_or_behind 计算**：`已完成任务数 / 总任务数 = 进度率` → 线性外推至截止日，差值为正表示超前。

---

### 1.2 `src/api/tasks.py` — 任务管理

前缀：`/api/v1/tasks`，所有端点需要 JWT 认证。

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/?date=YYYY-MM-DD` | 查询任务列表（可按日期筛选） |
| POST | `/` | 手动创建任务 |
| PATCH | `/{task_id}` | 更新任务（title/done/estimatedMinutes/priority/mastery_level/date） |
| DELETE | `/{task_id}` | 删除任务 |

**TaskOut**（前端友好格式，字段命名使用驼峰）：

```python
class TaskOut(BaseModel):
    id: str
    title: str
    description: str | None
    goalId: str
    goalTitle: str        # JOIN goals.title 填充
    done: bool            # task.status == "completed"
    estimatedMinutes: int
    date: str             # scheduled_date
    priority: str
```

**PATCH 逻辑**：`done=True` → `status="completed"` + `completed_at=utcnow()`；`done=False` → `status="pending"` + `completed_at=None`。

---

### 1.3 `src/api/plans.py` — 今日任务查询

前缀：`/api/v1/plans`，所有端点需要 JWT 认证。

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/{goal_id}/today` | 获取今日任务列表 |

**今日任务逻辑**：
1. 优先返回 `scheduled_date == 今天` 的任务
2. 若今日无排期，则返回最近 5 个 `status == "pending"` 的任务（按日期+创建时间排序）

**TodayTaskOut**：

```python
class TodayTaskOut(BaseModel):
    id: str
    title: str
    estimated_mins: int
    status: str           # "pending" | "completed" | "partial" | "skipped"
    type: str             # "study" | "review" | "practice"
    kb_refs: list[str]    # 关联知识条目 ID
    mastery_level: str    # "L1" | "L2" | "L3" | "unknown"
```

---

## 2. 删除目标的级联逻辑

`DELETE /api/v1/goals/{goal_id}?delete_kb=false` 手动控制级联顺序，绕过 ORM 级联顺序问题：

```
1. 查询该目标下所有 task_id
2. 删除通过 task_id 关联的 KnowledgeItem（避免 FK 冲突）
3. 删除通过 goal_id 关联的 KnowledgeItem
4. （可选）删除关联的 KnowledgeBase 及其所有 items
5. 批量删除 Task（WHERE goal_id）
6. 批量删除 CheckinRecord（WHERE goal_id）
7. 批量删除 Plan（WHERE goal_id）
8. 删除 Goal 本身
```

---

## 3. `src/api/schedule.py` — 今日时间块

前缀：`/api/v1/schedule`，所有端点需要 JWT 认证。

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/today` | 获取今日时间块列表 |
| PUT | `/today` | 保存/更新今日时间块（upsert） |

**ScheduleBlock 结构**（存入 `daily_schedules.blocks` JSON 列）：

```python
class ScheduleBlock(BaseModel):
    id: str
    label: str
    taskId: str | None
    goalTitle: str | None
    startHour: float       # 如 9.0 = 09:00, 9.5 = 09:30
    durationMinutes: float
    color: str             # CSS 变量名或 hex
    progress: float        # 0.0–1.0，任务完成进度
```
