# Phase 2C-1: PlanPilot Learner Model Schema V1

> **文档状态**: 设计稿 V2（审核修订，待 Phase 2C-2 实现）
> **创建时间**: 2026-07-29
> **修订时间**: 2026-07-29（架构审核：6项补充）
> **前置阶段**: Phase 2B-2（Learning Events 9/9 通过）
> **本阶段范围**: 纯设计分析，不修改任何代码

---

## 目录

1. 背景与目标
2. 当前 Learning Events 长期建模能力分析
3. 缺失事件与信号 Gap
   - 3.1 当前版本 Gap
   - 3.2 Phase 2C-2 需要的新事件
   - 3.3 ⚠️ Study Session 模型缺口（Phase 2C-3.5 预留）
4. Learner Model Schema 设计
   - 4.1 `learner_profiles` 表 — 当前状态快照（State）
   - 4.2 `learner_patterns` 表 — 长期行为知识（Knowledge）
   - 4.3 `pattern_evidences` 表
5. Pattern 类型目录（第一批）
6. Learning Event → Pattern 更新规则
   - 6.1 规则表
   - 6.2 Pattern Extraction 管道设计
   - 6.3 Extraction Rule 定义格式
7. Pattern 生命周期
8. Agent Decision Loop 接口
9. ER 关系图
10. 实现路线图
11. 设计决策记录
12. 架构决定（已确认）

---

## 1. 背景与目标

### 1.1 为什么需要 Learner Model？

当前 `learning_events` 是**原始事件流**：记录了"发生了什么"，但没有**提炼**"这个人是什么样的学习者"。

AI Agent 做决策需要：
- 知道用户**习惯在什么时间学习**（避免在低效时段排任务）
- 知道用户**通常能完成多少任务**（避免计划过于密集）
- 知道用户**掌握速度**（避免进度过快或过慢）
- 知道用户**拖延模式**（预防性调整而非事后补救）

这些都需要**从事件流中提炼出持久化的行为模型**，即 Learner Model。

### 1.2 三层架构与职责分工

```
learning_events（原始事件流，append-only）
        │
        ↓ Event Processor（近实时，分钟级）
        │
        ├──→ learner_patterns（长期行为知识 / Knowledge）
        │         行为规律、confidence、生命周期
        │         增量维护，事件驱动更新
        │
        └──→ pattern_evidences（溯源链，append-only）

        ↓ Profile Builder（批处理，每日）

learner_profiles（当前状态快照 / State）
        统计聚合值，无 confidence，直接反映近期数字

        ↓ 查询（Agent 同时读取两层）

Agent Decision Loop（决策建议）
        ↓ 输出
DecisionProposal（待用户确认或自动执行）
```

**Profile（State）vs Pattern（Knowledge）职责边界**:

| | `learner_profiles` (State) | `learner_patterns` (Knowledge) |
|---|---|---|
| 存储什么 | 当前统计数字 | 推断出的行为规律 |
| 示例 | `completion_rate_30d=0.82` | `preferred_learning_time: 21:00-23:00, confidence=0.86` |
| 更新方式 | 每日批处理重算 | 事件驱动增量更新 |
| 是否有 confidence | ❌ 是事实，不需要 | ✅ 是推断，必须有 |
| Agent 用途 | "用户现在状态如何" | "用户长期倾向是什么" |
| 典型字段 | `avg_session_duration_mins` | `pattern_value.median_mins` |

> **判断规则**: 一个信号是"近期统计事实"就放 Profile；是"从历史中推断的规律"且需要 confidence 就放 Pattern。

---

## 2. 当前 Learning Events 长期建模能力分析

基于已实现的 9 种事件类型，逐一分析其建模价值：

### 2.1 TaskCompleted

**payload 字段**: `title`, `scheduled_date`, `completed_at`, `actual_mins`, `mastery_level`, `days_overdue`

| 可提取信号 | 提取方式 | 支撑的 Pattern |
|-----------|---------|--------------|
| 时间偏好 | `occurred_at.hour` | `preferred_learning_time` |
| 专注时长 | `actual_mins` | `preferred_session_length` |
| 掌握质量 | `mastery_level`（L0–L4） | `mastery_velocity`, `focus_peak_time` |
| 拖延程度 | `days_overdue` | `delay_pattern` |
| 完成行为 | 事件本身存在 | `completion_rate_trend` |
| 估时偏差 | `actual_mins` ÷ 任务 `estimated_mins` | `estimation_accuracy` |

**注意**: `estimated_mins` 在 payload 中**未被保存**（来自 Task 记录本身）。计算估时偏差需要 JOIN `tasks` 表，这是一个轻微的信号劣化点。

---

### 2.2 TaskSkipped

**payload 字段**: `title`, `scheduled_date`, `skip_reason`（自由文本）, `debt_created`

| 可提取信号 | 提取方式 | 支撑的 Pattern |
|-----------|---------|--------------|
| 跳过时间分布 | `occurred_at.weekday()` + `hour` | `distraction_pattern` |
| 债务倾向 | `debt_created=True` 频率 | `delay_pattern` |
| 完成率分母 | 跳过即未完成 | `completion_rate_trend` |

**局限**: `skip_reason` 是自由文本，无法程序化分类。Phase 2C-1 忽略此字段。

---

### 2.3 MasteryRecorded

**payload 字段**: `task_title`, `from_level`, `to_level`, `submission_mode`

| 可提取信号 | 提取方式 | 支撑的 Pattern |
|-----------|---------|--------------|
| 掌握速度 | `(to_level_int - from_level_int)` ÷ 时间差 | `mastery_velocity` |
| 主动学习倾向 | `submission_mode == "manual_update"` 比例 | 辅助 `focus_peak_time` |
| 更新时间 | `occurred_at.hour` | `focus_peak_time` |

**mastery_level 数字化映射**: `unknown=0, L1=1, L2=2, L3=3, L4=4`

---

### 2.4 CheckinSubmitted

**payload 字段**: `date`, `mode`, `completion_rate`, `mastery_rate`, `total_tasks`, `completed_count`, `time_investment_mins`, `reflection`

| 可提取信号 | 提取方式 | 支撑的 Pattern |
|-----------|---------|--------------|
| 打卡频率 | 每个日期出现即为活跃天 | `weekly_learning_frequency` |
| 完成率序列 | `completion_rate` 时间序列 | `completion_rate_trend` |
| 实际学习时长 | `time_investment_mins` | `preferred_session_length` |
| 打卡时间点 | `occurred_at.hour` | `preferred_learning_time` |
| 掌握质量 | `mastery_rate` | `mastery_velocity` 辅助信号 |

**注意**: `time_investment_mins` 为用户自填，存在主观误差，confidence 权重应低于 `TaskCompleted.actual_mins`。

---

### 2.5 TaskRescheduled

**payload 字段**: `title`, `from_date`, `to_date`, `trigger`

| 可提取信号 | 提取方式 | 支撑的 Pattern |
|-----------|---------|--------------|
| 改期触发原因 | `trigger` 枚举 | `plan_adherence`, `delay_pattern` |
| 习惯性延期 | 同一任务多次改期 | `delay_pattern` |

