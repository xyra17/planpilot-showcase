# Phase 2B-1: Learning Event Schema 设计文档

> **文档状态**: 已实现 (Phase 2B-2)  
> **创建时间**: 2026-07-29  
> **实现版本**: 迁移 r2s3t4u5v6w7

---

## 1. 背景与目标

### 1.1 为什么需要 Learning Events?

**当前问题**:
- 业务逻辑分散在 router 中，难以复用和测试
- 没有统一的用户行为记录机制
- AI Agent 需要理解用户学习历程，但缺少结构化的事件流
- 未来需要实现学习分析、个性化推荐、进度预测等功能

**目标**:
1. **解耦**: 将事件记录与业务逻辑分离
2. **可观测**: 提供完整的用户行为审计日志
3. **AI 就绪**: 为 Intelligence Layer (Phase 2C) 提供数据基础
4. **演进友好**: 支持 payload schema 版本管理

---

## 2. 表结构设计

### 2.1 learning_events 表

```sql
CREATE TABLE learning_events (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id           UUID NULL REFERENCES goals(id) ON DELETE SET NULL,
    
    -- Event Identity
    aggregate_type    VARCHAR(50) NOT NULL,  -- "goal" | "task" | "plan" | "checkin"
    aggregate_id      VARCHAR(255) NOT NULL, -- 实体 ID
    event_type        VARCHAR(100) NOT NULL, -- "TaskCompleted" | "GoalCreated" 等
    
    -- Event Metadata
    source            VARCHAR(50) DEFAULT 'user_action', -- "user_action" | "ai_agent" | "system"
    payload           JSONB NOT NULL DEFAULT '{}',
    occurred_at       TIMESTAMP NOT NULL,    -- 业务时间（非写入时间）
    created_at        TIMESTAMP DEFAULT NOW(),
    version           INT DEFAULT 1          -- Payload schema 版本
);

-- 索引策略
CREATE INDEX idx_learning_events_user_id ON learning_events(user_id);
CREATE INDEX idx_learning_events_goal_id ON learning_events(goal_id);
CREATE INDEX idx_learning_events_event_type ON learning_events(event_type);
CREATE INDEX idx_learning_events_user_timeline ON learning_events(user_id, occurred_at);
CREATE INDEX idx_learning_events_goal_type ON learning_events(goal_id, event_type);
CREATE INDEX idx_learning_events_aggregate ON learning_events(aggregate_type, aggregate_id);
CREATE INDEX idx_learning_events_event_type_time ON learning_events(event_type, occurred_at);
```

### 2.2 设计原则

**Append-Only Log**:
- 事件永不修改或删除（除 CASCADE）
- `occurred_at` 记录业务时间，`created_at` 记录写入时间
- 支持事件溯源和审计

**Self-Contained Payload**:
- 每个事件的 payload 包含完整上下文，无需 JOIN
- 避免因关联实体删除导致信息丢失
- 例：`TaskCompleted` 包含 `title`、`scheduled_date` 等快照数据

**Schema Versioning**:
- `version` 字段支持 payload 结构演进
- Consumer 根据 version 解析不同格式
- 向后兼容：新 Consumer 支持旧 version

---

## 3. Event Types 定义

### 3.1 Goal Events

#### GoalCreated
**触发时机**: 用户创建新目标  
**aggregate_type**: `"goal"`  
**aggregate_id**: `goal.id`

```json
{
  "title": "学 Python",
  "type": "skill",
  "deadline": "2027-12-31",
  "daily_hours": 2.0,
  "current_level": "beginner",
  "work_schedule": "all",
  "knowledge_base_id": "kb-uuid-xxx"
}
```

#### GoalStatusChanged
**触发时机**: 目标状态变更（active → paused, completed, abandoned）  
**aggregate_type**: `"goal"`

```json
{
  "from_status": "active",
  "to_status": "paused"
}
```

#### GoalUpdated
**触发时机**: 目标非状态字段变更（title, deadline, daily_hours 等）  
**aggregate_type**: `"goal"`

```json
{
  "changed_fields": ["title", "daily_hours"],
  "before": {
    "title": "学Python基础",
    "daily_hours": 2.0
  },
  "after": {
    "title": "深入学习Python",
    "daily_hours": 3.0
  }
}
```

---

### 3.2 Task Events

#### TaskCreated
**触发时机**: 用户或 Agent 创建任务  
**aggregate_type**: `"task"`

