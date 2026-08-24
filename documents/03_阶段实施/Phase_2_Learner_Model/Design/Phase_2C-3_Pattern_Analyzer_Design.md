# Phase 2C-3: Pattern Analyzer Architecture Design

> **文档状态**: 设计稿 V1（待确认后进入实现）
> **创建时间**: 2026-07-29
> **前置阶段**: Phase 2C-2（三张表已落库：learner_profiles / learner_patterns / pattern_evidences）
> **本阶段范围**: 纯设计分析，不修改任何代码

---

## 目录

1. 架构概览与设计动机
2. Event Processor 职责设计
3. Extraction Rule Schema 设计
4. 第一批 Extraction Rule 完整定义（9条）
5. Pattern Update Engine
   - 5.1 confidence 公式（完整）
   - 5.2 Lifecycle 状态机
   - 5.3 各 Pattern decay_rate 配置
6. Scope Resolution（三级 fallback 查询）
7. Event Processing 完整生命周期
8. 与 Agent Decision Loop 接口
9. 测试策略
10. 实现顺序建议
11. 遗留问题与设计决策

---

## 1. 架构概览与设计动机

### 1.1 中间层问题

Phase 2C-2 完成后，存储层已就绪：

```
learning_events（已实现）
        ↓
???（空白）
        ↓
learner_patterns（已实现）
        ↓
Agent Decision Loop（待实现）
```

这个 `???` 就是 Pattern Analyzer，它是整个长期学习 Agent 的核心。

### 1.2 为什么不能直接硬编码

最直觉的实现：

```python
async def process_event(db, event):
    if event.event_type == "TaskCompleted":
        await update_preferred_time(db, event)
        await update_session_length(db, event)
        await update_completion_trend(db, event)
        # ...
    elif event.event_type == "TaskSkipped":
        await update_distraction_pattern(db, event)
        # ...
```

**问题**：
- 每增加一种新 Pattern，需要修改 dispatcher 逻辑（违反开闭原则）
- 每增加一种新事件类型，需要在多处插入逻辑
- Pattern 的 evidence_weight 散落在代码各处，无法统一审查
- 无法从外部声明"这个事件影响哪些 Pattern"，只能读代码才知道

### 1.3 Rule-based 架构目标

```
learning_events
        ↓
EventDispatcher（按 event_type 路由）
        ↓
ExtractionRule（YAML/dataclass 声明式配置，每条 Rule = 规则表中一行）
        ├─ condition_check()    过滤不符合条件的事件
        ├─ extract_features()  从事件 payload 提取特征 → evidence.meta
        └─ get_contribution()  计算该证据的贡献值
        ↓
PatternUpdateEngine
        ├─ upsert_pattern()    找到或创建 LearnerPattern
        ├─ append_evidence()   写入 PatternEvidence（append-only，幂等）
        ├─ update_confidence() 应用 confidence 公式
        └─ run_lifecycle()     检查并执行 status 状态转换
```

**核心收益**：
- 新增 Pattern 类型 = 新增一个 Rule 配置对象，**不修改任何现有代码**
- 新增事件类型 = 新增 Rule 并注册到 Registry，**不修改 Dispatcher**
- 所有 evidence_weight 集中在 Rule 定义中，一处可审查

---

## 2. Event Processor 职责设计

### 2.1 职责边界（做什么 / 不做什么）

**负责**：

| 职责 | 说明 |
|------|------|
| 接收 LearningEvent | 轮询 `learning_events` 表，维护游标（`last_processed_at`） |
| 事件过滤 | 跳过不触发任何 Rule 的事件类型（`GoalCreated` / `TaskCreated` 等） |
| Rule 匹配 | 从 RuleRegistry 查找当前 event_type 对应的 Rule 列表 |
| 条件检查 | 对每条 Rule 执行 `condition_check(event)` |
| 特征提取 | 调用 `rule.extract_features(event, db)` → `evidence.meta` |
| Evidence 写入 | 向 `pattern_evidences` 追加记录（append-only，幂等） |
| Pattern 更新 | 调用 PatternUpdateEngine 更新 confidence + evidence_count |
| 状态转换 | 调用 Lifecycle 状态机检查是否需要 status 变更 |
| 游标推进 | 批次处理完成后更新游标时间戳 |

**不负责**：

| 不做 | 原因 |
|------|------|
| Agent 决策 | Agent 是独立层，读取 Pattern 后独立推理 |
| 生成建议 | 任何 Proposal 均由 Agent Decision Loop 生成 |
| 修改 Goal / Task / Plan | 应用逻辑不在 Intelligence Layer |
| LearnerProfile 重算 | Profile 由独立的 ProfileBuilder 负责（Phase 2C-4，批处理） |
| 直接响应用户请求 | Processor 是后台异步任务，不在请求路径上 |

### 2.2 主循环伪代码

```python
async def run_batch(db: AsyncSession, batch_size: int = 100) -> int:
    """处理一批新事件。返回本批处理的事件数。"""

    # 1. 读取游标
    cursor = await get_cursor(db)  # 返回 datetime

    # 2. 查询新事件（用 created_at 而非 occurred_at，保证单调递增）
    events = await db.execute(
        select(LearningEvent)
        .where(LearningEvent.created_at > cursor)
        .order_by(LearningEvent.created_at.asc())
        .limit(batch_size)
    )

    processed = 0
    new_cursor = cursor

    for event in events.scalars():
        # 3. 从 RuleRegistry 查找 Rule 列表
        rules = RuleRegistry.get_rules(event.event_type)
        if not rules:
            new_cursor = event.created_at
            continue  # 快速路径：无 Rule 的事件类型直接跳过

        # 4. 逐 Rule 处理（可改为并行）
        for rule in rules:
            if not rule.condition_check(event):
                continue
            features = await rule.extract_features(event, db)
            await PatternUpdateEngine.process(db, event, rule, features)

        new_cursor = event.created_at
        processed += 1

    # 5. 推进游标（批次级，不是逐事件）
    if new_cursor != cursor:
        await update_cursor(db, new_cursor)

    await db.commit()
    return processed
```

### 2.3 游标存储

游标持久化在 DB 中，避免重启后重处理历史事件：