`trigger` 值含义：
- `user_manual` → 主动调整，健康
- `ai_auto_adjust` → Agent 触发，可能是 Pattern 驱动
- `debt_rollover` → 自动滚期，慢性债务累积警告

---

### 2.6 其他事件（建模价值较低）

| 事件 | 建模相关性 |
|------|-----------|
| `GoalCreated` | 建立 Profile 基线，无直接 Pattern 更新 |
| `GoalStatusChanged` | `paused`/`abandoned` → 一致性负信号 |
| `GoalUpdated` | 目标调整频率可作为规划稳定性参考 |
| `TaskCreated` | 建立任务基线，暂不提取 Pattern |

---

## 3. 缺失事件与信号 Gap

### 3.1 当前版本 Gap（Phase 2C-1 可接受，不阻塞）

| Gap | 原因 | 影响 | 缓解方式 |
|-----|------|------|---------|
| `TaskCompleted.payload` 无 `estimated_mins` | 设计时未快照 | 估时偏差需 JOIN tasks | 查询时关联，性能可接受 |
| `time_investment_mins` 主观性 | 用户自填 | 时长统计噪声较大 | 降低权重，以 `actual_mins` 为主 |
| `skip_reason` 非结构化 | 自由文本 | 无法程序化分类 | Phase 2C-1 忽略；未来考虑枚举化 |
| 无 `TaskStarted` 事件 | 未实现 | 无客观专注时长 | 使用 `actual_mins` + checkin 估算 |

### 3.2 Phase 2C-2 需要的新事件（本阶段不实现）

这些事件对 Agent 决策反馈循环至关重要，设计时需预留 aggregate_type：

| 事件类型 | aggregate_type | 说明 |
|---------|---------------|------|
| `PlanGenerated` | `plan` | AI 生成计划（已在 2B-1 设计中定义） |
| `PlanActivated` | `plan` | 用户激活计划（已定义） |
| `AgentProposalMade` | `proposal` | Agent 发出建议（新增） |
| `AgentProposalAccepted` | `proposal` | 用户接受建议（新增） |
| `AgentProposalRejected` | `proposal` | 用户拒绝建议（新增）—— 最重要的反馈信号 |

> **设计原则**: Phase 2C-1 仅使用已有的 9 种事件。`PlanGenerated`/`PlanActivated` 在 Phase 2C-2 集成 PlanService 时同步实现。

---

### 3.3 ⚠️ Study Session 模型缺口（Phase 2C-3.5 预留）

**问题**: `TaskCompleted.actual_mins` 同时承担了"学习时间"和"专注时间"两种职责，但两者并不等价。

**具体场景**:
```
用户 10:00 打开任务
    学习20分钟
    去喝咖啡（中断15分钟）
    回来继续学习40分钟
    17:30 标记任务完成

TaskCompleted.actual_mins = 60  （用户填写的预估）
实际有效专注时间 = 60分钟
实际开始时间 = 10:00
实际结束时间 = 17:30（但中间有大段空闲）
```

**能建模的（有 actual_mins）**:
- ✅ `preferred_session_length`（单次任务用时）
- ✅ `preferred_learning_time`（大概在什么时段活跃）
- ✅ `mastery_velocity`（完成速度）

**无法精确建模的（缺 Session 数据）**:
- ⚠️ `focus_peak_time`：无法区分"专注的60分钟"和"拖了8小时才完成"
- ❌ 中断次数与中断模式
- ❌ 深度学习 vs 碎片化学习的区分

**为什么 Phase 2C-1 可接受这个缺口**:
- `focus_peak_time` 仍有统计意义——`occurred_at.hour` 反映用户**选择在什么时间标记完成**，与高质量时段有相关性
- `mastery_level` 结果是客观的，与时间点的交叉分析仍可反映生理节律

**Phase 2C-3.5 中需增加的事件**（预留，不阻塞当前实现）:

```yaml
# 未来事件设计（Phase 2C-3.5）
- event_type: TaskSessionStarted
  aggregate_type: task
  payload:
    task_id: uuid
    started_at: timestamp
    client_type: web | mobile

- event_type: TaskSessionEnded
  aggregate_type: task
  payload:
    task_id: uuid
    session_duration_mins: int   # 本次 Session 时长
    ended_reason: completed | paused | abandoned
```

增加 Session 模型后，可实现的新 Pattern：
- `focus_session_length`：单次不间断专注的最优时长
- `deep_work_time_preference`：用户在哪个时段能保持长 Session
- `context_switching_pattern`：日内任务切换频率

> **架构预留**: `learning_events` 的 `aggregate_type` 枚举将来扩展 `"session"`，不影响当前表结构。

---

## 4. Learner Model Schema 设计

### 4.1 `learner_profiles` 表 — 当前状态快照（State）

**职责**: 用户学习行为的**当前状态快照**，回答"用户现在的状态是什么"。

- 存储**近期统计数字**（近30日），不含推断，不含 confidence
- 由后台批处理任务**每日全量重算**，不增量维护
- Agent 读取时获取"此刻"的量化状态，而非历史规律

```sql
CREATE TABLE learner_profiles (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id                 UUID NULL REFERENCES goals(id) ON DELETE SET NULL,

    -- 一致性与频率
    consistency_score       FLOAT,         -- 0.0–1.0，近30日活跃天比例
    weekly_active_days      FLOAT,         -- 近4周平均每周活跃天数

    -- 时长统计
    avg_session_duration_mins FLOAT,       -- TaskCompleted.actual_mins 均值
    avg_daily_investment_mins FLOAT,       -- CheckinSubmitted.time_investment_mins 均值

    -- 完成质量
    completion_rate_30d     FLOAT,         -- 近30日 CheckinSubmitted 完成率均值
    mastery_rate_30d        FLOAT,         -- 近30日 mastery_rate 均值
    mastery_velocity        FLOAT,         -- 掌握等级提升速度（levels/week）

    -- 时间偏好（从 occurred_at 统计）
    preferred_hour_start    SMALLINT,      -- 活跃高峰起始小时 (0–23)
    preferred_hour_end      SMALLINT,      -- 活跃高峰结束小时 (0–23)
    preferred_weekdays      JSONB,         -- e.g. ["Mon","Wed","Fri","Sat"]

    -- 规划行为
    estimation_accuracy     FLOAT,         -- actual_mins / estimated_mins，1.0=精准
    debt_tendency           FLOAT,         -- 0.0–1.0，逾期任务比例
    reschedule_rate         FLOAT,         -- 改期任务占总任务比例

    -- 计算元数据
    observation_window_days INT  DEFAULT 30,
    event_count             INT  DEFAULT 0,  -- 本次计算使用的事件数
    last_computed_at        TIMESTAMP,
    created_at              TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_learner_profile UNIQUE (user_id, goal_id)
);

-- 索引
CREATE INDEX idx_learner_profiles_user_id ON learner_profiles(user_id);
CREATE INDEX idx_learner_profiles_goal_id ON learner_profiles(goal_id);
CREATE INDEX idx_learner_profiles_computed ON learner_profiles(last_computed_at);
```

**字段设计说明**:

| 字段 | 更新方式 | 为什么不实时更新 |
|------|---------|----------------|
| `consistency_score` | 每日批处理 | 需30日窗口聚合，单次事件无意义 |
| `preferred_hour_start/end` | 每周批处理 | 时间偏好是统计结论，需足量样本 |
| `mastery_velocity` | 每日批处理 | 计算跨多个 MasteryRecorded 事件 |
| `estimation_accuracy` | 每日批处理 | 需 JOIN tasks 表计算 |

**`goal_id` 为 NULL 的含义**: 全局 Profile（跨所有目标）。每个用户同时维护：
- 1 个全局 Profile（`goal_id IS NULL`）
- 每个活跃 Goal 各 1 个 Goal-scoped Profile

---

### 4.2 `learner_patterns` 表 — 长期行为知识（Knowledge）

**职责**: 存储从事件流中推断出的**个体长期行为规律**，回答"用户的学习倾向是什么"。

- 存储**带 confidence 的推断结论**，需要足够样本才能成立
- 由 Event Processor **事件驱动增量维护**（近实时，分钟级延迟）
- confidence 随时间自然衰减，反映规律是否仍然有效
- Agent 读取时获取"这个人的长期倾向"，结合 Profile 状态做决策

```sql
CREATE TABLE learner_patterns (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id             UUID NULL REFERENCES goals(id) ON DELETE SET NULL,

    -- Pattern 身份
    pattern_type        VARCHAR(50)  NOT NULL,  -- 见 §5 Pattern 类型目录
    pattern_value       JSONB        NOT NULL,  -- 类型特定的结构化数据

    -- 统计质量
    confidence          FLOAT        NOT NULL DEFAULT 0.0,  -- 0.0–1.0
    evidence_count      INT          NOT NULL DEFAULT 0,    -- 累计支撑事件数

    -- 范围与衰减
    scope               VARCHAR(20)  NOT NULL DEFAULT 'goal',
    --   'user'           = 跨所有目标的全局规律（如时间偏好）
    --   'skill_category' = 同类目标共享的规律（如"算法类任务"的掌握速度）
    --   'goal'           = 特定目标的局部规律
    decay_rate          FLOAT        NOT NULL DEFAULT 0.05,
    --   每周无新证据时 confidence 的衰减比例
    --   不同 pattern_type 有不同默认值（见 §7）

    -- 生命周期
    status              VARCHAR(20)  NOT NULL DEFAULT 'candidate',
    --   candidate | active | decayed | archived
    first_observed_at   TIMESTAMP    NOT NULL,
    last_confirmed_at   TIMESTAMP,

    created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP    NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_learner_pattern UNIQUE (user_id, goal_id, pattern_type, scope)
);

CREATE INDEX idx_learner_patterns_user_id ON learner_patterns(user_id);
CREATE INDEX idx_learner_patterns_goal_id ON learner_patterns(goal_id);
CREATE INDEX idx_learner_patterns_status  ON learner_patterns(status, confidence);
CREATE INDEX idx_learner_patterns_type    ON learner_patterns(pattern_type, status);
```

**`scope` 三级层次**:

```
user（全局）
 └── skill_category（算法/语言/阅读/考试...）
       └── goal（具体目标）
```

例：用户"晚上学习效率高"是 `scope='user'` 的 `focus_peak_time`；
"算法类任务掌握速度慢于语言类"是 `scope='skill_category'` 的 `mastery_velocity`；
"这个 Python 目标的完成率趋势"是 `scope='goal'` 的 `completion_rate_trend`。

**`pattern_value` JSONB 结构由 `pattern_type` 决定**（见 §5 详细定义）。

**为什么 confidence 和 evidence_count 分开存储？**
- `evidence_count` 是累计计数，不衰减，反映"见过多少次"
- `confidence` 是当前置信度，会随时间衰减，反映"现在有多可信"
- 区分两者可识别：高 evidence 但低 confidence = 曾经有效但已过时的规律

---

### 4.3 `pattern_evidences` 表

**职责**: 记录每个 Pattern 的**每条支撑事件**，实现 Pattern → Event 的完整溯源链。

```sql
CREATE TABLE pattern_evidences (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pattern_id          UUID NOT NULL REFERENCES learner_patterns(id) ON DELETE CASCADE,
    learning_event_id   UUID NULL REFERENCES learning_events(id) ON DELETE SET NULL,
    --   SET NULL: 事件可能因 goal 删除而 SET NULL，但 evidence 记录保留

    contribution        FLOAT NOT NULL DEFAULT 1.0,
    --   该事件对 pattern_value 的贡献权重
    --   范围: 0.0–1.0
    --   例：recent event → 1.0，older event → 0.7（根据时效性衰减）

    recorded_at         TIMESTAMP NOT NULL,
    --   该证据被记录到 Pattern 的时间（≠ 原始事件的 occurred_at）

    meta                JSONB NOT NULL DEFAULT '{}',
    --   从事件中提取的结构化特征，例：
    --   {"extracted_hour": 21, "dow": "Tuesday", "mastery_level_int": 3}
    --   避免 Agent 重复解析原始事件

    created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pattern_evidences_pattern_id ON pattern_evidences(pattern_id);
CREATE INDEX idx_pattern_evidences_event_id   ON pattern_evidences(learning_event_id);
CREATE INDEX idx_pattern_evidences_recorded   ON pattern_evidences(recorded_at);
```

**为什么需要 `meta` 字段？**

Pattern 更新器提取事件中的关键特征（如`occurred_at.hour`），存入 `meta`。
Agent 查询时直接读 `meta`，无需重新解析原始 JSONB payload，降低查询复杂度。