```json
{
  "title": "学习变量与数据类型",
  "scheduled_date": "2026-07-30",
  "estimated_mins": 60,
  "priority": "high",
  "plan_id": "plan-uuid-xxx",
  "stage_label": "第一阶段：基础语法"
}
```

#### TaskCompleted
**触发时机**: 任务标记为完成  
**aggregate_type**: `"task"`

```json
{
  "title": "学习变量与数据类型",
  "scheduled_date": "2026-07-30",
  "completed_at": "2026-07-30T14:35:00Z",
  "actual_mins": 75,
  "mastery_level": "L2",
  "days_overdue": 0
}
```

#### TaskRescheduled
**触发时机**: 任务改期  
**aggregate_type**: `"task"`

```json
{
  "title": "学习变量与数据类型",
  "from_date": "2026-07-30",
  "to_date": "2026-07-31",
  "trigger": "user_manual"  // "user_manual" | "ai_auto_adjust" | "debt_rollover"
}
```

#### TaskSkipped
**触发时机**: 打卡时跳过任务  
**aggregate_type**: `"task"`

```json
{
  "title": "刷100道算法题",
  "scheduled_date": "2026-07-30",
  "skip_reason": "时间不足，明天补",
  "debt_created": true
}
```

---

### 3.3 Plan Events

#### PlanGenerated
**触发时机**: AI Agent 生成新学习计划  
**aggregate_type**: `"plan"`

```json
{
  "plan_id": "plan-uuid-xxx",
  "version": 1,
  "phase_count": 3,
  "total_tasks": 45,
  "generation_model": "deepseek-r1-distill-llama-70b",
  "generation_tokens": 8500
}
```

#### PlanActivated
**触发时机**: 用户激活新计划  
**aggregate_type**: `"plan"`

```json
{
  "plan_id": "plan-uuid-xxx",
  "version": 2,
  "previous_plan_id": "plan-uuid-old"
}
```

---

### 3.4 Checkin Events

#### CheckinSubmitted
**触发时机**: 用户提交每日打卡  
**aggregate_type**: `"checkin"`  
**aggregate_id**: `"{goal_id}:{date}"` (复合 ID)

```json
{
  "date": "2026-07-30",
  "mode": "task_list",  // "task_list" | "natural" | "quick"
  "completion_rate": 0.75,
  "mastery_rate": 0.6,
  "total_tasks": 4,
  "completed_count": 3,
  "time_investment_mins": 180,
  "reflection": "今天状态不错，算法部分有突破"
}
```

#### MasteryRecorded
**触发时机**: 用户更新掌握度  
**aggregate_type**: `"task"`

```json
{
  "task_title": "递归算法实战",
  "from_level": "unknown",
  "to_level": "L3",
  "submission_mode": "checkin_update"  // "checkin_update" | "manual_update"
}
```

---

## 4. 发布机制设计

### 4.1 Option A: In-Transaction Write (✅ 选用)

**实现方式**:
```python
# src/events/publisher.py
async def emit(
    db: AsyncSession,
    *,
    user_id: str,
    goal_id: str | None,
    aggregate_type: str,
    aggregate_id: str,
    event_type: str,
    payload: dict[str, Any],
    source: str = "user_action",
    occurred_at: datetime | None = None,
    version: int = 1,
) -> None:
    """将 LearningEvent 写入 DB（不 commit）
    
    调用方持有事务，保证 event 与 domain change 原子落库。
    """
    db.add(LearningEvent(
        user_id=user_id,
        goal_id=goal_id,
        aggregate_type=aggregate_type,
        aggregate_id=aggregate_id,
        event_type=event_type,
        source=source,
        payload=payload,
        occurred_at=occurred_at or datetime.utcnow(),
        version=version,
    ))
    # 不调用 db.commit()，由 caller 统一 commit
```

**优势**:
- **ACID 保证**: 事件与业务变更在同一事务，不会出现不一致
- **实现简单**: 无需额外消息队列或异步任务
- **延迟低**: 写入立即可查

**劣势**:
- 事件写入失败会回滚业务操作（可接受，事件即审计日志）
- 无法异步解耦（Phase 2C 可引入 Outbox Pattern）

---

### 4.2 Option B: Outbox Pattern (Phase 2C 考虑)

**实现方式**:
1. 事件先写入 `outbox` 表（同事务）
2. 后台 Worker 轮询 outbox，发送到消息队列
3. Consumer 从队列消费，写入 `learning_events`

**优势**:
- 业务操作与事件消费完全解耦
- 支持重试、削峰、异步处理

**劣势**:
- 复杂度显著增加
- 事件可见性有延迟
- 需要 Redis/RabbitMQ 等基础设施

