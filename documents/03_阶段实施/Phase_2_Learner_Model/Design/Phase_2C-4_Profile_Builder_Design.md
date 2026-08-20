# Phase 2C-4：Learner Profile Builder — 设计文档

**版本**: V3（实现完成）
**前置依赖**:
- Phase 2C-2：LearnerProfile / LearnerPattern / PatternEvidence 模型
- Phase 2C-3：EventProcessor / ExtractionRule / PatternUpdateEngine / 8 条 Rules

> **实现边界修订（2026-07-29）**：实际实现遵循最新接管要求，Profile Builder
> 只执行“读取 Pattern/Event → 计算 → 更新 Profile”，不会调用 DecayTask，也不会修改
> LearnerPattern。本文 §9 Step 2.5 与 D-3 的 DecayTask 方案不属于 Profile Builder
> 的实际执行链路；Pattern 衰减应由独立生命周期任务负责。

---

## 目录

1. [设计背景与定位](#1-设计背景与定位)
2. [Profile Builder 职责边界](#2-profile-builder-职责边界)
3. [LearnerProfile 字段映射](#3-learnerprofile-字段映射)
4. [Profile 更新策略](#4-profile-更新策略)
5. [Profile Scope 与查询降级](#5-profile-scope-与查询降级)
6. [Profile Builder Pipeline](#6-profile-builder-pipeline)
7. [冷启动设计](#7-冷启动设计)
8. [Agent 接口设计](#8-agent-接口设计)
9. [实现步骤](#9-实现步骤)
10. [测试策略](#10-测试策略)
11. [待确认问题](#11-待确认问题)

---

## 1. 设计背景与定位

### 1.1 当前链路

```
用户行为
   ↓
LearningEvent          ← Phase 2B（append-only 事件流）
   ↓
EventProcessor         ← Phase 2C-3（Rule-based 分发）
   ↓
LearnerPattern         ← Phase 2C-2/3（长期行为知识，近实时更新）
   ↓
[？]                   ← Phase 2C-4 要填的空缺
   ↓
Agent Decision Loop    ← Phase 2C-5
```

### 1.2 两层知识的区别

| 层 | 表 | 本质 | 更新时机 |
|----|----|------|---------|
| **Pattern 层** | `learner_patterns` | 长期行为知识（"这个用户通常在几点学习？"） | 每条 LearningEvent 到来后近实时更新 |
| **Profile 层** | `learner_profiles` | 当前学习状态快照（"这个用户最近30天完成率是多少？"） | 定期批量重算（每日） |

Profile 是对 Pattern + 近期 Event 的**二次聚合**，为 Agent 提供一个可直接读取的"仪表盘"。

### 1.3 为什么需要单独的 Profile 层

1. **Pattern 是领域值，不是直接可读指标**：`preferred_learning_time.peak_hours = [9, 14, 20]` 需要转换为 Agent 可使用的 `preferred_hour_start=9, preferred_hour_end=22`。
2. **Agent 需要跨 Pattern 聚合**：一次 Agent 调用可能需要读取7-8个 Pattern，每次实时查询效率低。
3. **部分指标来自原始 Event，不经过 Pattern**：`avg_daily_investment_mins`、`mastery_rate_30d` 需要直接聚合最近30天事件。
4. **Profile 提供置信度感知**：Pattern confidence < 阈值时，Profile 降级到原始事件聚合，Agent 无需关心数据来源。

---

## 2. Profile Builder 职责边界

### 2.1 负责

- 读取 `active`/`decayed` 状态的 LearnerPattern，提取 pattern_value 字段
- 聚合最近 N 天的 LearningEvent（直接计算部分字段）
- 将聚合结果写入 `learner_profiles`（upsert）
- 提供 Agent 查询入口（读取 Profile + Active Patterns + Recent Events）

### 2.2 不负责

| 不做的事 | 负责方 |
|---------|--------|
| 发现 Pattern / 修改 Pattern | Phase 2C-3 PatternUpdateEngine |
| 生成 AI 建议 / 计划调整 | Phase 2C-5 Agent Decision Loop |
| 衰减 Pattern confidence | Phase 2C-4 DecayTask（独立 Job） |
| 写入 LearningEvent | Domain Service / Event Publisher |
| 评估用户目标进度 | GoalService |

### 2.3 Profile Builder 不生成任何 Proposal

Profile Builder 是**只读聚合器**，输出是结构化数值，不包含：
- 文字建议
- 计划变更
- 任何 AI 生成内容

---

## 3. LearnerProfile 字段映射

> 说明：
> - **来源 A（Pattern）**：从对应 LearnerPattern.pattern_value 读取，需该 Pattern 处于 `active` 或 `decayed` 状态。
> - **来源 B（Event 聚合）**：直接聚合最近 `observation_window_days`（默认30天）的 LearningEvent。
> - **降级规则**：Pattern 不存在或仍为 `candidate` 时，使用 Event 聚合作为降级计算；若 Event 也不足，字段设为 `NULL`。

### 3.1 坚持度指标

#### `consistency_score`（Float，0.0–1.0）

| 项 | 内容 |
|----|------|
| 来源 | Pattern：`weekly_learning_frequency`（scope=user）|
| 计算 | `pattern_value.avg_days_per_week / 7.0`，clamp [0, 1] |
| 降级 | 统计 observation_window 内不重复学习日数 / `observation_window_days` |
| Pattern 置信度要求 | ≥ 0.4（candidate 期间使用降级） |
| 语义 | 0 = 从不学习，1 = 每天都学 |

#### `weekly_active_days`（Float）

| 项 | 内容 |
|----|------|
| 来源 | Pattern：`weekly_learning_frequency`（scope=user）|
| 计算 | `pattern_value.avg_days_per_week` |
| 降级 | 统计 observation_window 内不重复日期数 ÷ (window_days / 7) |

---

### 3.2 投入时长指标

#### `avg_session_duration_mins`（Float）

| 项 | 内容 |
|----|------|
| 来源 | Pattern：`preferred_session_length`（scope=user）|
| 计算 | `pattern_value.median_mins` |
| 降级 | 聚合 TaskCompleted.payload.actual_mins（mean，去掉0值）|
| Pattern 置信度要求 | ≥ 0.4 |
| 语义 | 用户典型单次学习时长（中位数，对异常值更鲁棒）|

#### `avg_daily_investment_mins`（Float）

| 项 | 内容 |
|----|------|
| 来源 | **Event 聚合**（无直接 Pattern）|
| 计算 | `SUM(CheckinSubmitted.payload.time_investment_mins) / 活跃学习天数`（D-2 确认）|
| 说明 | 分母 = observation_window 内有 LearningEvent 的不重复日期数；反映"学习时的平均每日投入"，排除未学习的零值天 |
| 降级 | `avg_session_duration_mins × weekly_active_days / 7` |
| 注意 | 与 `avg_session_duration_mins` 区别：前者是每日维度（可含多次 session），后者是单次 session 中位数 |

---

### 3.3 完成率与掌握率

#### `completion_rate_30d`（Float，0.0–1.0）

| 项 | 内容 |
|----|------|
| 来源 A | Pattern：`completion_rate_trend`（scope=goal，按 goal 分别读取）|
| 计算 | `pattern_value.current_30d_avg` |
| 来源 B（降级）| 聚合 CheckinSubmitted.payload.completion_rate（mean）in window |
| Scope 说明 | goal-level Profile 使用 goal-specific Pattern；user-level Profile 使用所有 goal 的加权均值 |

#### `mastery_rate_30d`（Float，0.0–1.0）

| 项 | 内容 |
|----|------|
| 来源 | **Event 聚合**（无直接 Pattern）|
| 计算 | `count(MasteryRecorded where to_level IN ['L3','L4']) / count(MasteryRecorded)` in window |
| 降级 | NULL（数据不足则不填）|
| 说明 | 衡量"已掌握任务比例"，与 completion_rate 不同 |

---

### 3.4 掌握速度

#### `mastery_velocity`（Float，levels/week）

| 项 | 内容 |
|----|------|
| 来源 | Pattern：`mastery_velocity`（scope=goal）|
| 计算 | `pattern_value.levels_per_week` |
| 降级 | 聚合 MasteryRecorded events，手算 delta / weeks |
| Pattern 置信度要求 | ≥ 0.4 |
| 说明 | goal-level Pattern 用于 goal Profile；user-level 取所有 goal 的均值 |

---

### 3.5 时段偏好

#### `preferred_hour_start` / `preferred_hour_end`（Integer，0–23）

| 项 | 内容 |
|----|------|
| 来源 | Pattern：`preferred_learning_time`（scope=user）|
| 计算 | `peak_hours` 列表中 `min` 和 `max + 1`（右开区间），覆盖所有峰值 |
| 示例 | peak_hours=[9, 14, 20] → start=9, end=21 |
| 多峰处理 | **粗粒度 min/max**（D-1 确认方案）：Profile 字段仅保存整体范围摘要；精细多峰信息保留在 Pattern.pattern_value.peak_hours，Agent 可直接读取 Pattern 做更精确匹配 |
| 降级 | 聚合 TaskCompleted.occurred_at.hour，取众数 ±1 作为范围 |

#### `preferred_weekdays`（JSON list，元素范围 0–6）

| 项 | 内容 |
|----|------|
| 来源 | Pattern：`preferred_learning_time`（scope=user）|
| 计算 | `weekday_dist` 中频率前5的 weekday（Python weekday：Mon=0, Sun=6）|
| 降级 | 聚合 TaskCompleted.occurred_at.weekday()，取 top-5 |

---

### 3.6 计划行为指标

#### `estimation_accuracy`（Float，0.0–2.0+）

| 项 | 内容 |
|----|------|
| 来源 A | Pattern：`estimation_accuracy`（scope=user，**Phase 2C-3.1 实现**）|
| 来源 B（降级）| 聚合 TaskCompleted：`mean(actual_mins / estimated_mins)`，过滤 estimated_mins=0 |
| 语义 | 1.0 = 完美估算；< 1 = 高估时间；> 1 = 低估时间（花的比预期多）|
| Phase 2C-4 处理 | Phase 2C-3.1 未实现时，仅使用 Event 聚合降级 |

#### `debt_tendency`（Float，0.0–1.0）

| 项 | 内容 |
|----|------|
| 来源 | Pattern：`delay_pattern`（scope=user）|
| 计算 | `pattern_value.chronic_delay_rate`（days_overdue > 3 的比例）|
| 降级 | 聚合 TaskCompleted.payload.days_overdue：count(>3) / count(total) |
| 语义 | 接近1 = 严重拖延倾向 |

#### `reschedule_rate`（Float，0.0–1.0）

| 项 | 内容 |
|----|------|
| 来源 | Pattern：`plan_adherence`（scope=user 或 goal）|
| 计算 | `pattern_value.debt_rollover_rate` |
| 降级 | count(TaskRescheduled) / count(TaskCompleted + TaskRescheduled) in window |
| 语义 | 接近1 = 计划经常被推迟 |

---

### 3.7 字段映射总表

| Profile 字段 | 来源 Pattern | pattern_type | 降级（Event 聚合） |
|---|---|---|---|
| consistency_score | weekly_learning_frequency | user | 不重复日数 / window_days |
| weekly_active_days | weekly_learning_frequency | user | 不重复日数 ÷ 周数 |
| avg_session_duration_mins | preferred_session_length | user | TaskCompleted.actual_mins mean |
| avg_daily_investment_mins | ——（无 Pattern）| — | CheckinSubmitted.time_investment_mins / 活跃日 |
| completion_rate_30d | completion_rate_trend | goal | CheckinSubmitted.completion_rate mean |
| mastery_rate_30d | ——（无 Pattern）| — | MasteryRecorded L3/L4 比例 |
| mastery_velocity | mastery_velocity | goal | MasteryRecorded delta / weeks |
| preferred_hour_start/end | preferred_learning_time | user | TaskCompleted.hour 众数 ±1 |
| preferred_weekdays | preferred_learning_time | user | TaskCompleted.weekday top-5 |
| estimation_accuracy | estimation_accuracy（2C-3.1）| user | actual_mins / estimated_mins mean |
| debt_tendency | delay_pattern | user | days_overdue > 3 比例 |
| reschedule_rate | plan_adherence | user/goal | TaskRescheduled / 总任务数 |

---

## 4. Profile 更新策略

### 4.1 Event-driven 实时更新 vs. 定时 Batch 更新

| 维度 | Event-driven | **Batch（选择此方案）** |
|------|-------------|------------------------|
| 时效性 | 每条 Event 后立即刷新 | 每日一次，时效约 24h |
| 计算开销 | 高：每次 Event 触发全字段重算 | 低：错峰批量计算 |
| 实现复杂度 | 高：需与 EventProcessor 共享事务 | 低：独立 Job，无事务依赖 |
| Agent 需求 | Agent 读取 Profile 不需要秒级新鲜度 | ✅ 日级刷新完全满足 |
| Pattern 依赖 | Pattern 近实时更新，Profile 需等 Pattern 稳定 | ✅ 每日读取已收敛的 Pattern |

**结论**：Profile 选用 **每日 Batch 更新**。

- Pattern 层负责近实时捕捉行为变化。
- Profile 层每天一次聚合 Pattern + 近期 Event，生成稳定的状态快照。
- Agent 读取 Profile 时接受最多 24 小时的数据延迟（新用户首次使用除外，见 §7 冷启动）。

### 4.2 Daily Profile Builder Job 设计

```
触发方式（Phase 2C-4 实现）：
  方案 A：API 端点触发（采用，无新依赖）
    POST /api/v1/learner/profile/rebuild       ← D-4 确认路径
    → 仅重建当前登录用户自己的 Profile
    → Auth: Depends(get_current_user)，普通用户权限
    → 由用户主动触发或由外部 cron 携带用户 token 调用

  方案 B：Admin 全量重建（Phase 2C-5 再考虑）
  方案 C：APScheduler（引入新依赖，Phase 2C-5 再考虑）

Phase 2C-4 采用方案 A：
  - ProfileBuilder 提供 build_for_user(db, user_id) 函数
  - API 端点调用 build_for_user(current_user.id)，不接受 user_id 参数
  - 不引入 APScheduler / Celery
  - 全局批量重建（run_batch）保留为内部函数，供未来 Admin API 使用
```

### 4.3 观测窗口

- 默认 `observation_window_days = 30`（已在模型中定义）
- Event 聚合均基于 `LearningEvent.occurred_at >= now - 30 days`
- Pattern 的 evidence window 已由 PatternUpdateEngine 管理（50条），Profile 不重复管理

### 4.4 增量 vs. 全量重算

Phase 2C-4 采用**全量重算**：每次 Job 从头重算所有字段。

理由：
- Profile 字段较少（12个）
- 聚合查询以 user_id + 30天窗口为边界，不需要全表扫描
- 简化实现，避免增量逻辑的边界 bug
- 数据量增长到一定规模后（Phase 2C-6+）再考虑增量

---

## 5. Profile Scope 与查询降级

### 5.1 三级 Scope 定义

| Scope | 含义 | Profile 粒度 |
|-------|------|-------------|
| `user` | 跨所有目标的全局行为 | 一个用户一条 user Profile |
| `goal` | 某个具体目标的学习行为 | 每个 goal 一条 goal Profile |
| `skill_category` | 按技能分类的行为（预留） | Phase 2C-5 实现 |

### 5.2 Profile 构建范围（Phase 2C-4）

Phase 2C-4 实现：
- **user-level Profile**：aggregates all goals，`goal_id = NULL`
- **goal-level Profile**：per active goal，`goal_id = <goal_id>`

Phase 2C-4 **不实现** `skill_category` scope（D-5 确认）：

```python
# profile_builder.py
def build_for_scope(db, user_id, scope, goal_id=None, skill_category=None):
    if scope == "skill_category":
        raise NotImplementedError(
            "skill_category scope is reserved for Phase 2C-5"
        )
```

Phase 2C-5 再实现：
- skill_category Profile

### 5.3 Agent 查询降级链

Agent 请求特定 goal 的 Profile 时，使用以下降级链：

```
1. goal Profile（goal_id = X，event_count ≥ 5）
       ↓ 若不存在或 event_count < 5
2. user Profile（goal_id = NULL）
       ↓ 若不存在或全部字段为 NULL
3. 系统默认值（system default，见 §7）
```

降级触发条件：
- goal Profile 不存在：该 goal 尚未积累足够事件
- `event_count < 5`：数据不足以支撑有意义的 Profile
- 字段全为 NULL：Pattern 均为 candidate 且 Event 也不足

### 5.4 哪些字段是 goal-scoped

| 字段 | Scope | 说明 |
|------|-------|------|
| completion_rate_30d | goal | 完成率因目标而异 |
| mastery_rate_30d | goal | 掌握率因目标而异 |
| mastery_velocity | goal | 掌握速度因目标而异 |
| consistency_score | user | 跨目标一致性行为 |
| weekly_active_days | user | 总学习频率 |
| avg_session_duration_mins | user | 时长习惯跨目标一致 |
| avg_daily_investment_mins | user/goal | goal Profile 时按 goal 过滤 |
| preferred_hour_start/end | user | 时间偏好跨目标一致 |
| preferred_weekdays | user | 同上 |
| estimation_accuracy | user | 估时习惯跨目标一致 |
| debt_tendency | user | 拖延习惯跨目标一致 |
| reschedule_rate | user/goal | goal Profile 时用 goal-scoped Pattern |

---

## 6. Profile Builder Pipeline

### 6.1 整体流程

```
[触发：每日凌晨 or API 调用]
           ↓
ProfileBuilder.run_batch(db)
           ↓
   查询活跃用户列表
  （最近30天有 LearningEvent 的用户）
           ↓
   for each user:
       ProfileBuilder.build_for_user(db, user_id)
           ↓
       ① 查询该用户的 Active/Decayed Patterns
       ② 查询该用户最近30天 LearningEvents
       ③ 计算各指标（Pattern优先，降级到 Event 聚合）
       ④ Upsert learner_profiles（user-level）
       ⑤ for each active goal:
              计算 goal-level 指标
              Upsert learner_profiles（goal-level）
           ↓
   db.commit()（按用户批次提交）
           ↓
   返回：processed_users 数量
```

### 6.2 Pattern 读取策略

```python
# 仅读取 active 或 decayed 状态的 Pattern
# candidate 状态说明数据不足，不用于 Profile
# archived 状态说明规律已过时，不用于 Profile

valid_statuses = ["active", "decayed"]

patterns = SELECT * FROM learner_patterns
    WHERE user_id = :user_id
    AND status IN ('active', 'decayed')
```

`decayed` 状态的 Pattern 仍可使用，但 Profile Builder 应将其对应字段**打折处理**：

```python
# 降权公式（confidence 低于阈值时，字段值与降级计算做加权平均）
# 目的：平滑从 Pattern 到 Event 聚合的过渡，避免突变

if pattern.status == "decayed" and pattern.confidence < 0.4:
    weight = pattern.confidence / 0.4  # 0.0 ~ 1.0
    value = pattern_value × weight + event_fallback_value × (1 - weight)
else:
    value = pattern_value
```

### 6.3 Metric Calculator 结构

```
profile_builder.py
    ├── ProfileBuilder（主入口）
    │     ├── run_batch(db) → int
    │     ├── build_for_user(db, user_id) → None
    │     └── _build_profile(db, user_id, goal_id) → dict[str, Any]
    │
    └── profile_metrics.py（纯函数，无 IO）
          ├── calc_consistency(patterns, events, window) → float | None
          ├── calc_session_duration(patterns, events) → float | None
          ├── calc_daily_investment(events, window) → float | None
          ├── calc_completion_rate(patterns, events, window) → float | None
          ├── calc_mastery_rate(events, window) → float | None
          ├── calc_mastery_velocity(patterns, events) → float | None
          ├── calc_preferred_hours(patterns, events) → tuple[int,int] | None
          ├── calc_preferred_weekdays(patterns, events) → list[int] | None
          ├── calc_estimation_accuracy(patterns, events) → float | None
          ├── calc_debt_tendency(patterns, events) → float | None
          └── calc_reschedule_rate(patterns, events) → float | None
```

**设计原则**：
- `profile_metrics.py` 中所有函数只接受 Python 对象，不接触数据库
- 每个 calc_* 函数独立可测试
- `ProfileBuilder` 负责查询 + 调用 calc_* + 写入，不包含计算逻辑

---

## 7. 冷启动设计

### 7.1 冷启动场景

| 场景 | 特征 | Profile 状态 |
|------|------|-------------|
| 全新用户 | event_count = 0 | 所有指标 = NULL |
| 新目标（用户有历史）| goal event_count < 5 | 降级到 user Profile |
| 历史较少（< 7 天数据）| event_count < 10 | 部分字段 NULL，部分字段用 Event 降级 |

### 7.2 新用户 Profile 初始值

```python
# 新用户首次 Profile（全字段 NULL，仅 event_count = 0）
LearnerProfile(
    user_id = user_id,
    goal_id = None,
    consistency_score = None,       # 无数据
    weekly_active_days = None,
    avg_session_duration_mins = None,
    avg_daily_investment_mins = None,
    completion_rate_30d = None,
    mastery_rate_30d = None,
    mastery_velocity = None,
    preferred_hour_start = None,
    preferred_hour_end = None,
    preferred_weekdays = None,
    estimation_accuracy = None,
    debt_tendency = None,
    reschedule_rate = None,
    observation_window_days = 30,
    event_count = 0,
    last_computed_at = None,
)
```

### 7.3 Agent 冷启动处理

Agent 读取 Profile 时应检查 `event_count`：

```python
if profile.event_count == 0:
    # 使用系统默认参数（conservative defaults）
    context = SystemDefaultProfile()
elif profile.event_count < 10:
    # 数据有限，降低置信度
    context = ProfileWithLowConfidence(profile)
else:
    context = profile
```

**系统默认参数**（保守值，不做任何个性化假设）：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| consistency_score | None | 不假设 |
| avg_session_duration_mins | None | 不假设 |
| preferred_hour_start | None | 不假设 |
| completion_rate_30d | None | 不假设 |
| debt_tendency | 0.0 | 默认无拖延倾向 |

> 注意：Phase 2C-4 不实现 Onboarding 问卷注入（保留 `system_prior` source 入口，实现留 Phase 2C-5）。

### 7.4 `event_count` 字段的含义

`learner_profiles.event_count` = observation_window 内该用户（或该 goal）的有效 LearningEvent 总数。

Agent 可以据此判断 Profile 的可信度：
- `event_count < 5`：极低置信度，建议使用 user Profile 降级
- `5 ≤ event_count < 20`：中等置信度，部分字段可信
- `event_count ≥ 20`：高置信度

---

## 8. Agent 接口设计

### 8.1 Agent 读取的三层数据

```
Agent Decision Context
        ├── LearnerProfile（当前状态快照，batch 每日刷新）
        │       └── 12 个数值指标
        │
        ├── Active Patterns（长期行为知识，近实时）
        │       └── status IN ('active', 'decayed')，含 pattern_value + confidence
        │
        └── Recent Events（最近 N 条原始事件，用于上下文）
                └── 最近 10–20 条 LearningEvent
```

### 8.2 查询入口设计

```python
# 文件：src/intelligence/profile_reader.py

class ProfileReader:
    """Agent 读取入口，整合 Profile + Pattern + Recent Events。"""

    @classmethod
    async def get_decision_context(
        cls,
        db: AsyncSession,
        user_id: str,
        goal_id: str | None = None,
        recent_event_limit: int = 20,
    ) -> DecisionContext:
        """
        按降级链查询 Profile，合并 Active Patterns 和 Recent Events。

        降级链：goal Profile → user Profile → system default
        """
```

### 8.3 DecisionContext 数据结构

```python
@dataclass
class DecisionContext:
    profile: LearnerProfile          # 当前状态快照
    active_patterns: list[LearnerPattern]  # 长期知识
    recent_events: list[LearningEvent]     # 近期原始事件
    data_quality: DataQuality         # 数据质量标注

@dataclass
class DataQuality:
    profile_event_count: int          # profile.event_count
    profile_scope: str                # "goal" / "user" / "default"
    pattern_count: int                # active pattern 数量
    low_confidence_fields: list[str]  # 置信度低于阈值的字段名
```

### 8.4 Profile Builder 绝对不输出

| 禁止输出 | 应由谁负责 |
|---------|-----------|
| 文字建议（"你应该每天学习2小时"）| Agent（Phase 2C-5）|
| 计划调整指令 | Agent + GoalService |
| 任何 AI 生成内容 | LLM 层 |
| Pattern 修改 | PatternUpdateEngine |
| 目标进度评估 | GoalService |

---

## 9. 实现步骤

### Step 1：profile_metrics.py（纯函数计算层）

文件：`backend/src/intelligence/profile_metrics.py`

实现所有 `calc_*` 纯函数，每个函数签名：
```python
def calc_consistency(
    patterns: list[LearnerPattern],
    events: list[LearningEvent],
    window_days: int = 30,
) -> float | None:
```

要点：
- 函数只操作已传入的 Python 对象，无 DB IO
- Pattern 优先，confidence < 0.4 或 status == "candidate" 时降级到 Event 聚合
- 数据不足时返回 `None`，不猜测

### Step 2：ProfileBuilder Service

文件：`backend/src/intelligence/profile_builder.py`

实现：
- `ProfileBuilder.build_for_user(db, user_id)` — 构建该用户的 user Profile + 所有 active goal Profile
- `ProfileBuilder.run_batch(db)` — 批量重建所有活跃用户的 Profile（内部函数，供未来 Admin 使用）
- `_upsert_profile(db, user_id, goal_id, metrics)` — 写入 learner_profiles 表

### Step 2.5：DecayTask（D-3 确认，Phase 2C-4 同步实现）

文件：`backend/src/intelligence/decay.py`

背景：`PatternUpdateEngine.apply_decay()` 已实现衰减公式（宽限期14天，按 decay_rate 指数衰减）。DecayTask 是调用该函数的批处理 Job。

实现：

```python
class DecayTask:
    """扫描所有活跃 Pattern，对超过宽限期的 Pattern 执行 confidence 衰减。

    - 触发：每日 Batch（与 ProfileBuilder 同批次触发，先 Decay 再 Build）
    - 幂等：同一天多次运行不会超额衰减（confidence 只向下，Agent 读取最新值）
    - 无新依赖：直接使用 AsyncSession
    """

    @classmethod
    async def run(cls, db: AsyncSession, now: datetime | None = None) -> int:
        """衰减所有 active/decayed Pattern，更新 status。

        Returns:
            处理的 Pattern 数量
        """
        now = now or datetime.utcnow()
        stmt = select(LearnerPattern).where(
            LearnerPattern.status.in_(["active", "decayed"])
        )
        result = await db.execute(stmt)
        patterns = result.scalars().all()

        updated = 0
        for pattern in patterns:
            new_conf = PatternUpdateEngine.apply_decay(pattern, now)
            if abs(new_conf - pattern.confidence) < 1e-6:
                continue  # 未超宽限期，跳过
            pattern.confidence = new_conf
            pattern.updated_at = now
            # Lifecycle：confidence 低于 archive 阈值 → archived
            if new_conf < ARCHIVED_CONFIDENCE_THRESHOLD:
                pattern.status = "archived"
            elif new_conf < DECAYED_TO_ACTIVE_CONFIDENCE:
                pattern.status = "decayed"
            updated += 1

        return updated
```

执行顺序（API 端点内）：

```
POST /api/v1/learner/profile/rebuild
    1. await DecayTask.run(db)           # 先衰减 Pattern confidence
    2. await ProfileBuilder.build_for_user(db, user_id)  # 再构建 Profile
    3. await db.commit()
```

### Step 3：Profile Reader（Agent 接口）

文件：`backend/src/intelligence/profile_reader.py`

实现：
- `ProfileReader.get_decision_context(db, user_id, goal_id)` — 返回 DecisionContext
- 降级链逻辑
- DataQuality 计算

### Step 4：Profile Rebuild API

文件：`backend/src/api/learner.py`（挂在现有 learner 路由，或新建 intelligence.py 均可）

端点（D-4 确认设计）：

```
POST /api/v1/learner/profile/rebuild
    Auth: Depends(get_current_user)（普通用户，仅操作自己）
    Body: 无（不接受 user_id 参数）
    Response: { "processed_goals": N, "elapsed_ms": M }
    行为：
      1. DecayTask.run(db)                          # 衰减当前用户 Pattern
      2. ProfileBuilder.build_for_user(db, user_id) # 重建 user + goal Profile
      3. db.commit()

GET /api/v1/learner/profile
    Query: goal_id (optional)
    Auth: Depends(get_current_user)
    Response: DecisionContext（JSON）
    行为：ProfileReader.get_decision_context(db, user_id, goal_id)
```

> 注：全局批量重建（所有用户）保留为 `ProfileBuilder.run_batch(db)` 内部函数，Phase 2C-5 实现 Admin API 时调用。

### Step 5：Tests

文件：`backend/tests/test_profile_builder.py`

内容见 §10。

---

## 10. 测试策略

### 10.1 单元测试（profile_metrics.py）

对每个 `calc_*` 函数：
- **Pattern 路径**：传入 active Pattern，验证值正确取自 pattern_value
- **降级路径**：传入 candidate Pattern + Events，验证降级到 Event 聚合
- **NULL 路径**：传入空 Pattern 列表和空 Event 列表，验证返回 None
- **decayed 降权**：传入 decayed Pattern（confidence=0.2），验证加权混合逻辑

关键测试用例：

```python
# preferred_hour_start/end: peak_hours 跨度 > 8 小时时的截断逻辑
# consistency_score: 正确除以7，clamp到[0,1]
# completion_rate_30d: goal-scoped vs user-scoped 路由
# estimation_accuracy: filtered mean（排除 estimated_mins=0）
```

### 10.2 集成测试（profile_builder.py）

全流程：

```
创建 User + Goal
       ↓
写入 LearningEvents（多种 event_type）
       ↓
运行 EventProcessor（生成 LearnerPattern）
       ↓
运行 ProfileBuilder.build_for_user()
       ↓
验证 LearnerProfile 字段正确
```

具体测试：

| 测试 | 验证内容 |
|------|---------|
| `test_build_user_profile_from_patterns` | 活跃 Pattern 路径，字段从 pattern_value 正确读取 |
| `test_build_user_profile_fallback_to_events` | 无 Pattern 时，字段从 Event 聚合计算 |
| `test_build_goal_profile` | goal-scoped 字段（completion_rate/mastery_velocity）与 user 字段分别正确 |
| `test_cold_start_profile` | 无事件时，profile.event_count=0，所有指标=None |
| `test_run_batch_updates_all_users` | run_batch() 覆盖多用户，各自 Profile 独立正确 |
| `test_profile_scope_fallback` | goal Profile event_count < 5，ProfileReader 降级到 user Profile |

### 10.3 测试策略说明

- 使用与 Phase 2C-3 相同的 SQLite in-memory + `db` fixture
- `profile_metrics.py` 单元测试：完全不需要 db fixture，只传 Python 对象
- 集成测试依赖 Phase 2C-3 的 EventProcessor：先运行 `process_event()` 生成 Pattern，再运行 ProfileBuilder
- 使用独立的 user_id（`_make_user()` 辅助函数）避免跨测试数据污染

---

## 11. 设计决策记录（Design Decisions）

> V2 更新：§11 原"待确认问题"已全部确认，转为正式决策记录。

| 编号 | 决策项 | 确认结论 | 影响位置 |
|------|--------|---------|---------|
| D-1 | `preferred_hour_start/end` 多峰处理 | **粗粒度 min/max**：Profile 字段取 peak_hours 的 min 和 max+1，不做截断；精细多峰细节保留在 Pattern.pattern_value.peak_hours 供 Agent 直接读取 | §3.5、`calc_preferred_hours()` |
| D-2 | `avg_daily_investment_mins` 分母 | **活跃学习天数**（有 LearningEvent 的不重复日期数）；反映"学习时的平均日投入"，排除零值天 | §3.2、`calc_daily_investment()` |
| D-3 | DecayTask 实现时机 | **Phase 2C-4 同步实现**，文件 `src/intelligence/decay.py`；先 Decay 再 Build 的执行顺序写入 API 端点 | §9 Step 2.5、`decay.py` |
| D-4 | Profile Rebuild API 权限与路径 | **普通用户权限**（`Depends(get_current_user)`），路径 `POST /api/v1/learner/profile/rebuild`，仅重建当前用户自己的 Profile；全量批量重建为内部函数留 Phase 2C-5 | §4.2、§9 Step 4 |
| D-5 | `skill_category` Scope 处理 | **保留接口，暂不实现**：`ProfileBuilder` 的 scope 参数接受 `skill_category` 但立即抛 `NotImplementedError("skill_category scope is reserved for Phase 2C-5")`；Phase 2C-5 实现 | §5.2、`profile_builder.py` |

### 各决策对实现的直接影响

**D-1 → `calc_preferred_hours()`**：
```python
def calc_preferred_hours(patterns, events) -> tuple[int, int] | None:
    # 直接取 min / max+1，无跨度截断逻辑
    peak_hours = pattern_value.get("peak_hours", [])
    if not peak_hours:
        return _fallback_preferred_hours(events)
    return min(peak_hours), max(peak_hours) + 1
```

**D-2 → `calc_daily_investment()`**：
```python
def calc_daily_investment(events, window_days=30) -> float | None:
    checkins = [e for e in events if e.event_type == "CheckinSubmitted"]
    total_mins = sum(e.payload.get("time_investment_mins", 0) for e in checkins)
    active_days = len({e.occurred_at.date() for e in checkins})
    if active_days == 0:
        return None
    return round(total_mins / active_days, 1)   # 分母 = 活跃日数
```

**D-3 → API 端点执行顺序**：
```python
@router.post("/profile/rebuild")
async def rebuild_profile(current_user=Depends(get_current_user), db=Depends(get_db)):
    t0 = time.monotonic()
    await DecayTask.run(db)                              # Step 1: 先衰减
    result = await ProfileBuilder.build_for_user(db, current_user.id)  # Step 2: 再构建
    await db.commit()
    return {"processed_goals": result["goal_count"], "elapsed_ms": int((time.monotonic()-t0)*1000)}
```

**D-4 → 无 `user_id` 参数**：API Body 为空，路径为 `/api/v1/learner/profile/rebuild`。

**D-5 → `NotImplementedError`**：
```python
if scope == "skill_category":
    raise NotImplementedError("skill_category scope is reserved for Phase 2C-5")
```

---

> **文档状态**：V2（Phase 2C-4，Design Review 完成，所有决策已确认，待执行实现命令）
> **下一步**：收到执行命令后，按 §9 Step 1 → 2 → 2.5 → 3 → 4 → 5 顺序实现
