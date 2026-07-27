# 技术实现与架构说明书
## PlanPilot 后端 — Module 3：打卡、学习债务与定时任务（2026-07-21）

---

## 0. 模块定位

Module 3 管理用户每日打卡、学习债务累积与解决、邮件提醒。涉及 `checkin.py`、`debt.py`、`schedule.py`（时间块）和 Celery 定时任务。

---

## 1. API 路由总览

### 1.1 `src/api/checkin.py` — 每日打卡

前缀：`/api/v1/checkin`，所有端点需要 JWT 认证。

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/{goal_id}` | 提交打卡（支持 4 种模式） |

#### CheckinBody Schema（请求参数）

```python
class CheckinBody(BaseModel):
    mode: str    # "task_list" | "quick" | "daily" | "natural"
    tasks: list[TaskCheckin] = []         # daily/task_list 模式必填
    quick_status: str | None              # "all_done" | "mostly_done" | "half_done" | "barely_done" | "explain"
    text: str | None                      # natural 模式必填
    completion_rate: float | None         # daily 模式可直接指定（0.0–1.0）
```

**TaskCheckin**：

```python
class TaskCheckin(BaseModel):
    task_id: str
    status: str = "completed"    # "completed" | "partial" | "skipped"
    mastery: str | None          # "L1" | "L2" | "L3" | "L4"
    actual_mins: int | None
    note: str | None
```

#### CheckinResult Schema（响应）

```python
class CheckinResult(BaseModel):
    stats: CheckinStats           # completion_rate 为执行率，mastery_rate 为掌握度
    feedback: str                 # AI 生成的当日反馈文本
    debt_added: int = 0           # 新增学习债务条数
    replan_triggered: bool        # 连续 3 个计划学习日执行率 <60%
    tasks: list[TaskCheckin]      # 用于重新打开页面时回显逐项选择
```

#### 四种打卡模式

> **前端实现说明**：`CheckinForm.tsx` 当前仅实现 **daily 模式**（逐任务掌握度评估），作为专用打卡页 `/dashboard/checkin` 和首页仪表盘「今日打卡」Tab 的统一表单。`natural` 模式通过 Agent Chat 自然语言打卡触发，其余模式（task_list / quick）后端 API 已支持，前端暂未提供独立入口。

##### 1. **daily 模式**（详细逐项）——前端已实现

前端：`CheckinForm`，用户对每个任务选择 L1/L2/L3 掌握度 + 可选备注。

后端逻辑：
- `completion_rate` 根据任务 `status` 计算，表示任务执行率；
- `mastery_rate = (L3/L4数 + L2数×0.5) / 总数`，表示学习掌握度；
- 将每个任务的 `mastery_level` 写入 `tasks` 表
- L3/L4 → `status="completed"`；L2/L1 不会把未完成任务误判为完成；
- 生成反馈同时展示“任务执行率”和“学习掌握度”。
- 同一用户、目标、日期只保留一条记录；重复提交执行更新，并完整保存/回显每项掌握度和备注。
- 后端会校验任务属于当前目标，首页也只提交当前活动目标的今日任务，避免跨目标污染。

##### 2. **task_list 模式**（逐项勾选 done）——前端暂未实现独立入口

前端：API 已支持，可在目标详情页任务列表勾选 checkbox 时调用。

后端逻辑：
- 按 `status` 字段统计：`completed / partial / skipped`
- `completion_rate = (completed + partial×0.5) / total`
- `status="skipped"` 的任务创建 `LearningDebt` 记录：
  ```python
  debt = LearningDebt(
      goal_id=goal_id,
      task_id=t.task_id,
      content=task_obj.title,
      estimated_hours=round(task_obj.estimated_mins / 60, 2),
      skip_reason=t.note,
      impact="medium",
      status="open",
  )
  ```

##### 3. **quick 模式**（5 个快捷按钮）——前端暂未实现独立入口

前端：API 已支持，5 个快捷选项（全部完成 / 大部分完成 / 完成一半 / 基本没做 / 有情况说明）。

后端逻辑：
- 预设映射：`{"all_done": 1.0, "mostly_done": 0.75, "half_done": 0.5, "barely_done": 0.1, "explain": 0.0}`
- 直接返回预设反馈：「太棒了！全部完成，保持这个势头！」等
- 不更新任务状态

##### 4. **natural 模式**（自由文本）——通过 Agent Chat 触发

前端：用户在 Agent Chat 中输入打卡相关内容（如「今天完成了…」「学了两小时」），`identify_intent` 节点识别为 `checkin` intent，由 `checkin` 节点提取完成率并生成反馈；直接打卡页面不提供此入口。

后端逻辑：
- 关键词检测估算完成率（「全部完成」→1.0 / 「一半」→0.5 / 「没完成」→0.0，默认 0.5）
- 反馈固定文本：「已记录你的学习情况，AI 会在后续会话中结合这些信息为你优化计划。」
- 不更新任务状态

#### 重规划触发判定

打卡提交后自动判断：
```python
expected_dates = 最近三个符合 goal.work_schedule 的计划学习日
replan = all(
    当日存在打卡 and 当日任务执行率 < 0.6
    for 当日 in expected_dates
)
```

掌握度不参与触发判定。触发后只向用户提出建议，不自动修改计划；用户确认后调用
`POST /api/v1/agent/reschedule/{goal_id}`，在现有截止日期、每日容量和
`work_schedule` 约束下重新分配尚未完成的任务，不重新生成整份 AI 宏观计划。

打卡保存后仍会异步派发 Celery 偏差检测：
```python
from src.tasks.deviation import check_all_deviations
check_all_deviations.apply_async(countdown=5)
```

---

### 1.2 `src/api/debt.py` — 学习债务管理

前缀：`/api/v1/debts`，所有端点需要 JWT 认证。

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/{goal_id}` | 获取目标下所有未解决债务（status=="open"） |
| PATCH | `/{debt_id}/resolve` | 标记债务为已解决 |