```sql
-- 极简实现：复用现有 DB，无需新表
-- 存储键值对：key="learner_model_cursor", value=ISO-8601 string
-- Phase 2C-3 用一个简单的 processor_cursors 表
CREATE TABLE processor_cursors (
    key        VARCHAR(100) PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

**为什么用 `created_at` 而非 `occurred_at` 做游标？**

`occurred_at` 是业务时间，补录历史数据时可能乱序（比如用户手动导入一年前的学习记录）。
`created_at` 是 DB 写入时间，严格单调递增，游标安全。

---

## 3. Extraction Rule Schema 设计

### 3.1 Rule Dataclass

```python
from dataclasses import dataclass, field
from typing import Literal, Any

@dataclass
class ExtractionRule:
    rule_id: str
    # 唯一标识，命名格式："{event_type}_to_{pattern_type}[_{variant}]"
    # 示例："task_completed_to_preferred_time"
    #        "checkin_submitted_to_session_length"   （同 pattern，不同来源）

    source_event_type: str
    # 触发此 Rule 的 LearningEvent.event_type
    # 必须与已实现的事件类型完全匹配（大小写敏感）

    condition: str | None
    # Python 表达式（在 payload dict 上下文中求值）
    # None = 无条件，所有此类事件均触发
    # 示例："payload.get('actual_mins', 0) > 0"

    target_pattern_type: str
    # 目标 LearnerPattern.pattern_type

    target_scope: Literal["user", "skill_category", "goal"]
    # Pattern 所在 scope 层级（决定 upsert 时的查询 key）

    base_contribution: float
    # 0.0–1.0，单次 evidence 的基础权重

    reliability: float
    # 0.0–1.0，数据来源可靠性
    # 客观系统数据 = 0.9（actual_mins, occurred_at）
    # 系统推算值   = 0.8（days_overdue, debt_created）
    # 用户自填数据 = 0.6（time_investment_mins, reflection）

    requires_db_join: bool = False
    # True：extract_features 需要查询其他表（如 tasks.estimated_mins）
    # False：所有特征来自 event.payload 和 event.occurred_at

    description: str = ""
    # 人类可读说明

    # ── 运行时派生 ─────────────────────────────────────────────────────────
    @property
    def contribution(self) -> float:
        """单次 evidence 的实际贡献量。"""
        return self.base_contribution * self.reliability

    def condition_check(self, event: "LearningEvent") -> bool:
        """检查事件是否满足此 Rule 的前置条件。"""
        if self.condition is None:
            return True
        try:
            payload = event.payload or {}
            return bool(eval(self.condition, {"payload": payload, "event": event}))
        except Exception:
            return False  # 条件求值失败 → 跳过，不抛出
```

### 3.2 FeatureExtractor 注册

特征提取逻辑与 Rule 定义分离（Rule 是纯数据，Extractor 是函数）：

```python
# extraction_rules/_registry.py

from typing import Callable, Awaitable, Any, TYPE_CHECKING

if TYPE_CHECKING:
    from src.models import LearningEvent
    from sqlalchemy.ext.asyncio import AsyncSession

ExtractorFn = Callable[
    ["LearningEvent", "AsyncSession"],
    Awaitable[dict[str, Any]]
]

_extractors: dict[str, ExtractorFn] = {}

def register_extractor(rule_id: str):
    """装饰器：将异步函数注册为指定 rule_id 的特征提取器。"""
    def decorator(fn: ExtractorFn) -> ExtractorFn:
        _extractors[rule_id] = fn
        return fn
    return decorator

async def run_extractor(
    rule_id: str,
    event: "LearningEvent",
    db: "AsyncSession",
) -> dict[str, Any]:
    extractor = _extractors.get(rule_id)
    if extractor is None:
        raise NotImplementedError(f"No extractor registered for rule_id={rule_id!r}")
    return await extractor(event, db)
```

### 3.3 可靠性等级说明

| 等级 | reliability 值 | 适用数据 |
|------|---------------|---------|
| 客观 | 0.9 | `actual_mins`（任务完成时系统记录）、`occurred_at`（DB时间戳）、`days_overdue`（系统计算） |
| 推算 | 0.8 | `mastery_level`（用户评分，有主观成分）、`debt_created`（系统标记） |
| 填报 | 0.6 | `time_investment_mins`（用户自填，估算性质）、`completion_rate`（打卡时填写） |

---

## 4. 第一批 Extraction Rule 完整定义（9条）

以下按 Phase 2C-1 §6.1 规则表，从20条规则中选取**可立即实现**（不依赖 JOIN 或依赖简单 JOIN）的第一批9条。

### 4.1 Habit 类（4条）

---

#### Rule H-1: `task_completed_to_preferred_time`

```yaml
rule_id: task_completed_to_preferred_time
source_event_type: TaskCompleted
condition: null              # 所有 TaskCompleted 均触发
target_pattern_type: preferred_learning_time
target_scope: user           # 时间偏好是跨目标的全局规律
base_contribution: 1.0
reliability: 0.9             # occurred_at 是客观 DB 时间戳
requires_db_join: false

feature_extractor:
  extracted_hour:    event.occurred_at.hour
  weekday:           event.occurred_at.strftime("%A")    # "Monday"–"Sunday"
  mastery_level:     event.payload.get("mastery_level")  # 辅助字段，供 focus_peak_time 复用

description: |
  TaskCompleted 的完成时间 → preferred_learning_time。
  `occurred_at.hour` 反映用户选择在什么时间标记完成，
  与实际学习时段有强相关性。
```

**pattern_value 更新逻辑**（PatternUpdateEngine 调用）：

```python
# 统计 peak_hours：取近50条 evidence 的 extracted_hour，取出现次数 top-3
# 详见 §5
```

---

#### Rule H-2: `task_completed_to_session_length`

```yaml
rule_id: task_completed_to_session_length
source_event_type: TaskCompleted
condition: "payload.get('actual_mins', 0) > 0"
target_pattern_type: preferred_session_length
target_scope: user
base_contribution: 1.0
reliability: 0.9
requires_db_join: false

feature_extractor:
  session_mins: event.payload["actual_mins"]

description: |
  TaskCompleted.actual_mins → preferred_session_length（主要数据源）。
  actual_mins 是系统记录的客观完成时长，reliability=0.9。
```

---

#### Rule H-3: `checkin_submitted_to_session_length`

```yaml
rule_id: checkin_submitted_to_session_length
source_event_type: CheckinSubmitted
condition: "payload.get('completed_count', 0) > 0"
target_pattern_type: preferred_session_length
target_scope: user
base_contribution: 0.7       # 低于 H-2，打卡数据主观性更强
reliability: 0.6             # 用户自填
requires_db_join: false