**三表关系总结**:
```
learner_profiles ──── 聚合快照（定期重算）
learner_patterns ──── 行为规律（增量维护 + 衰减）
    └── pattern_evidences ──── 溯源记录（append-only）
            └── learning_events ──── 原始事件（append-only）

---

## 5. Pattern 类型目录（第一批）

### 5.1 Learning Habit 类

---

#### `preferred_learning_time`

**含义**: 用户倾向于在哪个时段学习（一天中的哪几小时）

**为什么需要**: AI 排任务时应优先选择用户的活跃时段，减少"排了但没做"

**提炼来源**: `TaskCompleted.occurred_at.hour`（权重高）、`CheckinSubmitted.occurred_at.hour`（权重低）

**`pattern_value` 结构**:
```json
{
  "peak_hours": [20, 21, 22],
  "secondary_hours": [7, 8],
  "day_type": "all",
  "tz_offset": 8
}
```

**默认 decay_rate**: `0.02`（习惯稳定，慢衰减）

---

#### `preferred_session_length`

**含义**: 用户单次有效学习时长的分布区间

**为什么需要**: 任务 `estimated_mins` 超出用户专注窗口时，完成率会降低

**提炼来源**: `TaskCompleted.actual_mins`（主）、`CheckinSubmitted.time_investment_mins / completed_count`（辅）

**`pattern_value` 结构**:
```json
{
  "p25_mins": 30,
  "median_mins": 60,
  "p75_mins": 90,
  "sample_count": 24
}
```

**默认 decay_rate**: `0.03`

---

#### `weekly_learning_frequency`

**含义**: 用户平均每周活跃学习几天，以及偏好哪几天

**为什么需要**: 计划密度（每周多少任务）应与用户实际活跃频率匹配

**提炼来源**: `CheckinSubmitted.date`（每个日期 → 活跃天）

**`pattern_value` 结构**:
```json
{
  "avg_days_per_week": 4.5,
  "preferred_days": ["Mon", "Tue", "Wed", "Sat", "Sun"],
  "low_days": ["Thu", "Fri"]
}
```

**默认 decay_rate**: `0.05`

---

### 5.2 Performance 类

---

#### `completion_rate_trend`

**含义**: 完成率的变化趋势（改善/稳定/下降）

**为什么需要**: 趋势下降是早期警告——应在用户放弃前主动干预

**提炼来源**: `CheckinSubmitted.completion_rate` 时间序列（线性回归斜率）

**`pattern_value` 结构**:
```json
{
  "current_30d_avg": 0.72,
  "previous_30d_avg": 0.65,
  "trend": "improving",
  "slope_per_week": 0.023,
  "volatility": 0.15
}
```

`trend` 枚举: `"improving"` | `"stable"` | `"declining"` | `"insufficient_data"`

**默认 decay_rate**: `0.10`（完成率波动大，快速更新）

---

#### `mastery_velocity`

**含义**: 用户掌握新知识的速度（等级提升 / 单位时间）

**为什么需要**: 计划进度预设与用户实际掌握速度不匹配时需重新校准

**提炼来源**: `MasteryRecorded`（from/to level + 时间差）、`TaskCompleted.mastery_level` 历史序列

**`pattern_value` 结构**:
```json
{
  "levels_per_week": 2.3,
  "time_to_L2_days": 3.5,
  "time_to_L3_days": 8.1,
  "time_to_L4_days": 18.2,
  "sample_count": 12
}
```

**默认 decay_rate**: `0.04`

---

#### `estimation_accuracy`

**含义**: 用户实际花费时间与任务计划时长的比值

**为什么需要**: 系统性低估（ratio > 1.3）意味着计划容量虚高，会导致慢性债务

**提炼来源**: `TaskCompleted.actual_mins` ÷ `tasks.estimated_mins`（需 JOIN）

**`pattern_value` 结构**:
```json
{
  "ratio": 1.25,
  "bias": "underestimate",
  "p50_ratio": 1.18,
  "p90_ratio": 1.85,
  "sample_count": 30
}
```

`bias` 枚举: `"underestimate"` | `"accurate"` | `"overestimate"`

**默认 decay_rate**: `0.03`（稳定个人特征，慢衰减）

---

### 5.3 Attention 类

---

#### `focus_peak_time`

**含义**: 用户在哪些时段的**掌握质量更高**（不仅仅是活跃，而是高效）

**为什么需要**: 与 `preferred_learning_time` 不同——用户"能学"的时段 ≠ "学得好"的时段，重要任务应排在高效时段

**提炼来源**: `TaskCompleted.occurred_at.hour` × `mastery_level` 交叉统计（同一小时段的平均 mastery_level）

**`pattern_value` 结构**:
```json
{
  "peak_hours": [20, 21],
  "peak_avg_mastery": 2.8,
  "low_hours": [13, 14],
  "low_avg_mastery": 1.6,
  "hour_mastery_map": {"20": 2.9, "21": 2.7, "13": 1.5}
}
```

**默认 decay_rate**: `0.04`

---

#### `distraction_pattern`

**含义**: 用户在哪些时间/星期几倾向于跳过任务

**为什么需要**: 预知而非事后处理——在已知高风险时段减少任务或主动发送提醒

**提炼来源**: `TaskSkipped.occurred_at` → 提取 `hour` + `weekday`

**`pattern_value` 结构**:
```json
{
  "high_skip_weekdays": ["Friday", "Sunday"],
  "high_skip_hours": [12, 13, 23],
  "skip_rate_by_dow": {"Friday": 0.45, "Sunday": 0.38},
  "total_skips_analyzed": 28
}
```

**默认 decay_rate**: `0.07`

---

### 5.4 Planning 类

---

#### `delay_pattern`

**含义**: 用户完成任务的延迟程度与债务恢复行为

**为什么需要**: 区分"偶尔拖延"（健康）与"慢性债务累积"（需干预）

**提炼来源**: `TaskCompleted.days_overdue`（延迟量）、`TaskRescheduled.trigger`（改期原因）、`TaskSkipped.debt_created`

**`pattern_value` 结构**:
```json
{
  "avg_days_overdue": 1.2,
  "chronic_delay_rate": 0.18,
  "observed_delay_rate": 0.40,
  "adjusted_delay_rate": 0.33,
  "effective_sample_count": 8,
  "supporting_count": 3,
  "opposing_count": 5,
  "excluded_count": 1,
  "evidence_strength": 0.73,
  "by_category": {
    "数据叙事": {"sample_count": 5, "delayed_count": 3, "delay_rate": 0.60}
  },
  "debt_accumulation_rate": 0.25,
  "debt_recovery_rate": 0.70,
  "reschedule_trigger_dist": {
    "user_manual": 0.60,
    "debt_rollover": 0.35,
    "ai_auto_adjust": 0.05
  }
}
```

`chronic_delay_rate`: `days_overdue > 3` 的任务占比。

`observed_delay_rate` 保留所有延期事实；`adjusted_delay_rate` 只使用有效行为证据。
用户把某次延期标记为外部中断时，该记录不会被删除，而是进入 `excluded_count`，
不参与行为模式统计。`evidence_strength` 只表示有效样本是否足够稳定，不表示用户
“想不想做”或理由真实性的概率。

**默认 decay_rate**: `0.05`

---

#### `plan_adherence`

**含义**: 用户对生成计划的遵从程度与修改行为

**为什么需要**: 频繁改期 + 改期后仍跳过 = 计划脱离现实，需重新生成

**提炼来源**: `TaskRescheduled` 频率 + 后续该任务的 `TaskCompleted`/`TaskSkipped` 事件

**`pattern_value` 结构**:
```json
{
  "reschedule_rate": 0.15,
  "skip_after_reschedule_rate": 0.32,
  "complete_after_reschedule_rate": 0.58,
  "plan_stability_score": 0.72
}
```

`plan_stability_score` = `1 - reschedule_rate × skip_after_reschedule_rate`

**默认 decay_rate**: `0.05`

---

## 6. Learning Event → Pattern 更新规则

### 6.1 规则表（事件 → 影响的 Pattern）

| 事件类型 | 目标 Pattern | 提取字段 | 更新方式 |
|---------|------------|---------|---------|
| `TaskCompleted` | `preferred_learning_time` | `occurred_at.hour` | 追加 evidence，更新时段分布 |
| `TaskCompleted` | `preferred_session_length` | `actual_mins` | 追加 evidence，更新分位数 |
| `TaskCompleted` | `completion_rate_trend` | 事件本身=完成 | 对应日期的完成计数+1 |
| `TaskCompleted` | `mastery_velocity` | `mastery_level`（与前值差） | 若等级提升则记录时间间隔 |
| `TaskCompleted` | `estimation_accuracy` | `actual_mins` ÷ `task.estimated_mins` | 追加 ratio evidence |
| `TaskCompleted` | `delay_pattern` | `days_overdue` | 逾期为支持、按时为反向，重算有效率 |
| `DelayAttributionRecorded` | `delay_pattern` | 目标延期事件 + 用户归因 | 保留延期事实，重算有效证据 |
| `TaskCompleted` | `focus_peak_time` | `occurred_at.hour` × `mastery_level` | 更新 hour → mastery 映射 |
| `TaskSkipped` | `distraction_pattern` | `occurred_at.weekday()` + `hour` | 追加 skip evidence |
| `TaskSkipped` | `delay_pattern` | `debt_created` | 债务计数+1 |
| `TaskSkipped` | `completion_rate_trend` | 事件本身=未完成 | 对应日期的跳过计数+1 |
| `TaskRescheduled` | `plan_adherence` | `trigger` | 改期类型分布更新 |
| `TaskRescheduled` | `delay_pattern` | `trigger == "debt_rollover"` | 慢性债务信号 |
| `MasteryRecorded` | `mastery_velocity` | `to_level - from_level` + 时间 | 核心 mastery 速度更新 |
| `MasteryRecorded` | `focus_peak_time` | `occurred_at.hour` × 等级提升幅度 | 高质量更新时段标记 |
| `CheckinSubmitted` | `weekly_learning_frequency` | `date`（活跃天） | 周历标记当日为活跃 |
| `CheckinSubmitted` | `completion_rate_trend` | `completion_rate` | 追加 evidence（权重高） |
| `CheckinSubmitted` | `preferred_session_length` | `time_investment_mins / completed_count` | 追加 evidence（权重低，主观） |
| `CheckinSubmitted` | `preferred_learning_time` | `occurred_at.hour` | 追加 evidence（权重低） |
| `GoalStatusChanged` | `completion_rate_trend` | `to_status` | `paused`/`abandoned` → 负信号 |
| `TaskCreated` | —— | —— | **不触发任何 Pattern 更新** |
| `GoalCreated` | —— | —— | **不触发任何 Pattern 更新** |
| `GoalUpdated` | —— | —— | **不触发任何 Pattern 更新**（高频噪声） |

---

### 6.2 Pattern Extraction 管道设计

当前 §6.1 的规则表是"结论"，实现时需要一个有状态的管道。否则 Phase 2C-3 会直接硬编码 if/else，导致新增事件类型时全局修改。

**管道架构**:

```
learning_events（DB，append-only）
        │
        │  Event Processor 轮询（游标位置: last_processed_event_id）
        ↓
