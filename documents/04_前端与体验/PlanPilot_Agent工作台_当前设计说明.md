# PlanPilot Agent 工作台当前设计说明

> 文档状态：当前实现说明  
> 更新日期：2026-07-27  
> 适用范围：PlanPilot Agent V2 工作台、Agent V2 API 及其直接交互逻辑  
> 实现入口：`frontend/components/agent-v2/AgentWorkbench.tsx`

## 1. 文档目的

本文说明当前 Agent 工作台的产品定位、信息架构、功能模块、交互逻辑、状态逻辑、实时事件机制、安全审批机制、数据结构和已知边界。

本文以当前代码为准，区分以下两类内容：

- **已实现**：当前前端和后端已经具备并可由工作台使用的能力。
- **后续方向**：当前实现存在的产品或工程边界，不视为已经完成。

## 2. 产品定位

Agent 工作台不是普通聊天窗口，而是一个可观察、可控制、可审批、可追溯的任务执行界面。

用户在工作台中描述目标，主 Agent 将目标转换为结构化执行计划，协调受限的从属 Agent 和工具完成读取、分析、提案及写入。用户可以在执行过程中查看计划、数据读取、预算和审计记录，并在写操作发生前审查 ChangeSet。

核心目标如下：

1. 让用户以自然语言发起跨模块任务。
2. 让 Agent 的执行过程可见，而不是只展示最终结果。
3. 将只读分析与数据写入明确分离。
4. 对中高风险写操作提供可编辑、可拒绝、可二次确认的审批入口。
5. 记录计划版本、执行事件、工具依据和撤销状态，支持问题追踪。

## 3. 设计原则

### 3.1 一主多从

- 只有主 Agent 可以进入正式写操作链路。
- 从属 Agent 负责学习分析、日程优化、知识检索和计划审查。
- 从属 Agent 返回结构化结果，不直接获得自由工具调用或数据写权限。
- 工具执行、策略判断和状态迁移由服务端控制，前端只负责展示和提交用户决策。

当前角色包括：

| 角色 | 工作台显示名称 | 主要职责 |
| --- | --- | --- |
| `main` | 主 Agent | 任务编排、写操作入口、审批衔接 |
| `learning_analyst` | 学习分析 Agent | 分析执行情况和学习数据 |
| `schedule_optimizer` | 日程优化 Agent | 生成调整或重排建议 |
| `knowledge_researcher` | 知识检索 Agent | 检索并整理依据 |
| `plan_reviewer` | 计划审查 Agent | 检查计划合理性与风险 |

### 3.2 先观察，后写入

只读步骤可以自动执行；创建、修改、删除等写操作先生成 ChangeSet，再依据策略决定是否要求用户审批。工作台顶部的“仅主 Agent 可写”用于持续表达这一权限边界。

### 3.3 新任务与历史记录分离

左侧“历史任务”只显示终态记录，不再把新建、排队、执行中或待审批任务放入历史列表。

当前历史状态集合为：

```text
completed
failed
rejected
cancelled
rolled_back
superseded
```

其中 `superseded` 是前端历史过滤中的兼容值；当前后端只把该状态用于 Step，正式 Run 状态暂不产生 `superseded`。

非终态任务包括 `queued`、`executing`、`waiting_approval`、`retrying`、`replanning`、`paused`、`compensating` 等，它们属于当前运行上下文。

其中 `failed` 是可恢复终态：失败任务显示在历史列表；用户执行“重试失败步骤”后，状态重新进入 `queued`，该任务会从历史范围回到当前运行范围。

### 3.4 可解释但不过度暴露内部数据

工作台展示安全摘要、数据类型、记录数量、工具名称、耗时、错误分类和依据引用，不直接展示全部原始工具输入输出。这样既能解释 Agent 行为，也减少敏感数据和内部结构泄漏。

### 3.5 主题感知

工作台不维护独立固定配色。模块背景、强调边、选中态、按钮和进度条均从全局主题变量派生：

```css
--accent
--accent-light
--accent-muted
--surface
--bg
--border
```

用户切换色彩方案时，Agent 工作台会跟随全局主题变化。模块隔离主要通过主题色混合、边框、左侧强调线和轻阴影实现。