feature_extractor:
  session_mins: >
    payload["time_investment_mins"] / payload["completed_count"]
    # 平均每任务时长，是对 actual_mins 的粗估

description: |
  CheckinSubmitted 的每任务平均时长 → preferred_session_length（辅助数据源）。
  可靠性低于 task_completed，因为 time_investment_mins 是用户自填估算。
```

---

#### Rule H-4: `checkin_submitted_to_weekly_frequency`

```yaml
rule_id: checkin_submitted_to_weekly_frequency
source_event_type: CheckinSubmitted
condition: null
target_pattern_type: weekly_learning_frequency
target_scope: user
base_contribution: 1.0
reliability: 0.9             # CheckinSubmitted 表示当天确实学习了
requires_db_join: false

feature_extractor:
  date:    event.payload["date"]          # "2026-07-29"
  weekday: event.occurred_at.strftime("%A")

description: |
  每次打卡 = 当天活跃学习。
  pattern_value.preferred_days 统计各 weekday 的打卡频率，
  avg_days_per_week 用滑动窗口（28天）计算。
```

---

### 4.2 Performance 类（2条）

---

#### Rule P-1: `checkin_submitted_to_completion_trend`

```yaml
rule_id: checkin_submitted_to_completion_trend
source_event_type: CheckinSubmitted
condition: "payload.get('completion_rate') is not None"
target_pattern_type: completion_rate_trend
target_scope: goal           # 完成率与具体目标相关
base_contribution: 1.0
reliability: 0.8             # completion_rate 是系统计算值
requires_db_join: false

feature_extractor:
  completion_rate:  event.payload["completion_rate"]
  date:             event.payload["date"]
  total_tasks:      event.payload.get("total_tasks", 0)
  completed_count:  event.payload.get("completed_count", 0)

description: |
  每次打卡的 completion_rate → completion_rate_trend。
  pattern_value 存储时间序列的线性回归斜率和近期均值。
  scope=goal：完成率因目标不同而异（有的目标容易，有的目标难）。
```

---

#### Rule P-2: `mastery_recorded_to_mastery_velocity`

```yaml
rule_id: mastery_recorded_to_mastery_velocity
source_event_type: MasteryRecorded
condition: "payload.get('to_level') != payload.get('from_level')"
target_pattern_type: mastery_velocity
target_scope: goal
base_contribution: 1.0
reliability: 0.8             # mastery_level 有用户主观判断成分
requires_db_join: false

feature_extractor:
  from_level_int: >
    {"unknown":0,"L1":1,"L2":2,"L3":3,"L4":4}[payload.get("from_level","unknown")]
  to_level_int:   >
    {"unknown":0,"L1":1,"L2":2,"L3":3,"L4":4}[payload.get("to_level","L1")]
  level_delta:    to_level_int - from_level_int
  occurred_at:    event.occurred_at.isoformat()

description: |
  掌握等级变化 → mastery_velocity。
  pattern_value 存储 levels/week 的滑动均值和各等级升级天数分位数。
  条件过滤：from_level == to_level 的无效更新不计入。
```

---

### 4.3 Planning 类（2条）

---

#### Rule Pl-1: `task_completed_to_delay_pattern`

```yaml
rule_id: task_completed_to_delay_pattern
source_event_type: TaskCompleted
condition: null
target_pattern_type: delay_pattern
target_scope: user
base_contribution: 1.0
reliability: 0.9             # days_overdue 是系统计算值
requires_db_join: false

feature_extractor:
  days_overdue:  event.payload.get("days_overdue", 0)
  on_time:       event.payload.get("days_overdue", 0) <= 0
  evidence_kind: "delay_observation"
  task_category: event.payload.get("stage_label") or event.payload.get("task_type")

description: |
  TaskCompleted.days_overdue → delay_pattern。
  pattern_value 同时存储 observed_delay_rate、adjusted_delay_rate、
  effective_sample_count、supporting_count、opposing_count、excluded_count 和
  evidence_strength。逾期是支持证据，按时完成是反向证据；每次任务完成都提供一个
  数据点，但不再把所有完成事件都当成正向证据。
```

#### Rule Pl-3: `delay_attribution_recorded_to_delay_pattern`

```yaml
rule_id: delay_attribution_recorded_to_delay_pattern
source_event_type: DelayAttributionRecorded
target_pattern_type: delay_pattern
target_scope: user
base_contribution: 0.0
reliability: 1.0
condition: target_event_id exists and attribution in [external_interruption, unexplained]

feature_extractor:
  target_event_id: payload.target_event_id
  target_evidence_id: payload.target_evidence_id
  attribution: payload.attribution
  reason_code: payload.reason_code
```

该事件不新增一条延期事实，只追加用户归因并触发最近证据窗口重算。标记为
`external_interruption` 的记录保留在原始事实中，但不进入 `adjusted_delay_rate`。

---

#### Rule Pl-2: `task_rescheduled_to_plan_adherence`

```yaml
rule_id: task_rescheduled_to_plan_adherence
source_event_type: TaskRescheduled
condition: null
target_pattern_type: plan_adherence
target_scope: goal
base_contribution: 1.0
reliability: 0.9
requires_db_join: false

feature_extractor:
  trigger:           event.payload.get("trigger", "user_manual")
  is_debt_rollover:  event.payload.get("trigger") == "debt_rollover"

description: |
  每次改期 → plan_adherence。
  pattern_value 存储 reschedule_rate 和各 trigger 类型的分布。
  debt_rollover 触发的改期是慢性债务信号，需要特别标记。