┌───────────────────────────────────┐
│         Event Dispatcher          │
│                                   │
│  按 event_type 路由到对应的        │
│  Extraction Rule 列表             │
└───────────┬───────────────────────┘
            │
            ↓（并行执行该事件关联的所有 Rule）
┌──────────────────────────────────────┐
│     Pattern Extractor（per Rule）    │
│                                      │
│  1. 检查幂等性（event_id 已处理？）   │
│  2. 提取特征 → evidence.meta        │
│  3. 写入 pattern_evidences          │
│  4. 更新 learner_pattern.confidence │
│     + evidence_count               │
│  5. 触发生命周期检查                 │
└──────────────────────────────────────┘
            │
            ↓
learner_patterns（更新 confidence / status）
pattern_evidences（新增 evidence 记录）
```

**关键设计约束**:
- Event Processor 维护一个全局游标 `last_processed_at`（或 `last_processed_id`），每次批次处理窗口内新增事件
- 同一事件可触发多个 Rule，但每个 Rule 对同一事件只处理一次（幂等）
- Pattern 更新在同一数据库事务内完成（evidence 写入 + confidence 更新原子）

---

### 6.3 Extraction Rule 定义格式

每个 Extraction Rule 是一个可独立注册的配置对象，Phase 2C-3 实现时以此为单元组织代码：

```yaml
# Extraction Rule 格式（设计规范，实现时转为 Python dataclass）

extraction_rule:
  rule_id: "task_completed_to_preferred_time"

  source_event:
    event_type: TaskCompleted
    condition: null            # null = 无额外条件，所有此类事件均处理

  target_pattern:
    pattern_type: preferred_learning_time
    scope: user                # 此规律跨目标共享

  feature_extractor:
    # 从事件中提取什么特征存入 evidence.meta
    - field: extracted_hour
      source: occurred_at.hour

  evidence_weight:
    base_contribution: 1.0
    reliability: 0.9           # 客观来源，高可靠性
    # contribution = base_contribution × reliability

---

extraction_rule:
  rule_id: "task_completed_to_session_length"

  source_event:
    event_type: TaskCompleted
    condition: "payload.actual_mins IS NOT NULL AND payload.actual_mins > 0"

  target_pattern:
    pattern_type: preferred_session_length
    scope: user

  feature_extractor:
    - field: session_mins
      source: payload.actual_mins

  evidence_weight:
    base_contribution: 1.0
    reliability: 0.9

---

extraction_rule:
  rule_id: "checkin_to_session_length"

  source_event:
    event_type: CheckinSubmitted
    condition: "payload.completed_count > 0"

  target_pattern:
    pattern_type: preferred_session_length
    scope: user

  feature_extractor:
    - field: session_mins
      source: "payload.time_investment_mins / payload.completed_count"

  evidence_weight:
    base_contribution: 0.7    # 低于 task_completed，主观填写
    reliability: 0.6