## 4. 页面信息架构

```text
PlanPilot 全局导航
└── Agent 工作台
    ├── 历史任务侧栏
    │   ├── 标题、终态记录数、刷新、收起
    │   └── 历史任务卡片
    │       ├── 状态
    │       ├── 创建时间
    │       ├── 请求摘要
    │       └── 删除操作
    └── 主工作区
        ├── 页面标题与安全模式
        ├── 新任务输入区
        ├── 已选择任务上下文
        ├── 执行计划看板
        ├── 权限与状态看板
        ├── Agent 活动看板
        ├── 运行预算看板
        ├── 结论与依据
        ├── 待审批 ChangeSet
        └── 审计 Timeline
```

桌面端左侧历史栏展开宽度为 `220px`，收起后为 `48px`；主区域最大内容宽度为 `1320px`。移动端历史栏默认关闭，打开后以抽屉形式覆盖主区，并提供遮罩关闭。

## 5. 功能设计

### 5.1 历史任务侧栏

已实现功能：

- 获取当前用户最近 20 条 Agent Run。
- 在前端按终态状态过滤后显示。
- 展示终态记录数量，而不是全部 Run 数量。
- 按后端返回顺序展示，当前后端按创建时间倒序。
- 点击历史卡片加载完整 Run 详情。
- 手动刷新任务列表。
- 删除历史任务，删除前显示不可恢复确认框。
- 删除已完成且可撤销的记录时，额外提示撤销入口也会消失。

历史卡片只承担“归档导航”职责，不展示执行中任务。

### 5.2 新任务输入区

输入区始终位于主工作区顶部，包含：

- 自然语言任务输入，长度限制为 2 至 2000 字符。
- 字符计数。
- 四类建议指令：分析并重排、创建任务、调整日期、删除任务。
- 目标范围选择，可以限制到某一目标，也可以选择全部目标。
- “开始执行”按钮和提交中状态。

提交后执行以下逻辑：

1. 前端调用 `POST /api/v2/agent/runs`。
2. 后端创建 Run，初始状态为 `queued`。
3. 后端将任务投递给 Celery Worker。
4. 前端立即将新 Run 设置为当前选择项。
5. 前端重新获取 Run 列表，但新 Run 不进入历史列表。
6. 主工作区开始展示该 Run 的上下文、计划和实时状态。

### 5.3 任务上下文

任务上下文用于展示“Agent 当前正在处理什么”，避免用户只看到步骤而失去目标语境。

当前展示内容：

- 运行类型：用户任务或主动建议。
- Run 状态版本。
- 计划版本。
- 原始任务请求。
- 解析后的意图。
- 回看时间窗口。
- 是否需要确认。
- 排除星期等约束。

目标摘要没有放入笼统的“运行概览”，而是归入任务上下文。Agent 活动和运行预算是只读可观察信息，不是用户可配置项。

### 5.4 执行计划看板

执行计划是工作台的主要过程视图，展示计划如何生成、如何变化以及每一步如何执行。

已实现内容：

- Run 当前状态。
- 多版本计划切换，例如 `v1`、`v2`。
- 规划器类型、规划耗时和 Token 使用量。
- 计划校验结果和降级原因。
- Registry 候选工具及得分。
- 重规划时的复用、新增、移除和调整步骤统计。
- 每个步骤的角色、工具、理由、状态、尝试次数、工具耗时和依赖数量。
- 输入安全摘要和输出安全摘要。
- 错误分类及可安全展示的错误信息。
- 被复用步骤的结果标识。

计划版本比较使用逻辑步骤 ID，而不是直接依赖数据库 Step ID。当前通过去除 `step_key` 的版本前缀获得稳定逻辑 ID，以便比较相邻计划版本。

### 5.5 权限与状态看板

该看板表达当前安全边界，并根据状态提供可执行控制。

固定信息：

- 写操作入口：仅主 Agent。
- 只读步骤：自动执行。
- 任务调整：需确认。
- 失败次数：最多 3 次。
- 当前计划版本。

状态相关操作：