```

---

### 4.4 第一批 Rule 汇总表

| Rule ID | 触发事件 | 目标 Pattern | Scope | Contribution | 需要 JOIN |
|---------|---------|------------|-------|-------------|----------|
| H-1 | TaskCompleted | preferred_learning_time | user | 0.90 | ❌ |
| H-2 | TaskCompleted | preferred_session_length | user | 0.90 | ❌ |
| H-3 | CheckinSubmitted | preferred_session_length | user | 0.42 | ❌ |
| H-4 | CheckinSubmitted | weekly_learning_frequency | user | 0.90 | ❌ |
| P-1 | CheckinSubmitted | completion_rate_trend | goal | 0.80 | ❌ |
| P-2 | MasteryRecorded | mastery_velocity | goal | 0.80 | ❌ |
| Pl-1 | TaskCompleted | delay_pattern | user | 0.90 | ❌ |
| Pl-2 | TaskRescheduled | plan_adherence | goal | 0.90 | ❌ |
| Pl-3 | DelayAttributionRecorded | delay_pattern | user | 0.00（仅重算） | ❌ |
| Pl-3 | DelayAttributionRecorded | delay_pattern | user | 0.00（仅重算） | ❌ |

> **暂缓的 Rule**：
> - `estimation_accuracy`：需要 JOIN `tasks.estimated_mins`，Phase 2C-3.1 实现
> - `focus_peak_time`：依赖 `preferred_learning_time` 的 hour 数据，复用 H-1 的 evidence.meta，Phase 2C-3.2 实现
> - `distraction_pattern`（TaskSkipped）：需要先确认 TaskSkipped 的 payload 格式，Phase 2C-3.1 实现

---

## 5. Pattern Update Engine

### 5.1 职责

PatternUpdateEngine 是 Rule 提取完特征后的下一站，负责：

1. **Upsert LearnerPattern**：根据 `(user_id, goal_id, pattern_type, scope)` 找到已存在的 Pattern，或创建 candidate
2. **Idempotency 检查**：确认 `(pattern_id, learning_event_id)` 组合未被处理过
3. **Append PatternEvidence**：写入 evidence 记录（append-only）
4. **更新 confidence**：应用下方公式
5. **更新 pattern_value**：调用 pattern_type 特定的聚合函数
6. **运行 Lifecycle 状态机**：检查并执行 status 转换

```python
class PatternUpdateEngine:

    @classmethod
    async def process(
        cls,
        db: AsyncSession,
        event: LearningEvent,
        rule: ExtractionRule,
        features: dict[str, Any],
    ) -> None:
        # 1. 幂等性：已处理过则跳过
        already = await db.scalar(
            select(func.count(PatternEvidence.id)).where(
                PatternEvidence.pattern_id == ???,  # 先获取 pattern
                PatternEvidence.learning_event_id == event.id,
            )
        )
        # 实际实现：先 upsert pattern，再检查 evidence

        # 2. Upsert Pattern
        pattern = await cls._upsert_pattern(db, event, rule)

        # 3. 检查幂等
        if await cls._evidence_exists(db, pattern.id, event.id):
            return

        # 4. 计算 contribution
        contribution = rule.contribution  # base_contribution × reliability

        # 5. 写入 PatternEvidence
        db.add(PatternEvidence(
            pattern_id=pattern.id,
            learning_event_id=event.id,
            contribution=contribution,
            recorded_at=datetime.utcnow(),
            meta=features,
        ))

        # 6. 更新 confidence
        pattern.confidence = cls._update_confidence(
            confidence_old=pattern.confidence,
            contribution=contribution,
            evidence_count=pattern.evidence_count,
        )
        pattern.evidence_count += 1
        pattern.last_confirmed_at = datetime.utcnow()

        # 7. 更新 pattern_value（pattern_type 特定聚合）
        pattern.pattern_value = await cls._update_pattern_value(
            pattern=pattern,
            features=features,
            db=db,
        )

        # 8. Lifecycle 状态机
        pattern.status = cls._run_lifecycle(pattern)
        pattern.updated_at = datetime.utcnow()
```

### 5.2 confidence 计算公式（完整）

**初始化**（创建 candidate 时）：

```
confidence_init = 0.3       # 有真实 evidence 的首次观测
confidence_init = 0.1       # 系统 Prior（Cold Start，onboarding）
```

**新 evidence 到达**（confidence 上升）：

```python
def _update_confidence(
    confidence_old: float,
    contribution: float,      # = base_contribution × reliability
    evidence_count: int,      # 更新前的 evidence_count
) -> float:
    # 学习率随证据增多递减（避免早期噪声过度拟合）
    learning_rate = min(0.1, 5.0 / max(evidence_count, 1))

    # 向 1.0 渐近更新
    confidence_new = (
        confidence_old
        + contribution * learning_rate * (1.0 - confidence_old)
    )

    # Clamp [0, 1]
    return max(0.0, min(1.0, confidence_new))
```

对 `delay_pattern` 不使用上面的单向累计公式。引擎从最近 50 条 evidence.meta
重建观测投影：

```text
adjusted_delay_rate = (1 + supporting_count) / (2 + effective_sample_count)
evidence_strength = effective_sample_count / (effective_sample_count + 3)
```

`confidence` 在此处表示证据强度，不是用户动机概率。`DelayAttributionRecorded`
是 append-only 的纠正事件：原始延期保留，外部中断只从有效模式样本中排除。

**示例演算**（preferred_learning_time，初始 confidence=0.3，reliability=0.9）：

| evidence_count | learning_rate | contribution | Δconfidence | 新 confidence |
|---------------|---------------|-------------|------------|-------------|
| 1 | 0.100 | 0.90 | +0.0630 | 0.363 |
| 5 | 0.100 | 0.90 | +0.0574 | 0.463（累计） |
| 10 | 0.050 | 0.90 | +0.0239 | 0.560（累计） |
| 20 | 0.025 | 0.90 | +0.0110 | 0.658（累计） |
| 50 | 0.010 | 0.90 | +0.0031 | 0.782（累计） |

→ 约20条 evidence 后 confidence 超过0.6（active 阈值），约50条后趋近0.8。

**Decay（无新证据时）**——由后台定时任务执行，非 EventProcessor：

```python
def apply_decay(
    pattern: LearnerPattern,
    now: datetime,
) -> float:
    if pattern.last_confirmed_at is None:
        return pattern.confidence

    days_since = (now - pattern.last_confirmed_at).days
    weeks_since = days_since / 7.0

    # 宽限期2周：短暂中断不应破坏已建立的规律
    if weeks_since <= 2.0:
        return pattern.confidence

    decay_weeks = weeks_since - 2.0
    confidence_new = pattern.confidence * ((1.0 - pattern.decay_rate) ** decay_weeks)
    return max(0.0, min(1.0, confidence_new))
```

### 5.3 Lifecycle 状态机

```python
def _run_lifecycle(pattern: LearnerPattern) -> str:
    """根据当前 Pattern 状态决定新 status。"""

    current = pattern.status
    c = pattern.confidence
    ec = pattern.evidence_count

    if current == "candidate":
        if ec >= 5 and c >= 0.6:
            return "active"       # 升级：证据充足且可信
        return "candidate"        # 保持

    elif current == "active":
        # active → decayed 由 Decay 定时任务检查，不在此处处理
        # 收到新 evidence 时 active 保持 active
        return "active"

    elif current == "decayed":
        if c >= 0.5:
            return "active"       # 重新激活
        return "decayed"          # 保持

    elif current == "archived":
        return "archived"         # 不可逆

    return current