**DebtOut**：

```python
class DebtOut(BaseModel):
    id: str
    goal_id: str
    task_id: str | None
    content: str               # 债务描述
    estimated_hours: float
    skip_reason: str | None
    impact: str                # "low" | "medium" | "high"
    status: str                # "open" | "resolved"
    created_at: str
```

---

## 2. Celery 定时任务

配置文件：`src/celery_app.py`

```python
from celery import Celery
from celery.schedules import crontab

celery_app = Celery(
    "planpilot",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["src.tasks.daily_brief", "src.tasks.deviation", "src.tasks.reminder"],
)

celery_app.conf.beat_schedule = {
    "generate-all-daily-briefs": {
        "task": "src.tasks.daily_brief.generate_all_daily_briefs",
        "schedule": crontab(hour=7, minute=30),    # 每天 7:30（Asia/Shanghai）
    },
    "check-all-deviations": {
        "task": "src.tasks.deviation.check_all_deviations",
        "schedule": crontab(hour=0, minute=5),     # 每天 0:05
    },
    "send-checkin-reminders": {
        "task": "src.tasks.reminder.send_checkin_reminders",
        "schedule": crontab(hour=23, minute=0),    # 每天 23:00
    },
}
```

### 2.1 `src/tasks/daily_brief.py` — 每日简报生成

**任务名称**：`generate_all_daily_briefs`  
**执行时间**：每天 7:30  
**职责**：
1. 筛选活跃用户（`is_active=True` + 近 7 天有打卡 + 有 active Goal）
2. 对每个用户生成每日简报（调用 `_build_daily_brief_for_user`）
3. 结果 UPSERT 到 `daily_brief_caches` 表（`generated_by="celery"`）

**简报内容**（`DailyBriefOut`）：

```python
class DailyBriefOut(BaseModel):
    summary: str              # LLM 生成的今日摘要
    goalReviews: list[GoalReview]
    insight: str              # 跨目标洞察
    recommendedAction: str    # 今日行动建议
```

**UPSERT 策略**：
```python
INSERT INTO daily_brief_caches (user_id, date, content, generated_by, ...)
VALUES (?, ?, ?, ?, ...)
ON CONFLICT (user_id, date) DO UPDATE SET
    content = EXCLUDED.content,
    generated_by = EXCLUDED.generated_by,
    generated_at = EXCLUDED.generated_at
-- is_read 不重置，保留原值
```

---

### 2.2 `src/tasks/deviation.py` — 偏差检测

**任务名称**：`check_all_deviations`  
**执行时间**：每天 0:05（凌晨）  
**职责**：
1. 查询所有活跃目标
2. 对每个目标读取近期结构化打卡记录，并按 `work_schedule` 还原最近三个计划学习日
3. 若这三个学习日的任务执行率均低于 60%，将目标标记为 `replan_needed`
4. 自然语言打卡和学习掌握度不参与自动判定，避免用模糊估算误触发计划变更

---

### 2.3 `src/tasks/reminder.py` — 打卡提醒

**任务名称**：`send_checkin_reminders`  
**执行时间**：每天 23:00  
**职责**：
1. 查询今日未打卡的用户（`CheckinRecord.date != 今天`）
2. 通过 `aiosmtplib` 发送邮件提醒（SMTP_HOST / SMTP_USER / SMTP_PASSWORD 配置在 `.env`）

**邮件模板**：
```
主题：PlanPilot 每日打卡提醒
正文：
您今天还没有打卡哦！
目标：{goal.title}
截止日期：{goal.deadline}

立即打卡：https://planpilot.example.com/dashboard/checkin?goalId={goal.id}
```

---

## 3. 启动 Celery

```bash
# Worker（处理任务）
celery -A src.celery_app.celery_app worker --loglevel=info

# Beat（定时调度）
celery -A src.celery_app.celery_app beat --loglevel=info
```

Docker Compose 中已配置 `worker` 和 `beat` 服务。