| 当前状态 | 可用操作 |
| --- | --- |
| `queued` / `executing` 等运行态 | 暂停、取消 |
| `paused` | 继续执行 |
| `failed` | 重试失败步骤 |
| `completed` 且可撤销 | 撤销本次修改 |
| `waiting_approval` | 在审批面板批准、编辑或拒绝 |

按钮是否出现由前端状态判断，但操作是否合法最终由后端原子状态机决定。

### 5.6 Agent 活动看板

该看板是只读运行监控，不是用户设置项。

当前展示：

- 正在运行、重试或等待审批的步骤。
- 执行该步骤的 Agent 角色和工具。
- 当前步骤持续时间。
- Worker 最近心跳时间。
- 从审计事件汇总的数据读取类型、读取次数和记录数。

持续时间通过最近一个与当前步骤关联的 `tool.started` 事件计算。数据读取统计由事件中的 `data_types_read` 和 `data_summary.counts` 聚合得到。

### 5.7 运行预算看板

该看板同样是只读运行监控，用于解释 Agent 为什么继续执行、重规划或因预算停止。

当前预算维度：

- 步骤数。
- Token 数。
- 工具执行时间。
- 重规划次数。

每个维度展示 `used / limit` 和占比进度条。预算限制由服务端执行内核控制，前端不直接修改预算。

### 5.8 结论与依据

“结论与依据”将 Agent 输出拆成结论和证据两部分：

- 结论：文本、类型、置信度、关联证据数量。
- 证据：来源类型、来源 ID、标签和安全摘录。
- 关联：结论通过 `evidence_ids` 引用证据。

前端从 Run 的审计事件中聚合全部 `evidence` 和 `conclusions`。证据按 `evidence_id` 去重，结论保留事件产生顺序。

### 5.9 ChangeSet 审批

当策略要求批准时，工作台显示“等待你的确认”面板。

审批面板展示：

- ChangeSet 摘要。
- 风险等级和策略原因。
- ChangeSet Hash 摘要。
- ChangeSet 版本。
- 操作数量和警告。
- 每项操作的实体、字段、修改前后值和原因。

用户可以：

- 修改新建任务的标题和日期。
- 修改任务调整后的日期。
- 从方案中移除单项操作。
- 保存调整后的 ChangeSet。
- 拒绝整个方案。
- 批准并执行。

高风险 ChangeSet 在批准前还需要一次危险操作确认。批准请求同时携带：

```text
approval_id
change_hash
change_set_version
run_state_version
high_risk_confirmed
```

这些字段用于防止用户批准已经被修改、过期或并发更新后的方案。

### 5.10 审计 Timeline

审计 Timeline 展示服务端记录的单调序列事件，支持：

- 按 Agent 角色筛选。
- 按事件类型筛选。
- 展示事件 sequence、actor、type、安全摘要和时间。
- 按最新事件优先显示。

审计事件既服务于用户解释，也服务于故障定位、恢复和合规追踪。

## 6. 核心交互流程

### 6.1 常规只读任务

```text
用户输入任务
  -> 创建 Run
  -> queued
  -> Worker 获取租约
  -> executing
  -> 生成并校验计划
  -> 解析步骤依赖
  -> 执行只读工具
  -> Observer 校验结果
  -> completed
  -> 工作台展示结论、依据和审计记录
```

### 6.2 需要写入的任务

```text
执行读取与分析步骤
  -> 生成 ChangeSet
  -> PolicyDecision
  -> waiting_approval
  -> 用户编辑 / 拒绝 / 批准
     ├── 拒绝 -> rejected
     └── 批准 -> 校验 Hash、版本和风险确认
              -> queued
              -> Executor 执行写入
              -> Observer 验证
              -> completed
```

### 6.3 失败、重规划和恢复

```text
步骤失败
  -> 错误分类
  -> retrying / replanning / failed
  -> 重试时复用有效步骤结果
  -> 生成新计划版本
  -> 再次执行或进入审批
```

错误类别包括：

- `retryable`：可以自动重试。
- `recoverable`：可通过调整输入或重新规划恢复。
- `fatal`：不可自动恢复。
- `cancelled`：用户或系统取消。
- `budget_exceeded`：超过步骤、Token、工具时间或重规划预算。

### 6.4 撤销

```text
completed
  -> 用户请求撤销
  -> compensating
  -> Executor 执行补偿操作并校验前置条件
  -> rolled_back
```