```

`delay_pattern` 使用额外条件：只有 `effective_sample_count >= 5`、
`adjusted_delay_rate > 0.5` 且证据强度达到阈值时才进入 `active`。一次用户纠正
可能使它转为 `decayed`；这不删除原始事件，也不代表系统判定用户在找借口。

**状态转换总表**：

| 转换 | 触发条件 | 执行者 |
|------|---------|--------|
| No Pattern → candidate | 第一条 evidence 到达 | EventProcessor（upsert） |
| candidate → active | `evidence_count ≥ 5` AND `confidence ≥ 0.6` | EventProcessor（每次 evidence 后检查） |
| active → decayed | 14天无新 evidence（`last_confirmed_at` 检测） | DecayTask（后台定时，Phase 2C-4） |
| decayed → active | 新 evidence 使 `confidence ≥ 0.5` | EventProcessor |
| decayed → archived | `confidence < 0.2` 持续30天 | DecayTask |
| candidate → archived | `evidence_count < 3` 且 `first_observed_at` > 60天前 | DecayTask（孤立证据清理） |

### 5.4 各 Pattern 类型的 decay_rate

| Pattern 类型 | decay_rate | 原因 |
|-------------|-----------|------|
| `preferred_learning_time` | 0.02 | 时间习惯极稳定 |
| `estimation_accuracy` | 0.03 | 个人特征，相对稳定 |
| `preferred_session_length` | 0.03 | 随体力/习惯缓慢变化 |
| `mastery_velocity` | 0.04 | 学习速度渐变 |
| `weekly_learning_frequency` | 0.05 | 受生活节奏影响，中速变化 |
| `delay_pattern` | 0.05 | 习惯性拖延较稳定 |
| `plan_adherence` | 0.05 | 计划遵从度中等稳定 |
| `completion_rate_trend` | 0.10 | 最易波动，快速响应 |

---

## 6. Scope Resolution（三级 fallback 查询）

### 6.1 三级 Scope 层次

```
user（全局）
 └── skill_category（算法/语言/阅读/考试...）
       └── goal（具体目标）
```

| Scope | 含义 | 示例 Pattern |
|-------|------|------------|
| `user` | 跨所有目标的全局规律 | `preferred_learning_time`（晚上学习） |
| `skill_category` | 同类目标共享的规律 | `mastery_velocity`（算法类任务速度慢于语言类） |
| `goal` | 特定目标的局部规律 | `completion_rate_trend`（这个Python目标完成率在提升） |

### 6.2 查询 fallback 链

Agent 请求某 Pattern 时，按 goal → skill_category → user 顺序查找，取置信度最高且 status='active' 的那个：

```python
async def get_pattern(
    db: AsyncSession,
    user_id: str,
    pattern_type: str,
    goal_id: str | None = None,
    skill_category: str | None = None,
    min_confidence: float = 0.5,
) -> LearnerPattern | None:
    """
    Fallback chain:
      1. goal-scoped pattern（最精确）
      2. skill_category-scoped pattern
      3. user-scoped pattern（最通用）
    返回第一个满足 min_confidence 且 status='active' 的 Pattern。
    若均未找到，返回 None（Agent 使用默认值）。
    """
    candidates = []

    # Level 1: goal scope
    if goal_id:
        p = await _query_pattern(db, user_id, pattern_type, "goal", goal_id, min_confidence)
        if p:
            candidates.append(p)

    # Level 2: skill_category scope
    if skill_category and not candidates:
        p = await _query_pattern(db, user_id, pattern_type, "skill_category",
                                 skill_category, min_confidence)
        if p:
            candidates.append(p)

    # Level 3: user scope
    if not candidates:
        p = await _query_pattern(db, user_id, pattern_type, "user", None, min_confidence)
        if p:
            candidates.append(p)

    return candidates[0] if candidates else None
```

### 6.3 `skill_category` 字段来源

Phase 2C-1 设计中，`skill_category` 来自 Goal 的分类标签。Phase 2C-3 中 `skill_category` 的提取策略：

| 方案 | 说明 | Phase 2C-3 决定 |
|------|------|---------------|
| Goal.category 字段 | 直接取 Goal 表的分类字段 | ✅ 采用，若字段存在 |
| Goal title NLP 分类 | LLM 提取类别 | ❌ Phase 2C-5 以后 |
| 用户手动标注 | Onboarding 时填写 | ❌ Phase 2C-5 以后 |

**Phase 2C-3 简化处理**：`scope='skill_category'` 的 Pattern 暂不生成（Rule 中统一使用 `scope='user'` 或 `scope='goal'`），等 Phase 2C-5 接入 skill_category 分类后再补充。

---

## 7. Event Processing 完整生命周期

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Pattern Analyzer 事件处理生命周期                    │
│                                                                     │
│  LearningEvent 写入 DB（publisher.emit 调用处）                       │
│          │                                                          │
│          │  （近实时，分钟级延迟）                                     │
│          ↓                                                          │
│  EventProcessor.run_batch()                                         │
│    读取游标 last_processed_at                                        │
│    查询 created_at > cursor 的新事件（批量，LIMIT 100）               │
│          │                                                          │
│          ↓                                                          │
│  RuleRegistry.get_rules(event.event_type)                           │
│    ├─ 空列表 → 跳过（TaskCreated / GoalCreated 等）                  │
│    └─ 非空 → 逐 Rule 处理                                            │
│          │                                                          │
│          ↓                                                          │
│  ExtractionRule.condition_check(event)                              │
│    ├─ False → 跳过此 Rule                                            │
│    └─ True → 继续                                                   │
│          │                                                          │
│          ↓                                                          │
│  run_extractor(rule_id, event, db)                                  │
│    → features: dict[str, Any]                                       │
│          │                                                          │
│          ↓                                                          │
│  PatternUpdateEngine.process(db, event, rule, features)             │
│    ├─ _upsert_pattern()     找到或创建 LearnerPattern               │
│    ├─ _evidence_exists()    幂等检查                                 │
│    ├─ append PatternEvidence（append-only）                          │
│    ├─ _update_confidence()  应用公式                                 │
│    ├─ _update_pattern_value() 聚合更新                               │
│    └─ _run_lifecycle()      status 状态机                            │
│          │                                                          │
│          ↓                                                          │
│  db.commit()（批次结束，整批原子提交）                                 │
│  更新游标 last_processed_at                                          │
│          │                                                          │
│          ↓（每日凌晨，独立定时任务，Phase 2C-4）                       │
│                                                                     │
│  DecayTask.run()                                                    │
│    遍历 status='active' 且 14天无 evidence 的 Pattern               │
│    → apply_decay() → 降低 confidence                                │
│    → _run_lifecycle() → 可能降级为 'decayed' / 'archived'           │
│          │                                                          │
│          ↓（每日凌晨，独立定时任务，Phase 2C-4）                       │
│                                                                     │
│  ProfileBuilder.run()                                               │
│    从 learning_events 聚合近30日统计                                 │
│    写入 learner_profiles（全量重算）                                  │
│          │                                                          │
│          ↓（按需触发，Phase 2C-5）                                    │
│                                                                     │
│  Agent Decision Loop                                                │
│    读取 learner_profiles + active learner_patterns                  │
│    生成 DecisionProposal（只读 Learner Model，只写 Proposal）         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.1 幂等性保证

| 场景 | 保证方式 |
|------|---------|
| EventProcessor 重复运行 | 游标推进在 commit 之后；若 commit 失败游标不推进，下次重新处理 |
| 同一 event 对同一 rule 重复处理 | `PatternEvidence` 唯一约束 `(pattern_id, learning_event_id)` |
| 服务重启 | 游标持久化在 DB，重启后从游标位置继续 |

**PatternEvidence 唯一约束**（需在 Alembic migration 中添加）：

```python
# 在 Phase 2C-3 migration 中添加
op.create_unique_constraint(
    "uq_pattern_evidence_event",
    "pattern_evidences",
    ["pattern_id", "learning_event_id"],
)
```

注：`learning_event_id` 可为 NULL（系统 Prior），NULL 不参与唯一约束（SQL 标准），所以无冲突。

### 7.2 调度策略（Phase 2C-3 简化实现）

| 任务 | 调度方式 | 间隔 |
|------|---------|------|
| EventProcessor.run_batch | FastAPI background task OR APScheduler | 每5分钟 |
| DecayTask.run | APScheduler | 每日00:30 |
| ProfileBuilder.run | APScheduler | 每日01:00 |

Phase 2C-3 先用 APScheduler 实现调度，不引入消息队列（避免增加基础设施复杂度）。

---

## 8. 与 Agent Decision Loop 接口

### 8.1 架构边界

```
[Pattern Analyzer]               [Agent Decision Loop]