**Phase 2B 不采用**: 当前无异步需求，保持简单。

---

## 5. Service Layer 集成点

### 5.1 TaskService

```python
# src/services/task_service.py

async def create_task(...) -> TaskOut:
    task = Task(...)
    db.add(task)
    await emit(db,
        user_id=user_id, goal_id=body.goalId,
        aggregate_type="task", aggregate_id=task.id,
        event_type="TaskCreated",
        payload={"title": body.title, "scheduled_date": body.date, ...}
    )
    await db.commit()  # 原子 commit: task + event
    return _to_out(task, goal.title)

async def update_task(...) -> TaskOut | None:
    # ... apply patch ...
    
    if "done" in changed_fields and body.done:
        await emit(db,
            event_type="TaskCompleted",
            payload={"title": task.title, "completed_at": ..., "days_overdue": ...}
        )
    
    if "date" in changed_fields:
        await emit(db,
            event_type="TaskRescheduled",
            payload={"from_date": old_date, "to_date": task.scheduled_date, ...}
        )
    
    await db.commit()  # 原子 commit: task update + events
```

### 5.2 GoalService

```python
# src/services/goal_service.py

async def create_goal(...) -> Goal:
    goal = Goal(...)
    db.add(goal)
    await db.flush()  # ⚠️ 必须：触发 INSERT 使 goal.id 可用
    await emit(db,
        event_type="GoalCreated",
        payload={"title": body.title, "type": body.type, ...}
    )
    await db.commit()
    return goal

async def update_goal(...) -> Goal | None:
    # 捕获旧值
    old_values = {field: getattr(goal, field) for field in patch_data.keys()}
    
    # 应用变更
    changed_fields = _apply_goal_patch(goal, body)
    
    # 分别发布事件
    if "status" in changed_fields:
        await emit(db,
            event_type="GoalStatusChanged",
            payload={"from_status": old_values["status"], "to_status": goal.status}
        )
    
    other_fields = changed_fields - {"status"}
    if other_fields:
        await emit(db,
            event_type="GoalUpdated",
            payload={
                "changed_fields": list(other_fields),
                "before": {k: old_values[k] for k in other_fields},
                "after": {k: getattr(goal, k) for k in other_fields}
            }
        )
    
    await db.commit()
```

### 5.3 CheckinService

```python
# src/services/checkin_service.py

async def submit(...) -> CheckinResult:
    # ... 计算 stats ...
    
    await emit(db,
        aggregate_type="checkin",
        aggregate_id=f"{goal.id}:{today}",
        event_type="CheckinSubmitted",
        payload={
            "date": today,
            "mode": body.mode,
            "completion_rate": result.completion_rate,
            ...
        }
    )
    
    # task_list mode: 为 skipped tasks 发布事件
    if body.mode == "task_list":
        for t in body.tasks:
            if t.status == "skipped":
                await emit(db,
                    aggregate_type="task",
                    aggregate_id=task_obj.id,
                    event_type="TaskSkipped",
                    payload={"title": task_obj.title, "skip_reason": t.note, ...}
                )
    
    await db.commit()
```

---

## 6. 测试策略

### 6.1 集成测试清单

```python
# tests/test_learning_events.py

async def test_create_goal_emits_goal_created(client, auth, db):
    """验证创建目标时发布 GoalCreated 事件"""
    # POST /api/v1/goals
    # 断言 learning_events 表中有对应事件
    # 验证 payload 包含 title, type 等字段

async def test_complete_task_emits_task_completed(client, auth, goal_id, db):
    """验证完成任务时发布 TaskCompleted 事件"""
    # PATCH /api/v1/tasks/{id} {"done": true}
    # 断言事件存在且 payload 正确

async def test_checkin_submit_emits_checkin_submitted(client, auth, goal_id, db):
    """验证提交打卡时发布 CheckinSubmitted 事件"""
    # POST /api/v1/checkin/{goal_id}
    # 断言事件包含 completion_rate, total_tasks 等统计

# ... 共 9 个测试覆盖所有 Phase 2B-2 事件类型（PlanGenerated/PlanActivated 留给 Phase 2C）
```

### 6.2 测试原则

1. **原子性验证**: 事件与 domain change 在同一事务
2. **Payload 完整性**: 验证 payload 包含所需字段
3. **Self-Contained**: 测试无需 JOIN，仅查 learning_events 表
4. **时间顺序**: 验证 occurred_at 反映业务时间

---

## 7. Phase 2C 演进路径