撤销不是数据库直接回滚，而是经过正式 Executor 的补偿操作。若目标数据已被后续修改，前置条件冲突会阻止不安全撤销。

## 7. 状态设计

### 7.1 Run 状态

| 状态 | 含义 | 工作台归属 |
| --- | --- | --- |
| `queued` | 等待 Worker 执行 | 当前运行 |
| `executing` | 正在执行 | 当前运行 |
| `waiting_approval` | 等待用户确认 ChangeSet | 当前运行 |
| `retrying` | 正在进行错误恢复 | 当前运行 |
| `replanning` | 正在生成新计划版本 | 当前运行 |
| `paused` | 用户暂停 | 当前运行 |
| `compensating` | 正在执行撤销补偿 | 当前运行 |
| `completed` | 执行完成 | 历史任务 |
| `failed` | 执行失败，可由用户重试 | 历史任务 |
| `rejected` | 用户拒绝方案 | 历史任务 |
| `cancelled` | 用户取消 | 历史任务 |
| `rolled_back` | 已撤销写入 | 历史任务 |

服务端状态迁移由 `RUN_TRANSITIONS` 白名单约束，并通过 `state_version` 乐观并发控制执行原子更新。非法迁移或版本冲突会被拒绝。

前端状态文案还保留 `planning`、`running` 等兼容别名；当前后端正式 Run 执行态以 `queued` 和 `executing` 等 `RunStatus` 枚举值为准。

### 7.2 Step 状态

| 状态 | 含义 |
| --- | --- |
| `pending` | 等待依赖满足 |
| `ready` | 依赖已满足，可执行 |
| `running` | 工具正在执行 |
| `retrying` | 步骤正在重试 |
| `waiting_approval` | 该步骤产生的写入等待批准 |
| `completed` | 步骤完成 |
| `failed` | 步骤失败 |
| `blocked` | 上游失败导致阻塞 |
| `skipped` | 被策略或计划跳过 |
| `superseded` | 被新计划版本替代 |

## 8. 实时更新逻辑

工作台同时使用 SSE 和有限轮询。

### 8.1 SSE

事件接口：

```text
GET /api/v2/agent/runs/{run_id}/events/stream
```

机制如下：

1. 每个 Run 的事件使用数据库单调递增 `sequence`。
2. 前端以当前最大 sequence 作为 cursor。
3. 请求同时使用查询参数 `after` 和 `Last-Event-ID`。
4. 服务端只返回 `sequence > cursor` 的事件。
5. 前端按 sequence 去重并排序。
6. 连接正常结束后 1 秒重连，异常后 2 秒重连。
7. 服务端无事件时每 15 秒发送注释心跳，避免中间代理关闭连接。

### 8.2 轮询

当 Run 处于 `planning`、`queued`、`running` 或 `executing` 时，前端每 2 秒刷新一次完整 Run 详情。轮询负责同步状态、步骤、审批和预算快照；SSE 当前主要负责追加审计事件。

当 Run 进入 `completed` 或 `rolled_back` 时，前端刷新任务数据，使 Agent 写入结果及时反映到其他页面。

## 9. 安全与权限逻辑

工作台的安全模型由前端表达、后端强制执行。

### 9.1 前端责任

- 展示权限边界和风险等级。
- 在写入前展示 ChangeSet。
- 收集用户编辑、批准、拒绝和高风险二次确认。
- 只显示安全摘要和安全错误信息。
- 禁用重复提交期间的操作按钮。

### 9.2 后端责任

- 用户身份认证和 Run 所有权检查。
- Registry 工具白名单和结构化输入校验。
- 依赖解析和计划校验。
- PolicyDecision 计算。
- ChangeSet Hash、版本、状态版本和风险确认校验。
- 原子状态迁移。
- Executor 幂等执行和批量写入事务。
- Run lease、heartbeat 和过期恢复。
- 预算限制和错误分类。
- Undo 补偿及冲突检测。
- 审计事件持久化。

前端按钮不是安全边界。即使客户端构造非法请求，服务端仍必须拒绝越权、过期审批、非法状态迁移和不满足策略的执行。

## 10. 前端数据模型