learner_patterns    ──只读──→    AgentDecisionInput
learner_profiles    ──只读──→    ├─ learner_profile（Profile 快照）
learning_events     ──只读──→    ├─ active_patterns（confidence ≥ 0.5 的 Pattern）
                                └─ recent_events（近7天轻量引用）

                                         ↓ 推理

                                 DecisionProposal（只写 Proposal 表）
                                 ├─ proposal_type
                                 ├─ reasoning（引用 pattern_id）
                                 ├─ confidence
                                 └─ proposed_changes
```

**Pattern Analyzer 绝对不做**：
- 不生成 Proposal
- 不调用 AI 模型
- 不修改 Goal / Task / Plan

**Agent 绝对不做**：
- 不写 learner_patterns / pattern_evidences
- 不触发 PatternUpdateEngine
- 不调用 EventProcessor

### 8.2 Agent 读取 Pattern 的标准查询

```python
async def get_active_patterns_for_agent(
    db: AsyncSession,
    user_id: str,
    goal_id: str,
    min_confidence: float = 0.5,
) -> list[PatternSnapshot]:
    """返回 Agent 可用的 Pattern 列表。

    只返回 status='active' 且 confidence >= min_confidence 的 Pattern。
    按 confidence DESC 排序。
    """
    result = await db.execute(
        select(LearnerPattern)
        .where(
            LearnerPattern.user_id == user_id,
            LearnerPattern.status == "active",
            LearnerPattern.confidence >= min_confidence,
            or_(
                LearnerPattern.goal_id == goal_id,
                LearnerPattern.goal_id.is_(None),  # user-scoped patterns
            ),
        )
        .order_by(LearnerPattern.confidence.desc())
    )
    return result.scalars().all()
```

### 8.3 DecisionProposal 约束（Pattern Analyzer 侧）

Agent 生成 Proposal 时必须满足的约束（来自 Phase 2C-1 §8.6）：

| 约束 | 规则 |
|------|------|
| 必须引用 Pattern | `evidence_references` 不可为空（不允许"凭感觉"建议） |
| 低置信度人工确认 | `confidence < 0.6` → `requires_user_confirmation = True` |
| 高影响必须确认 | `REGENERATE_PLAN` 永远 `requires_user_confirmation = True` |
| 不直接写 DB | Agent 只生成 Proposal，由应用层执行 |
| 每次最多1个高影响 | 避免一次性建议太多变更 |

---

## 9. 测试策略

### 9.1 单元测试（不需要 DB）

| 测试目标 | 测试内容 | 文件位置 |
|---------|---------|---------|
| ExtractionRule.condition_check | 条件表达式求值正确 / 无效表达式返回 False | `tests/test_extraction_rules.py` |
| FeatureExtractor 各函数 | 给定 event，返回正确的 features dict | `tests/test_extraction_rules.py` |
| confidence 公式 | 给定 confidence_old / contribution / evidence_count，验证公式结果 | `tests/test_pattern_engine.py` |
| apply_decay | 宽限期内不衰减；超过宽限期按公式衰减 | `tests/test_pattern_engine.py` |
| Lifecycle 状态机 | 各状态转换触发条件正确 | `tests/test_pattern_engine.py` |
| RuleRegistry | register / get_rules 返回正确 Rule 列表 | `tests/test_rule_registry.py` |

**confidence 公式单元测试示例**：

```python
def test_confidence_update_initial():
    # 首条 evidence：confidence_old=0.3, contribution=0.9, evidence_count=0
    result = update_confidence(0.3, 0.9, 0)
    # learning_rate = min(0.1, 5.0 / max(0, 1)) = min(0.1, 5.0) = 0.1
    # Δ = 0.9 × 0.1 × (1.0 - 0.3) = 0.063
    assert abs(result - 0.363) < 0.001

def test_confidence_clamp():
    # confidence 不超过 1.0
    result = update_confidence(0.99, 1.0, 1)
    assert result <= 1.0

def test_decay_within_grace_period():
    # 宽限期内（14天）不衰减
    pattern = LearnerPattern(confidence=0.8, last_confirmed_at=datetime.utcnow() - timedelta(days=10))
    result = apply_decay(pattern, datetime.utcnow())
    assert result == 0.8