```

**Rule 注册原则**:
- 每个 Rule 对应 `§6.1` 规则表中的一行
- `condition` 为空时处理所有该类型事件；非空时作为前置过滤
- `reliability` 反映数据来源可靠性（客观 > 系统计算 > 用户填报）
- 新增事件类型时只需新增 Rule，无需修改 Dispatcher

---

### 6.4 规则设计原则

1. **单一事件不改变 status**：一个新 evidence 只更新 `confidence` 和 `evidence_count`，status 变更由生命周期管理器决定。
2. **权重分级**：客观来源（`actual_mins`）> 系统计算（`days_overdue`）> 用户填报（`time_investment_mins`）。
3. **幂等性**：同一个 `learning_event_id` + `pattern_id` 组合不应被重复处理。`pattern_evidences` 建议加 UNIQUE 约束。
4. **不回溯历史**：分析器增量处理新事件，不重算历史（除非显式触发 rebuild）。
5. **最小化副作用**：每个 Rule 只更新自己负责的 Pattern，不读取其他 Pattern 状态。

---

## 7. Pattern 生命周期

### 7.1 状态定义

```
┌─────────────────────────────────────────────────────────────────┐
│                       Pattern 生命周期                           │
│                                                                 │
│  [No Pattern]                                                   │
│    ← 从未观测到此行为规律                                         │
│         │                                                       │
│         │ 第一个满足条件的 evidence 到达                          │
│         │ → 创建 Pattern 记录，confidence=0.3（初始值）           │
│         ↓                                                       │
│    [candidate]   ← 证据不足 / confidence < 0.6                  │
│         │           evidence_count < 5                          │
│         │                                                       │
│         │ evidence_count ≥ 5 AND confidence ≥ 0.6              │
│         ↓                                                       │
│      [active]    ← 新证据持续到达（re-promoted from decayed）    │
│         │                                                       │
│         │ 14天无新 evidence → confidence 按 decay_rate 衰减      │
│         ↓                                                       │
│     [decayed]    ← 新证据 re-promote 回 active                  │
│         │           (confidence 恢复到 ≥ 0.5)                   │
│         │                                                       │
│         │ confidence < 0.2 持续30天                             │
│         ↓                                                       │
│    [archived]    （永久保留，不可逆，仅用于审计）                  │
└─────────────────────────────────────────────────────────────────┘
```

**Candidate 创建条件**:

| 情况 | 处理方式 |
|------|---------|
| 第一次观测到行为（无 Pattern 记录）| 创建新 Pattern，`status='candidate'`，`confidence=0.3` |
| Pattern 已存在（任意 status） | 更新 confidence，不重新创建 |
| Cold Start（系统初始化）| 创建 Pattern，`status='candidate'`，`confidence=0.1`，`source=system_prior` |

---

### 7.2 状态转换规则

| 转换 | 触发条件 | 说明 |
|------|---------|------|
| No Pattern → `candidate` | 第一个 evidence 到达 | 自动创建，初始 confidence=0.3 |
| `candidate` → `active` | `evidence_count >= 5` AND `confidence >= 0.6` | 达到统计可信阈值 |
| `active` → `decayed` | 14天无新 evidence | 可能是行为已改变 |
| `decayed` → `active` | 新 evidence 使 `confidence >= 0.5` | 行为回归，重新激活 |
| `decayed` → `archived` | `confidence < 0.2` 持续30天 | 规律已消失 |
| `candidate` → `archived` | `evidence_count < 3` 且 `first_observed_at > 60天前` | 冷启动失败的孤立证据 |

对 `delay_pattern`，`active` 还必须满足 `effective_sample_count >= 5` 且
`adjusted_delay_rate > 0.5`。用户将一次延期标记为外部中断后，若有效样本或调整后
延期率跌破条件，Pattern 会变为 `decayed`，但原始延期事件仍可审计。

---

### 7.3 confidence 计算公式

**初始化**（创建 candidate 时）:
```
# 用户行为触发（有真实 evidence）
confidence_init = 0.3

# 系统 Prior（Cold Start，见 §12）
confidence_init = 0.1
source = "system_prior"
```

**新 evidence 到达时**（confidence 上升）:
```
# contribution 来自 Extraction Rule 的 evidence_weight
contribution = base_contribution × reliability
# base_contribution: 0.0–1.0（事件基础权重）
# reliability: 0.0–1.0（数据来源可靠性，客观/计算/用户填报三级）

# 学习率随证据增多递减（避免过度拟合早期噪声）
learning_rate = min(0.1, 5.0 / max(evidence_count, 1))

# confidence 更新（向1.0渐近）
confidence_new = confidence_old + contribution × learning_rate × (1.0 - confidence_old)

# Clamp（始终保持在合法范围）
confidence_new = max(0.0, min(1.0, confidence_new))
```

`delay_pattern` 是例外：它不把每条事件都当作同方向的正向证据，而是从最近窗口
重新投影。逾期任务是支持证据，按时完成是反向证据；用户标记为
`external_interruption` 的延期从有效样本中排除。其两个主要派生值为：

```text
adjusted_delay_rate = (1 + supporting_count) / (2 + effective_sample_count)
evidence_strength = effective_sample_count / (effective_sample_count + 3)
```

因此 `confidence` 在该 Pattern 上表示证据强度，不是用户动机、借口真实性或因果
归因的概率。归因由 `DelayAttributionRecorded` 追加事件记录，原始 `TaskCompleted`
事实保持 append-only。

**无新证据时**（每周衰减，由后台定时任务执行）:
```
weeks_since_confirmed = (NOW - last_confirmed_at).days / 7.0

# 宽限期：前2周不衰减（短暂中断不应破坏已建立的规律）
if weeks_since_confirmed > 2:
    decay_weeks = weeks_since_confirmed - 2
    confidence_new = confidence_old × ((1.0 - decay_rate) ** decay_weeks)

# Clamp
confidence_new = max(0.0, min(1.0, confidence_new))

# 写回
learner_pattern.confidence = confidence_new
learner_pattern.updated_at = NOW
```

**contradiction evidence（负证据，可选）**:
```
# 当新事件与已建立规律矛盾时（如：长期晚上学，突然连续早上学）
# contribution 取负值
contribution = -base_contribution × reliability × contradiction_strength
confidence_new = confidence_old + contribution × learning_rate × confidence_old
confidence_new = max(0.0, min(1.0, confidence_new))
```

> **实现注意**: 通用 Pattern 的 contradiction detection 仍可选；`delay_pattern` 已由
> 双向任务观测和 `DelayAttributionRecorded` 归因事件实现反向/排除逻辑。

---

### 7.4 各 Pattern 类型的 decay_rate 配置

| Pattern 类型 | decay_rate | 原因 |
|-------------|-----------|------|
| `preferred_learning_time` | 0.02 | 时间习惯极稳定，不易改变 |
| `estimation_accuracy` | 0.03 | 个人特征，相对稳定 |
| `preferred_session_length` | 0.03 | 随体力/习惯缓慢变化 |
| `mastery_velocity` | 0.04 | 学习速度渐变 |
| `focus_peak_time` | 0.04 | 生理节律相对稳定 |
| `weekly_learning_frequency` | 0.05 | 受生活节奏影响，中速变化 |
| `delay_pattern` | 0.05 | 习惯性拖延较稳定 |
| `plan_adherence` | 0.05 | 计划遵从度中等稳定 |
| `distraction_pattern` | 0.07 | 受外部事件影响，较易变化 |
| `completion_rate_trend` | 0.10 | 最易波动，快速响应 |

---

## 8. Agent Decision Loop 接口设计

### 8.1 接口概述

Agent 是**只读 Learner Model + 只写 Proposals** 的消费者，永远不直接修改 `tasks`、`plans` 表。

```
[Learner Model Layer]          [Agent Layer]              [Action Layer]
learner_profiles     →
learner_patterns     →  AgentDecisionInput  →  Agent  →  DecisionProposal
learning_events      →                                         ↓
goals / plans        →                              用户确认 / 自动执行
```

### 8.2 输入接口：`AgentDecisionInput`

```python
# 伪代码结构定义（Phase 2C-2 实现时转为 Pydantic 模型）

AgentDecisionInput:
    # 主体
    user_id:          str
    goal_id:          str

    # Learner Model 快照
    learner_profile:  LearnerProfileSnapshot
    active_patterns:  list[PatternSnapshot]
    #   只传 status='active' AND confidence >= 0.5 的 Pattern
    #   每个 PatternSnapshot 包含: id, pattern_type, pattern_value, confidence

    # 计划上下文
    current_plan:     PlanSummary
    #   包含: total_tasks, completed_tasks, upcoming_tasks(7天内), overdue_tasks

    # 近期事件（轻量引用，不含完整 payload）
    recent_events:    list[LearningEventRef]
    #   last 7 days，包含: event_type, occurred_at, aggregate_type

    # 决策上下文
    current_date:     date
    decision_context: DecisionContext  # 见 8.3