工作台的主要视图模型为 `AgentRun`：

```text
AgentRun
├── request / objective
├── status / state_version / run_kind
├── plan / plan_history / plan_version
├── steps[]
├── approvals[]
├── events[]
├── budgets
├── runtime
├── result
└── error
```

关键子对象：

| 对象 | 用途 |
| --- | --- |
| `PlanHistory` | 展示规划器、候选工具、校验结果和多版本计划 |
| `Step` | 展示步骤执行、依赖、输入输出摘要和错误 |
| `Approval` | 承载 ChangeSet、Hash、版本和策略决定 |
| `AuditEvent` | 驱动 Timeline、活动、数据读取和依据聚合 |
| `Evidence` | 描述结论引用的数据来源 |
| `Conclusion` | 描述 Agent 结论、类型、置信度及证据关联 |
| `budgets` | 展示步骤、Token、工具时间和重规划用量 |
| `runtime` | 展示 Worker、心跳、租约和截止时间 |

## 11. API 设计

| 方法 | 路径 | 工作台用途 |
| --- | --- | --- |
| `GET` | `/api/v2/agent/tools` | 获取公开工具目录，当前页面未直接展示 |
| `POST` | `/api/v2/agent/runs` | 创建用户任务 |
| `GET` | `/api/v2/agent/runs` | 获取任务列表 |
| `GET` | `/api/v2/agent/runs/{run_id}` | 获取完整 Run 详情 |
| `DELETE` | `/api/v2/agent/runs/{run_id}` | 删除历史记录 |
| `PATCH` | `/api/v2/agent/runs/{run_id}/approvals/{approval_id}` | 编辑 ChangeSet |
| `POST` | `/api/v2/agent/runs/{run_id}/approve` | 批准 ChangeSet |
| `POST` | `/api/v2/agent/runs/{run_id}/reject` | 拒绝 ChangeSet |
| `POST` | `/api/v2/agent/runs/{run_id}/pause` | 暂停任务 |
| `POST` | `/api/v2/agent/runs/{run_id}/resume` | 继续任务 |
| `POST` | `/api/v2/agent/runs/{run_id}/cancel` | 取消任务 |
| `POST` | `/api/v2/agent/runs/{run_id}/retry` | 重试失败步骤 |
| `POST` | `/api/v2/agent/runs/{run_id}/undo` | 撤销已完成写入 |
| `POST` | `/api/v2/agent/suggestions` | 创建主动建议，当前页面只支持展示该类型 |
| `GET` | `/api/v2/agent/runs/{run_id}/events` | 按 cursor 分页读取事件 |
| `GET` | `/api/v2/agent/runs/{run_id}/events/stream` | SSE 实时事件流 |

所有接口都要求认证，并按 `current_user.id` 校验 Run 所有权。

## 12. 响应式与可访问性设计

### 12.1 响应式

- 桌面端：历史侧栏与主工作区并列。
- 小屏桌面：执行计划与右侧状态看板改为纵向堆叠。
- 移动端：全局导航压缩为图标栏，历史任务改为抽屉。
- 横向内容使用 `minmax(0, 1fr)`、换行和横向滚动，避免长文本撑破布局。
- 建议指令和详情 Tab 在窄屏上允许横向滚动。

### 12.2 可访问性

- 图标按钮提供 `aria-label` 和 `title`。
- 详情切换使用 `tablist`、`tab` 和 `aria-selected`。
- 输入框、选择器提供可访问名称。
- 键盘焦点使用主题色高亮。
- 提交期间禁用可能重复触发的操作。

## 13. 代码职责分布