### 7.1 Intelligence Layer 消费

```python
# src/intelligence/analyzer.py

async def analyze_learning_pattern(user_id: str, goal_id: str) -> Pattern:
    """基于事件流分析学习模式"""
    events = await db.execute(
        select(LearningEvent)
        .where(
            LearningEvent.user_id == user_id,
            LearningEvent.goal_id == goal_id,
            LearningEvent.occurred_at >= last_30_days
        )
        .order_by(LearningEvent.occurred_at)
    )
    
    # 分析 CheckinSubmitted 事件的时间分布
    # 识别 TaskRescheduled 的高频时段
    # 基于 MasteryRecorded 评估学习效率
    ...
```

### 7.2 实时推荐

```python
async def suggest_next_action(user_id: str, goal_id: str) -> Action:
    """根据最近事件推荐下一步行动"""
    recent_events = await get_recent_events(user_id, goal_id, hours=24)
    
    # 若连续 3 天无 CheckinSubmitted → 推送提醒
    # 若 TaskSkipped 频繁 → 建议调整 daily_hours
    # 若 MasteryRecorded 全是 L1 → 推荐降低难度
    ...
```

---

## 8. 实现检查清单

- [x] `models.py` 添加 `LearningEvent` 模型
- [x] Alembic 迁移脚本创建表和索引
- [x] `src/events/publisher.py` 实现 `emit()` 函数
- [x] TaskService 集成 4 种事件
- [x] GoalService 集成 3 种事件
- [x] CheckinService 集成 2 种事件
- [x] `tests/test_learning_events.py` 集成测试（9 个）
- [x] 测试验证通过（9/9，SQLite in-memory）

---

## 9. 实现问题与修复记录

### Bug 1：重复索引名冲突

**发现时机**: 运行测试时  
**错误信息**: `sqlite3.OperationalError: index ix_learning_events_event_type already exists`

**原因**: `event_type` 字段同时设置了 `index=True`（自动生成单列索引）和 `__table_args__` 中的同名复合索引：

```python
# ❌ 错误写法
event_type: Mapped[str] = mapped_column(String, nullable=False, index=True)

__table_args__ = (
    Index("ix_learning_events_event_type", "event_type", "occurred_at"),  # 同名！
)
```

SQLAlchemy 会生成两条同名 CREATE INDEX，SQLite 报冲突。

**修复**: 去掉 `index=True`，保留 `__table_args__` 中的复合索引：

```python
# ✅ 正确写法
event_type: Mapped[str] = mapped_column(String, nullable=False)  # 不设 index=True

__table_args__ = (
    Index("ix_learning_events_event_type", "event_type", "occurred_at"),
)
```

**通用规则**: 若 `__table_args__` 中已有涵盖某列的索引，该列的 `mapped_column` 不能再设 `index=True`。

---

### Bug 2：`goal.id` 在 emit() 时为 None

**发现时机**: `test_create_goal_emits_goal_created` 失败  
**错误信息**: `NOT NULL constraint failed: learning_events.aggregate_id`

**原因**: SQLAlchemy `default=new_uuid` 是 INSERT 时调用，不是对象构造时赋值。`db.add(goal)` 之后，`goal.id` 仍为 `None`，直到 `flush()` 或 `commit()` 执行 INSERT 后才有值：

```python
# ❌ 错误写法
goal = Goal(...)   # goal.id 是 None
db.add(goal)
await emit(db, aggregate_id=goal.id, ...)  # 传入了 None → 报 NOT NULL 错误
await db.commit()
```

**修复**: 在 `emit()` 之前调用 `await db.flush()` 强制执行 INSERT，令 `goal.id` 可用：

```python
# ✅ 正确写法
goal = Goal(...)
db.add(goal)
await db.flush()              # INSERT 执行，goal.id 被赋值
await emit(db, aggregate_id=goal.id, ...)  # 正常
await db.commit()
```

**替代方案**: 像 `TaskService` 那样在构造时明确指定 id：

```python
goal = Goal(id=new_uuid(), ...)  # id 立即可用，无需 flush
```

**通用规则**: 凡是在 `db.commit()` 前需要引用 ORM 对象的 `id`，必须先 `flush()`，或在构造时手动赋值。

---

## 10. 参考资料

- **Event Sourcing Pattern**: Martin Fowler
- **Outbox Pattern**: Chris Richardson (Microservices Patterns)
- **JSONB 索引优化**: PostgreSQL Documentation
- **Payload Versioning**: Schema Evolution Best Practices