LearnerProfileSnapshot:
    consistency_score:       float
    completion_rate_30d:     float
    avg_session_duration_mins: float
    debt_tendency:           float
    preferred_hour_start:    int
    preferred_hour_end:      int

PlanSummary:
    plan_id:           str
    upcoming_tasks:    list[TaskBrief]  # 未来7天
    overdue_count:     int
    total_completion_rate: float
```

### 8.3 决策上下文枚举

| `decision_context` | 触发时机 | Agent 主要任务 |
|-------------------|---------|--------------|
| `daily_adjustment` | 每日早晨（定时任务）| 检查当日任务量是否合理，是否需要调整 |
| `checkin_analysis` | 用户提交打卡后 | 分析完成情况，给出反馈和建议 |
| `weekly_review` | 每周一（定时任务）| 回顾上周，调整本周计划密度 |
| `plan_regeneration` | 用户主动请求 OR 检测到计划严重偏轨 | 重新评估整体计划可行性 |

### 8.4 输出接口：`DecisionProposal`

```python
DecisionProposal:
    proposal_id:              str   # UUID，用于后续 AgentProposalActioned 事件
    proposal_type:            ProposalType
    reasoning:                list[str]  # 1-3条，引用具体 pattern_id
    confidence:               float      # 0.0–1.0
    proposed_changes:         dict       # 类型特定，见 8.5
    evidence_references:      list[str]  # 支撑此决策的 pattern_id 列表
    requires_user_confirmation: bool
    auto_apply_if_no_response:  bool     # False 时必须显式确认
    expires_at:               datetime | None

ProposalType:
    RESCHEDULE_OVERDUE_TASKS    # 将逾期任务重新排期
    REDUCE_DAILY_LOAD           # 降低每日任务量
    SHIFT_TASK_TIMING           # 将任务移到用户高效时段
    ADJUST_TASK_DIFFICULTY      # 建议调整任务难度
    SEND_LEARNING_NUDGE         # 发送学习提醒（无结构变更）
    REGENERATE_PLAN             # 建议重新生成计划
```

### 8.5 `proposed_changes` 各类型结构

```python
# RESCHEDULE_OVERDUE_TASKS
{
    "task_ids": ["uuid-1", "uuid-2"],
    "new_dates": {"uuid-1": "2026-08-01", "uuid-2": "2026-08-02"},
    "reason": "3 tasks overdue by avg 2.1 days based on delay_pattern"
}

# REDUCE_DAILY_LOAD
{
    "current_daily_avg": 4.2,
    "recommended_daily": 3.0,
    "adjustment_basis": "completion_rate_30d=0.58 below threshold 0.70"
}

# SHIFT_TASK_TIMING
{
    "task_ids": ["uuid-3"],
    "recommended_hour_start": 20,
    "recommended_hour_end": 22,
    "basis_pattern_id": "pattern-uuid-xxx"
}