def test_decay_after_grace_period():
    # 超过宽限期（28天，实际衰减2周）
    pattern = LearnerPattern(confidence=0.8, decay_rate=0.05,
                             last_confirmed_at=datetime.utcnow() - timedelta(days=28))
    result = apply_decay(pattern, datetime.utcnow())
    # decay_weeks = (28/7) - 2 = 2
    # expected = 0.8 × (0.95^2) ≈ 0.722
    assert abs(result - 0.722) < 0.01
```

### 9.2 集成测试（需要 DB）

| 测试场景 | 验证内容 | 文件位置 |
|---------|---------|---------|
| 全流程：TaskCompleted → PatternEvidence → LearnerPattern | evidence 写入、confidence 更新、status 变化 | `tests/test_pattern_integration.py` |
| 幂等性：同一 event 处理两次 | PatternEvidence 只有1条，confidence 只更新1次 | `tests/test_pattern_integration.py` |
| candidate → active 升级 | 5条 evidence 后 status 变为 active | `tests/test_pattern_integration.py` |
| Scope fallback | goal-scoped 优先于 user-scoped | `tests/test_pattern_integration.py` |
| run_batch 游标推进 | 处理完批次后游标正确推进，重复运行不重复处理 | `tests/test_event_processor.py` |

**集成测试关键 fixture**：

```python
@pytest.fixture
async def user_with_events(db: AsyncSession):
    """创建测试用户 + 一批 LearningEvent，用于集成测试。"""
    user = User(...)
    goal = Goal(...)
    db.add_all([user, goal])
    await db.flush()

    events = [
        LearningEvent(
            user_id=user.id, goal_id=goal.id,
            event_type="TaskCompleted",
            payload={"actual_mins": 60, "days_overdue": 0},
            occurred_at=datetime.utcnow() - timedelta(hours=i),
        )
        for i in range(10)
    ]
    db.add_all(events)
    await db.commit()
    return user, goal, events
```

### 9.3 测试覆盖目标

| 层次 | 覆盖目标 |
|------|---------|
| Unit（Rule层） | 100% 的 condition_check 和 extract_features 函数 |
| Unit（Engine层）| 所有 confidence 公式分支（上升/衰减/clamp/contradiction） |
| Integration | 9条 Rule 全部有端到端集成测试 |
| Idempotency | 所有Rule 的幂等性验证 |

---

## 10. 实现顺序建议

Phase 2C-3 建议按以下顺序实现，每步均可独立测试：

```
Step 1: intelligence_cursors 模型 + migration
  ├─ IntelligenceCursor SQLAlchemy 模型            (src/models.py)
  └─ Alembic migration t4u5v6w7x8y9               (alembic/versions/)

Step 2: ExtractionRule Schema
  ├─ ExtractionRule dataclass                     (intelligence/extraction_rules/base.py)
  ├─ RuleRegistry (register / get_rules)          (intelligence/extraction_rules/base.py)
  └─ register_extractor 装饰器                    (intelligence/extraction_rules/base.py)

Step 3: PatternUpdateEngine 核心
  ├─ _upsert_pattern（找到或创建 candidate）
  ├─ _evidence_exists（幂等检查）
  ├─ _update_confidence（公式实现）
  ├─ _update_pattern_value（evidence window 50条重算）
  └─ _run_lifecycle（状态机）
  → 单元测试全部通过

Step 4: EventProcessor 主循环（同步，不引入 Celery）
  ├─ process_event(db, event)      同步调用入口
  ├─ run_batch(db)                 批量处理（游标推进）
  └─ 游标持久化（intelligence_cursors 表）
  ⚠️ Phase 2C-3 不引入 APScheduler / Celery / 消息队列
     调用方直接 await process_event() 即可

Step 5: 第一批 9 条 Rule
  ├─ H-1 task_completed_to_preferred_time
  ├─ H-2 task_completed_to_session_length
  ├─ H-3 checkin_submitted_to_session_length
  ├─ H-4 checkin_submitted_to_weekly_frequency
  ├─ P-1 checkin_submitted_to_completion_trend
  ├─ P-2 mastery_recorded_to_mastery_velocity
  ├─ Pl-1 task_completed_to_delay_pattern
  ├─ Pl-2 task_rescheduled_to_plan_adherence
  └─ Pl-3 delay_attribution_recorded_to_delay_pattern

Step 6: pattern_value 聚合函数
  ├─ preferred_learning_time：peak_hours（取最近50条 hour 分布，top-3）
  ├─ preferred_session_length：分位数（p25/p50/p75，排序取分位）
  ├─ completion_rate_trend：线性回归斜率（numpy-free 手算）
  ├─ mastery_velocity：levels/week 滑动均值
  ├─ weekly_learning_frequency：avg_days_per_week（28天窗口）
  └─ delay_pattern：observed/adjusted delay rate + category breakdown + evidence_strength

Step 7: 集成测试
  ├─ Event → Processor → Evidence → Pattern Update（全流程）
  ├─ 幂等性（同一 event 处理两次只写一条 evidence）
  └─ candidate → active 升级（5条 evidence 后 status 变化）