| 文件 | 主要职责 |
| --- | --- |
| `frontend/components/agent-v2/AgentWorkbench.tsx` | 页面结构、交互状态、聚合视图、审批编辑和动作调用 |
| `frontend/lib/api.ts` | REST 请求、认证 Header、SSE 解析和 cursor Header |
| `frontend/app/globals.css` | 工作台主题派生样式、模块强调、焦点和响应式样式 |
| `frontend/lib/theme-context.tsx` | 用户主题和色彩方案持久化 |
| `backend/src/api/agent_v2.py` | Agent V2 API、鉴权、任务投递和 SSE 输出 |
| `backend/src/core/agent_v2/orchestrator.py` | Run 编排、详情序列化、审批、恢复和撤销 |
| `backend/src/core/agent_v2/transitions.py` | Run/Step 原子状态迁移和租约控制 |
| `backend/src/core/agent_v2/planner.py` | 受约束计划生成与校验 |
| `backend/src/core/agent_v2/resolver.py` | 通用依赖解析和步骤就绪判断 |
| `backend/src/core/agent_v2/policy.py` | 策略判断和风险决定 |
| `backend/src/core/agent_v2/executor.py` | 正式写入与补偿执行 |
| `backend/src/core/agent_v2/audit.py` | 审计事件和单调 sequence |
| `backend/src/tasks/agent_runs.py` | Celery Worker 执行、恢复和定时任务衔接 |

## 14. 当前边界与后续方向

以下内容是当前实现的边界，不代表功能不可用。

### 14.1 当前任务选择仍是单选模型

后端允许存在多个非终态 Run，但工作台只维护一个 `selectedId`。初始化时优先选择列表中的第一个非历史任务，没有单独的“当前任务队列”。

后续如果支持高频并行运行，应在主工作区增加“当前任务”队列或切换器，而不是把进行中任务重新放回历史列表。

### 14.2 历史详情与新建输入仍共用主工作区

历史数据已经从左侧列表中按状态隔离，但点击历史记录后，详情仍加载到主工作区，并且顶部新任务输入区保持可见。当前“当前任务上下文”标题也会用于历史详情。

后续可以引入明确的工作区模式：

```text
新建模式
当前运行模式
历史详情模式
```

历史详情模式下可将“当前任务上下文”改为“历史任务详情”，并决定是否折叠新建输入区，从信息语义上进一步隔离。

### 14.3 SSE 主要追加事件，不直接归并完整 Run 状态

当前 SSE 回调只把新事件追加到 `run.events`。Run 状态、审批、步骤和预算仍依赖详情轮询更新。

后续可选择：

- 在关键状态事件到达时重新请求 Run 详情；或
- 为事件定义前端 reducer，安全地更新状态、步骤和预算。

### 14.4 轮询状态集合不完整

当前 2 秒轮询覆盖 `planning`、`queued`、`running`、`executing`，未显式包含 `retrying`、`replanning` 和 `compensating`。这些状态可能依赖从前一轮执行态触发的最后一次刷新，长时间停留时界面更新不够稳定。

后续应统一定义“非终态状态集合”，供历史过滤、轮询和操作可见性共同复用，避免状态判断分散。

### 14.5 历史列表没有分页和搜索

当前后端默认返回最近 20 条、最多 100 条，前端没有分页、状态筛选、关键词搜索和日期范围筛选。数据量增加后需要服务端分页和独立历史查询参数。

### 14.6 前后端类型尚未自动同步

前端目前手写 `AgentRun`、`Step`、`Approval` 等 TypeScript 类型，后端使用 Pydantic Schema 和序列化字典。后续可以通过 OpenAPI 生成类型，减少字段新增时的前后端漂移。

### 14.7 活动与预算暂不提供用户配置

Agent 活动和运行预算当前是系统可观察信息，不是用户选择项。若未来开放预算设置，应放在高级运行配置中，并由后端继续校验上下限，不能直接把展示面板改成无约束输入控件。

## 15. 当前设计结论

当前 Agent 工作台已经形成完整的任务执行控制面：用户可以发起任务、查看结构化计划、观察步骤与预算、审查写入、控制运行、查看依据和追踪审计事件。

当前设计最重要的边界是：

1. 新建和运行中任务不进入历史任务列表。
2. 只有主 Agent 能进入写操作链路。
3. 写入必须经过策略判断、ChangeSet 和 Executor。
4. 高风险批准同时校验用户确认、Hash 和版本。
5. Agent 活动和预算属于可观察信息，而不是普通用户配置。
6. 审计事件使用数据库单调 sequence，并通过 SSE cursor 增量传输。

下一轮前端设计的优先级应是完善“新建 / 当前运行 / 历史详情”三种工作区模式和多个当前任务的切换能力，其次再处理历史搜索、分页和更完整的事件驱动状态归并。