# REGENERATE_PLAN
{
    "trigger_reason": "plan_adherence.reschedule_rate=0.45 exceeds 0.30 threshold",
    "suggested_daily_hours": 1.5,
    "suggested_task_duration_mins": 45
}
```

### 8.6 Agent 决策规则（最低约束）

1. **Proposal 必须引用至少1个 Pattern**: `evidence_references` 不可为空，Agent 不能"凭感觉"建议
2. **低置信度必须人工确认**: `confidence < 0.6` → `requires_user_confirmation = True`
3. **高影响操作必须人工确认**: `REGENERATE_PLAN` 永远 `requires_user_confirmation = True`
4. **Agent 不直接写 DB**: 只生成 `DecisionProposal`，由应用层处理执行
5. **每次最多1个高影响 Proposal**: 避免一次性建议太多变更让用户不知所措

---

## 9. ER 关系图

```
┌──────────┐         ┌──────────────────┐         ┌──────────────────┐
│  users   │ 1──── * │  learner_profiles│         │  learner_patterns│
│          │         │ user_id FK       │         │  user_id FK      │
│  id      │ 1──── * │ goal_id FK (NULL)│         │  goal_id FK (NULL│
└──────────┘         └──────────────────┘         │  pattern_type    │
     │                                            │  pattern_value   │
     │                                            │  confidence      │
     │ 1────────────────────────────────────────* │  evidence_count  │
     │                                            │  status          │
     │                                            └────────┬─────────┘
┌────┴─────┐                                              │ 1
│  goals   │ 1────────────────────────────────────────────┘ *
│          │                                              │
│  id      │                                   ┌──────────┴──────────┐
└────┬─────┘                                   │  pattern_evidences  │
     │                                         │  pattern_id FK      │
     │ 1                                       │  learning_event_id  │
     │                                         │    FK (SET NULL)    │
     ↓ *                                       │  contribution       │
┌────────────────────────────────────┐         │  meta (JSONB)       │
│         learning_events            │ 1─── * └─────────────────────┘
│  id, user_id FK, goal_id FK (NULL) │
│  aggregate_type, aggregate_id      │
│  event_type, source                │
│  payload (JSON), occurred_at       │
│  version                           │
└────────────────────────────────────┘

关系说明：
- users ──1:N──> learner_profiles（一用户多 Profile，按 goal 分组）
- users ──1:N──> learner_patterns（一用户多 Pattern）
- goals ──1:N──> learner_profiles（通过 goal_id）
- goals ──1:N──> learner_patterns（通过 goal_id）
- learner_patterns ──1:N──> pattern_evidences（CASCADE 删除）
- learning_events ──1:N──> pattern_evidences（SET NULL，事件删除不丢 evidence）
```

---

## 10. 实现路线图

### Phase 2C-1（本阶段，纯设计）✅
- [x] Learning Events 建模能力分析
- [x] Learner Model Schema V1 设计
- [x] Pattern 类型目录定义（10种）
- [x] Event → Pattern 更新规则
- [x] Pattern 生命周期定义
- [x] Agent Decision Loop 接口设计

---

### Phase 2C-2：Schema 实现

- [ ] `models.py` 添加 `LearnerProfile`、`LearnerPattern`、`PatternEvidence` 模型
- [ ] Alembic 迁移创建三张表 + 索引
- [ ] `publisher.py` 补充 `PlanGenerated`、`PlanActivated` 事件
- [ ] `src/intelligence/` 目录结构初始化

---

### Phase 2C-3：Pattern 分析器

- [ ] `src/intelligence/event_processor.py` — 游标轮询 + Event Dispatcher
- [ ] `src/intelligence/extraction_rules/` — 每个 Rule 一个文件（对应 §6.3 格式）
- [ ] 每种 Pattern 的 updater 函数（对应 §6.1 规则表）
- [ ] 幂等性保证（`pattern_evidences` UNIQUE 约束）
- [ ] 分析器集成测试（mock 事件序列 → 验证 Pattern confidence 变化）

---

### Phase 2C-3.5：Study Session 模型（预留，不阻塞 2C-3）

- [ ] 设计 `TaskSessionStarted` / `TaskSessionEnded` 事件（见 §3.3）
- [ ] `session_events` 或 `learning_events` 扩展 aggregate_type="session"
- [ ] 新增 Pattern：`focus_session_length`、`deep_work_time_preference`
- [ ] 前端需要 Session 计时组件支持

---

### Phase 2C-4：Profile 计算器

- [ ] `src/intelligence/profile_builder.py` — 聚合事件 → Profile 快照
- [ ] 批处理调度（每日触发，非实时）
- [ ] Profile REST API（`GET /api/v1/learner/profile/{goal_id}`）

---

### Phase 2C-5：Agent Decision Loop

- [ ] `src/intelligence/agent.py` — 基于 Learner Model 生成 Proposals
- [ ] `DecisionProposal` 持久化（`agent_proposals` 表）
- [ ] `AgentProposalMade`/`AgentProposalActioned` 事件（Phase 2C-2 中预留 aggregate_type="proposal"）
- [ ] Proposal API（`POST /api/v1/agent/propose`，`POST /api/v1/agent/proposals/{id}/accept`）
- [ ] 前端 Proposal 展示组件

---

## 11. 设计决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| **Profile vs Pattern 职责** | Profile = State（当前统计），Pattern = Knowledge（长期推断） | Agent 需要同时知道"现状"和"规律"，混在一起会职责不清 |
| Profile 实时更新 vs 批处理 | 批处理（每日） | Profile 是聚合数字，需要窗口；单事件更新无统计意义 |
| **Pattern 实时更新 vs 批处理** | **近实时（事件驱动，分钟级延迟）** | Agent 需要快速反馈；批处理会导致行为改变后12-24小时才被察觉 |
| Pattern 存 JSONB vs 多列 | JSONB | Pattern 种类多、结构差异大，JSONB 灵活扩展 |
| Agent 直写 vs Proposal 模式 | Proposal 模式 | 人工确认 + 审计需要；保持 learning_events SSOT |
| **Evidence 保留窗口** | **永久保存，未来冷热分层** | 解释能力核心；亿级数据后压缩或迁移冷存储，但不删除 |
| **Scope 层次** | **user / skill_category / goal 三级** | 同类目标可能共享规律（如算法vs语言的掌握速度差异） |
| goal_id 可为 NULL | 是 | 全局习惯（如时间偏好）跨目标有效；局部规律按 goal 隔离 |
| decay 按类型配置 vs 统一 | 按类型配置 | 不同行为的稳定性差异显著（完成率 vs 时间偏好） |
| **Cold Start 策略** | **System Prior（confidence=0.1）+ 用户偏好询问（confidence=0.3）** | 不完全依赖用户填写；系统默认提供温和引导 |
| Pattern 更新管道设计 | Event Processor + Extraction Rule 注册表 | 避免硬编码 if/else；新增事件类型时只需注册 Rule |

---

## 12. 架构决定（已确认）

以下四个问题已在设计审核中确认，实现时直接遵循，不再讨论。

---

### 决定1: Pattern 更新频率 → 事件驱动增量更新（近实时）

**选择**: Event Processor 轮询 `learning_events`，分钟级延迟处理新事件，更新 Pattern。

**不选择**: 每日批处理。

**原因**:
- Agent 需要近实时感知行为变化（如用户最近几天的完成率急剧下降）
- 批处理延迟会导致"已经连续跳过3天"但 Pattern 还没更新，Agent 决策基于过时数据

**架构分工**:
```
Pattern = 事件驱动，近实时（Event Processor，分钟级）
Profile = 批处理，每日一次（Profile Builder）
```

---

### 决定2: Evidence 保留策略 → 永久保存，未来冷热分层

**选择**: `pattern_evidences` 永久保存，不设清理窗口。

**不选择**: 保留12个月后删除，或压缩为摘要。

**原因**:
- `pattern_evidences` 是 Learner Model 的**可解释性核心**
- Agent 说"根据你过去的行为"时，必须能溯源到具体事件
- 删除 evidence 会破坏 Pattern 的可重建性（rebuild 时无法复现历史状态）

**规模应对**:
- 数据量达到亿级时，将 `recorded_at > 12个月` 的 evidence 迁移到冷存储（如 S3 + Parquet），主表只保留热数据
- 迁移是**搬移**，不是**删除**；查询冷数据时走归档接口

---

### 决定3: Scope 层次 → 三级（user / skill_category / goal）

**选择**: 三级 scope，`scope` 字段值为 `'user' | 'skill_category' | 'goal'`。

**不选择**: 只有 user / goal 两级。

**原因**:
- 同一用户对不同类型的学习目标可能有不同规律
- 例："晚上学习效率高"是 `scope='user'` 的全局规律；但"算法类掌握慢，语言类掌握快"是 `scope='skill_category'` 的规律，不应混在一起

**`skill_category` 的取值**:
- 来自 `Goal.type` 字段的映射：`exam | certification | skill | reading | language | habit`
- 不需要新字段，在 Pattern 记录时写入 `goal_id=NULL` + `scope='skill_category'` + `pattern_value` 中记录 `skill_category` 字段

**三级关系**:
```
user（所有目标共享）
 └── skill_category（同类型目标共享，如所有 skill 类）
       └── goal（单个目标独有）
```

Agent 查询时按 `scope` 优先级组合：先 goal-specific，fallback 到 skill_category，再 fallback 到 user。

---

### 决定4: Cold Start 策略 → System Prior + 用户偏好询问

**选择**: 双轨初始化。

**不选择**: 仅依赖用户填写，或完全依赖事件积累。

**两轨并行**:

**轨道 A：System Prior**（自动，用户无感知）

系统在用户注册后，为所有基础 Pattern 创建低 confidence 的初始记录：

```python
# 系统 Prior Pattern 示例（注册时自动创建）
system_priors = [
    {
        "pattern_type": "preferred_learning_time",
        "pattern_value": {"peak_hours": [19, 20, 21]},  # 统计上最常见的晚间学习
        "confidence": 0.1,
        "source": "system_prior",
        "status": "candidate"
    },
    {
        "pattern_type": "preferred_session_length",
        "pattern_value": {"median_mins": 45},            # 常见单任务时长
        "confidence": 0.1,
        "source": "system_prior",
        "status": "candidate"
    },
]
```

**轨道 B：用户偏好询问**（注册时的 onboarding 问卷）

```python
# 用户填写的初始偏好写入 Pattern（更高 confidence）
onboarding_overrides = [
    {
        "pattern_type": "preferred_learning_time",
        "pattern_value": {"peak_hours": user_selected_time_range},
        "confidence": 0.3,   # 高于 system_prior，但低于观测数据
        "source": "user_onboarding",
        "status": "candidate"
    }
]
```

**规则**: 用户填写的偏好覆盖 System Prior（同 pattern_type，取 confidence 较高值）。

**冷启动后**: 随着真实 learning_events 积累，两轨道的 confidence 都会被观测数据更新、覆盖，最终收敛到真实行为。

---

> **文档状态**: Phase 2C-1 设计 V2 完成。六项架构补充已纳入，可进入 Phase 2C-2 实现。