```

---

## 11. 遗留问题与设计决策

### 11.1 已确认决策

| # | 决策 | 结论 |
|---|------|------|
| D-1 | 游标字段：`occurred_at` vs `created_at` | 用 `created_at`（单调递增，补录安全） |
| D-2 | Pattern 幂等单位 | `(pattern_id, learning_event_id)`，NULL event_id 不受约束 |
| D-3 | Phase 2C-3 skill_category | 暂不实现 skill_category scope，统一为 user / goal |
| D-4 | contradiction evidence | Phase 2C-3 只实现正向更新，contradiction 留 Phase 2C-5 |
| D-5 | 调度方式 | **不引入 Celery / APScheduler / 消息队列**；Phase 2C-3 直接 `await process_event()`；稳定后再接 worker |
| D-6 | pattern_value 聚合 | evidence window 重算：每次写入 evidence 后读取最近50条 meta，重新计算 pattern_value；不直接累积 JSON；Phase 2C-5 数据量增长后改 materialized aggregation |
| D-7 | 游标表名称 | `intelligence_cursors`（不绑定单一 processor，供未来多 consumer 共用） |
| D-8 | `tasks.estimated_mins` 字段名 | 确认为 `estimated_mins`（非 `estimated_minutes`） |
| D-9 | Cold Start / Onboarding | Phase 2C-3 不实现问卷注入；保留 `system_prior` source 入口；实现留 Phase 2C-4 |

### 11.2 ~~待确认问题~~（全部已确认，见 D-6 ~ D-9）

### 11.3 Phase 2C-3 不包含的内容

| 内容 | 预留阶段 |
|------|---------|
| Celery / APScheduler / 消息队列 | Phase 2C-3 不引入，稳定后接入 |
| Cold Start 问卷注入 | Phase 2C-4 / Profile Builder |
| ProfileBuilder（LearnerProfile 重算） | Phase 2C-4 |
| Agent Decision Loop 实现 | Phase 2C-5 |
| Study Session 模型（TaskSessionStarted/Ended） | Phase 2C-3.5 |
| focus_peak_time（需要 Session 数据） | Phase 2C-3.5 |
| skill_category scope | Phase 2C-5 |
| estimation_accuracy（需 JOIN tasks） | Phase 2C-3.1（独立追加） |
| AgentProposalAccepted/Rejected 反馈循环 | Phase 2C-5 |
| contradiction evidence | Phase 2C-5 |
| pattern_value materialized aggregation | Phase 2C-5（数据量增长后） |
| pattern_value 冷热分层存储 | Phase 2C-6 |

---

> **文档状态**: V3（Implementation 完成，Step 7 测试全部通过）
> **下一步**: Phase 2C-3.1（estimation_accuracy Rule）或 Phase 2C-4（DecayTask + ProfileBuilder）。

---

## 12. 实现后记：已发现 Bug 与修复

### 12.1 PatternUpdateEngine autoflush 双重计入 Bug

**发现时机**：Step 7 集成测试，`test_pattern_value_aggregated_correctly` 断言 `median_mins == 40.0`，实际返回 `50.0`。

#### 问题描述

`PatternUpdateEngine.process()` 原实现顺序：

```python
# 原错误顺序
db.add(PatternEvidence(..., meta=features))   # ← 先写入 session

recent_metas = await cls._get_recent_evidence_metas(   # ← 再查询 DB
    db, pattern.id, limit=EVIDENCE_WINDOW - 1
)
recent_metas.append(features)   # ← 再追加当前
```

SQLAlchemy 默认开启 `autoflush=True`：**执行任何 SELECT 之前，ORM 会自动把 session 中所有待写对象 flush 到 DB**。

因此，上方代码实际执行路径是：

```
db.add(PatternEvidence_current)          # pending in session
↓
_get_recent_evidence_metas() → SELECT   # autoflush 触发！
↓
PatternEvidence_current 被 flush 到 DB
↓
SELECT 返回结果中已包含 PatternEvidence_current (session_mins=60)
↓
recent_metas.append(features)            # 再追加一次 session_mins=60
↓
metas = [40, 20, 60, 60]  ← 60 被计算了两次！
↓
percentile([20, 40, 60, 60], 0.5) = 50.0  ← 错误
```

**期望结果**：`metas = [20, 40, 60]` → `median = 40.0`

#### 修复方案

将 `_get_recent_evidence_metas` 查询移到 `db.add()` **之前**，查询完成后再写入 session：

```python
# 修复后顺序（pattern_update_engine.py §process()）

# 4. 先读历史 metas（在 db.add 之前，避免 autoflush 带入当前 evidence）
recent_metas = await cls._get_recent_evidence_metas(
    db, pattern.id, limit=EVIDENCE_WINDOW - 1
)
recent_metas.append(features)   # 追加当前（尚未持久化）

# 5. 更新 pattern_value
pattern.pattern_value = cls._aggregate_pattern_value(...)

# 6. Append PatternEvidence（查询完成后才 add，避免 autoflush 重复计入）
db.add(PatternEvidence(..., meta=features))

# 7. 更新 confidence / evidence_count / status
```

**核心原则**：在同一事务内，凡是先 `db.add()` 后执行 SELECT 的代码段，都要注意 autoflush 可能让待写对象提前出现在查询结果中。

---

### 12.2 测试设计问题与修复

#### 问题一：规则数量断言错误

原测试以为 `TaskCompleted` 只触发 H-1 + H-2 两条规则，断言 `len(patterns) == 2`。

实际上 Pl-1（`task_completed_to_delay_pattern`）也绑定了 `TaskCompleted`，共触发 **3 条规则**：

| Rule | source_event_type | target_pattern_type |
|------|-------------------|---------------------|
| H-1  | TaskCompleted     | preferred_learning_time |
| H-2  | TaskCompleted     | preferred_session_length |
| Pl-1 | TaskCompleted     | delay_pattern |

修复：所有涉及 `TaskCompleted` 的断言改为期望 3 条。

#### 问题二：Batch 测试游标污染

所有 batch 测试共享同一个 SQLite in-memory 数据库和同一个游标（`consumer_name = 'pattern_analyzer'`）。前序 batch 测试把游标推到 `now`，后续测试创建的新事件 `created_at = server_default = now()` 不会超过游标，导致 `run_batch()` 返回 0。

修复：每个 batch 测试为其创建的事件设置显式的未来时间戳，各测试使用不同的时间偏移区段（`+1h / +2h / +3h`）互不干扰：

```python
base = datetime.utcnow() + timedelta(hours=1)  # test1 用 +1h 区段
event = _make_event(user.id, created_at=base + timedelta(seconds=i), ...)
```

**核心原则**：共享 DB 的集成测试，凡依赖时间序游标的，必须通过显式 `created_at` 把各测试的事件隔离在不同时间窗口内。

---

### 12.3 Step 7 最终测试结果

```
tests/test_pattern_analyzer.py  32 passed
```

覆盖范围：

| 测试类 | 测试项 | 数量 |
|--------|--------|------|
| `TestExtractionRuleConditionCheck` | condition=None / True / False / 无效表达式 / contribution 计算 | 5 |
| `TestConfidenceFormula` | 首条增量、30条收敛、上界夹断、低contribution慢增、大count小步长 | 5 |
| `TestDecayFormula` | 宽限期内/边界/宽限期后/无last_confirmed/越久越衰 | 5 |
| `TestLifecycleStateMachine` | candidate→active / 各留守条件 / decayed→active / active / archived | 8 |
| `TestProcessEventIntegration` | 全流程、H-2条件过滤、幂等性、candidate→active、pattern_value重算 | 5 |
| `TestBatchProcessing` | 游标创建/推进、游标防重处理、batch_size限制、无新事件返回0 | 4 |
