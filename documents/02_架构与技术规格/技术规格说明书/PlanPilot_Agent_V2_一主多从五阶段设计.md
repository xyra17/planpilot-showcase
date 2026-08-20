# PlanPilot Agent V2：一主多从五阶段设计

更新日期：2026-07-27

## V2.1 实施补充

V2.1 在五阶段基础设施上扩展第一批生产型业务能力：

- Agent Run 创建后先持久化为 `queued`，由 Celery 原子认领为 `executing`；
- 同一 Run 重复投递时只有一个 Worker 能认领；
- Worker 异常退出后，超过 5 分钟的 `executing` Run 会重新进入队列；
- 每两分钟运行一次恢复扫描，页面刷新不影响任务执行；
- 任务 ChangeSet 支持创建、日期修改、完成、删除和批量重新排期；
- 创建使用预生成稳定 UUID，重复执行不会重复创建；
- 删除保存完整任务快照，可在目标仍存在时补偿恢复；
- 用户可以移除方案中的操作，也可以编辑新任务标题、日期及重新排期日期；
- 编辑后重新计算 ChangeSet 哈希，必须使用新哈希审批；
- 不允许修改原始值、任务身份、所属目标或增加未经审查的新操作。

## 1. 版本定位

### V1

V1 是“意图分类器 + 固定业务流程 + 带网页/知识检索的聊天机器人”：

- LangGraph 按 `goal_setup / checkin / replan_request / verification / chat` 固定分支；
- 每种意图对应固定节点，模型不能从完整业务工具目录中自主选择能力；
- 多数执行依赖一次 HTTP/SSE 请求，刷新或中断后缺少统一恢复机制；
- 审批、幂等、审计和撤销分散在具体业务代码中；
- Agent、API 和定时任务可能分别实现同一业务规则。

V1 保留作为兼容聊天入口，但不再承载新的自主执行能力。

### V2

V2 是 PlanPilot 专用、受控的一主多从 Agent：

- 主 Agent 是唯一面向用户、持有执行状态并有权提交写操作的主体；
- 从属 Agent 负责日程分析、学习数据分析、知识检索和计划审查；
- 从属 Agent 默认只读，只返回结构化观察或候选方案；
- 所有写操作由主 Agent 生成 ChangeSet，经策略引擎判断并在需要时请求用户审批；
- Executor 是唯一写入口，所有调用可追溯、可幂等、可补偿；
- LangGraph只作为可选生命周期编排器，不再为每个用户意图建立固定节点。

## 2. 核心用户链路

目标验收语句：

> 检查我最近两周的执行情况，把落后的任务重新安排到下周。周三晚上不要排任务，修改前让我确认。

执行过程：

```text
理解请求
  → 主 Agent 检索工具目录
  → 加载目标、任务、打卡、日程
  → 学习分析从属 Agent 识别落后任务
  → 日程从属 Agent 计算可用容量
  → 主 Agent 生成结构化执行计划
  → 自动执行只读步骤
  → 生成任务日期 ChangeSet
  → Policy 判定必须审批
  → 工作台展示前后差异
  → 用户批准
  → Executor 幂等执行
  → Observer 回读数据库验证
  → 记录审计和补偿数据
  → 提供撤销入口
```

## 3. 一主多从边界

| 角色 | 职责 | 写权限 |
|---|---|---|
| 主 Agent | 理解目标、生成计划、委派分析、汇总结果、申请审批 | 不能直接写，只能请求 Executor |
| 学习分析 Agent | 分析打卡、执行率、逾期与学习债务 | 无 |
| 日程优化 Agent | 计算容量、冲突和候选排期 | 无 |
| 知识检索 Agent | 检索项目知识库和受控网络信息 | 无 |
| 计划审查 Agent | 检查遗漏、风险、截止日期和工作量 | 无 |
| Policy Engine | 判断权限、风险、审批和工具可用性 | 无 |
| Executor | 执行获批工具步骤 | 唯一写入口 |
| Observer | 回读结果、判断成功、重试或重新规划 | 无 |

任何从属 Agent 都不能调用原始 SQL、Shell、任意 HTTP 或直接修改数据库。

## 4. 五阶段实施

### 阶段一：工具化现有业务能力

1. API 和 Agent 共同调用 `services/` 领域服务；
2. 工具使用 Pydantic Schema 声明输入输出；
3. Registry 保存权限、风险、审批、超时、重试、幂等和补偿元数据；
4. Registry 根据用户请求、当前权限和工具描述检索候选工具；
5. 首批工具：
   - `context.load`
   - `analytics.execution_summary`
   - `tasks.list`
   - `schedule.preview_reschedule`
   - `tasks.apply_changes`
   - `tasks.undo_changes`
   - `knowledge.search`

### 阶段二：多步执行引擎

主循环采用有限状态机：

```text
PLAN → ACT → OBSERVE
          ├─ success → next step
          ├─ retryable failure → retry（最多 2 次）
          ├─ recoverable failure → REPLAN
          └─ fatal failure → FAILED
```

硬限制：

- 默认最多 10 步；
- 单工具默认 15 秒；
- 同一步最多重试 2 次；
- 默认 Token 预算 20,000；
- 总运行时间预算 10 分钟；
- 不允许模型扩展未经 Registry 暴露的工具。

### 阶段三：审批与安全执行

风险策略：

| effect/risk | 默认策略 |
|---|---|
| read / low | 自动执行 |
| proposal / low | 自动执行 |
| write / medium | 展示 ChangeSet 后审批 |
| destructive / high | 强制审批 |
| external / high | 强制审批 |

ChangeSet 必须保存：

- 实体、实体 ID、字段；
- `before`、`after`；
- 数据版本或等价前置条件；
- 原因和来源步骤；
- 幂等键；
- 补偿操作。

审批绑定 ChangeSet 摘要；内容发生变化后旧审批自动失效。

### 阶段四：持久任务与工作台

持久实体：

- `agent_runs`
- `agent_steps`
- `agent_approvals`
- `agent_audit_events`

Run 状态：

```text
planning / running / waiting_approval / paused / retrying
completed / failed / cancelled / compensating / rolled_back
```

前端工作台必须展示：

- 原始请求和结构化目标；
- 主 Agent 与从属 Agent 当前活动；
- 已读取的数据类型；
- 执行步骤及状态；
- ChangeSet 前后差异；
- 审批、拒绝、取消、重试和撤销；
- 工具依据、错误和审计时间线。

### 阶段五：外部工具与主动协作

内部工具稳定后开放适配器：

- 系统日历；
- 邮件和通知；
- 文档与知识库；
- 学习平台；
- 本地/云模型路由。

主动任务默认只能建立 `suggestion` Run。任何写入或外部发送仍必须通过同一 Policy 和审批。

## 5. 后端模块

```text
backend/src/
├── services/
│   ├── agent_context.py
│   ├── task_service.py
│   └── schedule_service.py
└── core/agent_v2/
    ├── orchestrator.py
    ├── planner.py
    ├── executor.py
    ├── observer.py
    ├── registry.py
    ├── policy.py
    ├── schemas.py
    ├── audit.py
    ├── subagents.py
    └── tools/
        ├── context.py
        ├── analytics.py
        ├── tasks.py
        ├── schedule.py
        └── knowledge.py
```

API 前缀：`/api/v2/agent`。

## 6. 数据与并发

- `user_id` 永远由认证依赖注入，模型输入中不接受该字段；
- `goal_id` 必须经过服务端归属校验；
- 写工具必须携带 `idempotency_key`；
- 执行前验证 ChangeSet 中的 `before` 值；
- 已执行的 Step 不因重试重复写入；
- 审批、执行、撤销均写 AuditEvent；
- 日志不保存 API Key、Token、密码或完整私密文档内容；
- Web/知识内容视为不可信数据，不能改变工具权限或系统策略。

## 7. 兼容迁移

- V1 `/api/v1/agent` 和现有 ChatWindow 暂时保留；
- V2 使用独立表、API 和工作台；
- V2 工具逐步复用领域服务，随后再让 V1 API 迁移到相同服务；
- V2 稳定前不删除 V1 LangGraph；
- 生产切换通过前端入口和配置开关完成，而不是一次性替换。

## 8. 完成标准

- 主 Agent 能从 Registry 检索和选择工具；
- 至少完成一条 4 步以上、有依赖关系的执行链；
- 所有写操作经过 Policy；
- 任务调整先预览、后审批；
- 重复批准不会重复修改；
- 刷新或服务重启后 Run 可继续读取和推进；
- 工具失败能重试、停止或重规划；
- 每次读取、计划、审批、写入和撤销均有审计事件；
- 用户可取消未完成 Run；
- 已执行任务日期变更可撤销；
- 工作台清楚展示主从角色、步骤、差异和状态；
- 从属 Agent 无直接写权限。

## 9. 当前实现基线与主要缺口

本节描述 V2.1 完成后的实际基线，用于约束 V2.2-V2.4 的实施范围。状态含义：

- `已完成`：主链路已有实现和自动化测试；
- `部分完成`：已有数据结构或单一场景实现，但尚未形成通用能力；
- `未完成`：只有设计约束、接口占位或尚未实现。

| 能力 | 当前状态 | 主要缺口 |
|---|---|---|
| 持久 Run、Step、Approval、AuditEvent | 已完成 | 状态集合与设计仍不完全一致，缺少状态版本和租约字段 |
| Celery 后台执行与恢复扫描 | 部分完成 | 有原子认领和超时回队，但没有 lease token、heartbeat 和 Worker 失联测试 |
| 4 步以上任务变更链 | 已完成 | 依赖关系只保存在计划中，执行时仍按固定步骤编号取结果 |
| Registry 与工具元数据 | 部分完成 | Schema 仍是描述字典，检索是简单字符串匹配，补偿元数据不完整 |
| 主 Agent 规划 | 部分完成 | 当前主要依赖关键词和固定模板，不是受约束的动态计划生成 |
| 四类从属 Agent | 部分完成 | 已有角色和工具归属，但尚无独立的结构化请求、响应和证据协议 |
| Policy 与审批 | 部分完成 | 已实现强制审批和 ChangeSet 哈希，但没有统一 PolicyDecision |
| Executor 唯一写入口 | 部分完成 | Agent 写入集中在任务工具中，但执行、撤销和 V1 API 尚未统一经过 Executor |
| ChangeSet 并发、幂等和补偿 | 部分完成 | 有 before 校验、稳定 UUID 和撤销数据，缺少操作级幂等键、版本和来源步骤 |
| Observer 回读验证 | 部分完成 | 已覆盖任务写入，尚未形成适用于所有工具的观察结果与错误分类协议 |
| Token、步骤和运行时间预算 | 部分完成 | 步骤数只在创建时检查，Token 和总运行时间没有实际扣减与终止逻辑 |
| Retry、REPLAN 和失败恢复 | 部分完成 | 有工具重试和人工重试，没有 recoverable/fatal 分类和自动 REPLAN |
| 工作台执行可视化 | 部分完成 | 已有步骤、审批和操作按钮，缺少目标摘要、数据访问记录、工具依据和审计时间线 |
| 外部连接器 | 未完成 | 只有受控连接器协议，没有日历、邮件或学习平台适配器 |

### 9.1 规划仍是固定模板

当前 Planner 根据关键词选择分析、知识检索或任务调整模板。Registry 虽然参与候选工具搜索，但计划仍假定固定工具和固定顺序。因此新增工具往往需要同时修改 Planner 和 Orchestrator，尚未达到“注册能力即可被规划器使用”的目标。

改进要求：

- Planner 只能从 Registry 返回的候选工具中选择；
- 计划必须是 Pydantic 可验证的结构化对象；
- 工具输入通过显式输出引用绑定，不能依赖步骤下标和工具名硬编码；
- 模型规划失败时必须降级到确定性 Planner，而不是生成未注册工具；
- 服务端必须在执行前重新验证权限、依赖、预算和循环依赖。

### 9.2 多从 Agent 目前主要是角色标签

学习分析、日程优化、知识检索和计划审查已经有角色边界，但当前没有统一的委派协议。角色不能只用于 UI 展示，还必须约束可见上下文、可调用工具、输出 Schema 和证据来源。

改进要求：

- 每类从属 Agent 有独立的 Request/Response Schema；
- 从属 Agent 只能返回 observation、evidence、candidate 或 warning；
- 从属 Agent 不得输出可直接执行的数据库命令；
- 从属 Agent 不能获得原始 SQL、Shell、任意 HTTP 和写工具；
- 不强制每个角色使用独立进程或独立模型，优先采用同一运行时中的受控能力模块。

### 9.3 Orchestrator 与固定步骤耦合

当前执行过程按固定步骤编号读取上下文、分析结果和 ChangeSet。`depends_on` 尚未成为调度依据，无法支持并行只读步骤、可选步骤、动态插入审查步骤或通用失败传播。

改进要求：

- Step 使用稳定 `step_id`，依赖指向 `step_id` 而不是数组位置；
- 输入使用显式 `OutputRef(step_id, path)`；
- 只有全部依赖完成的 Step 才能进入 `ready`；
- 上游失败时，下游进入 `blocked` 或由 Planner 生成替代计划；
- 同一 Run 内无依赖的只读 Step 后续可以并行，写 Step 必须串行；
- 执行引擎不得包含具体业务工具名判断。

### 9.4 预算和 REPLAN 尚未闭环

`step_budget` 和 `token_budget` 已保存，但没有完整消费记录。工具失败目前主要进入重试或失败，Observer 不能区分可重试、可重新规划和致命错误。

改进要求：

- 每次模型调用、工具调用和重新规划都扣减预算；
- 超过任一预算后停止调度新步骤，并记录 `budget.exceeded`；
- 错误必须分类为 `retryable / recoverable / fatal / cancelled / budget_exceeded`；
- `retryable` 在原 Step 内重试；
- `recoverable` 进入 REPLAN，保留已完成且仍有效的步骤；
- `fatal` 立即终止 Run；
- 默认最多 REPLAN 2 次，防止无限循环。

### 9.5 安全执行边界尚未完全统一

任务写入已经具备审批、before 校验、幂等创建和撤销，但安全信息分散在 Registry、Orchestrator 和领域服务中。撤销尚未经过统一 Executor，V1 API 仍可能直接操作数据库。

改进要求：

- 所有 Agent 写入和撤销统一进入 Executor；
- Policy 返回结构化 PolicyDecision，而不是单一布尔值；
- ChangeSet 保存来源、版本、幂等和补偿元数据；
- 审批使用原子状态迁移，避免并发批准；
- Policy、Executor 和 Observer 的决定全部写入 AuditEvent；
- V1 API 逐步迁移到相同领域服务，但不强制经过 Agent 审批。

### 9.6 工作台尚未覆盖完整可观测性

当前页面能够展示步骤和审批，但用户仍难以回答“Agent 为什么这样做、读了什么、现在由谁处理、失败后发生了什么”。后端已有 AuditEvent，前端尚未形成完整展示。

改进要求：

- 展示原始请求、结构化目标、限制条件和预算；
- 展示当前主 Agent/从属 Agent 活动；
- 展示读取的数据类型和数量，不默认暴露完整私密内容；
- 展示工具选择依据、输入摘要、输出摘要和错误类别；
- 展示审批、重试、重新规划、写入、验证和撤销时间线；
- 页面刷新后从持久状态恢复，不依赖浏览器内存。

## 10. V2.2-V2.4 实施路线

版本顺序必须遵循：执行内核和安全模型优先，规划智能其次，工作台和外部能力最后。不得用增加更多 Agent 角色来绕过执行内核缺口。

### 10.1 V2.2 执行内核

#### 目标

把当前固定五步流程升级为业务无关、可恢复、可验证的有限状态执行内核。V2.2 不要求模型自主规划，但必须允许确定性 Planner 生成不同长度和依赖关系的计划。

#### 10.1.1 通用依赖解析

PlanStep 至少包含：

```python
class OutputRef(BaseModel):
    step_id: str
    path: str | None = None

class PlanStep(BaseModel):
    step_id: str
    title: str
    agent_role: AgentRole
    tool_name: str
    input: dict[str, JSONValue]
    input_refs: dict[str, OutputRef]
    depends_on: list[str]
    on_failure: Literal["retry", "replan", "fail"]
```

执行规则：

- 创建 Run 时验证 `step_id` 唯一、依赖存在且无环；
- `depends_on` 持久化到 AgentStep；
- 调度器查询所有依赖已完成的 `pending` Step，将其原子迁移为 `ready`；
- Resolver 根据 OutputRef 提取上游输出，路径不存在时产生可分类错误；
- 写工具自动增加对所有相关 proposal/review Step 的依赖；
- 上游被替换后，旧下游 Step 标记为 `superseded`，不得继续执行。

#### 10.1.2 Run 与 Step 状态机

Run 建议状态：

```text
queued → executing → waiting_approval → queued
                  ├→ retrying → executing
                  ├→ replanning → queued
                  ├→ paused → queued/waiting_approval
                  ├→ completed
                  ├→ failed
                  └→ cancelled

completed → compensating → rolled_back
```

Step 建议状态：

```text
pending → ready → running → completed
                     ├→ retrying → ready
                     ├→ waiting_approval → ready
                     ├→ failed
                     ├→ blocked
                     ├→ skipped
                     └→ superseded
```

所有迁移必须通过统一 Transition Service 执行，并满足：

- 使用 `state_version` 或等价 CAS 条件；
- SQL 更新包含 `WHERE status = expected_status`；
- 迁移失败返回冲突，不静默覆盖新状态；
- 每次迁移写入 AuditEvent，包含 from、to、actor 和 reason；
- API、Worker 和恢复任务不能直接赋值状态字段。

#### 10.1.3 Run lease 与 heartbeat

AgentRun 增加：

- `worker_id`：当前 Worker 标识；
- `lease_token`：每次认领生成的新随机令牌；
- `lease_expires_at`：租约截止时间；
- `heartbeat_at`：最近心跳；
- `state_version`：状态迁移版本号。

规则：

- Worker 使用单条原子 UPDATE 认领 `queued` Run；
- Worker 只能使用当前 lease token 更新 Run；
- 执行期间每 30 秒续租，默认租约 90 秒；
- 恢复扫描只回收租约过期且无有效心跳的 Run；
- 等待审批、暂停和终态 Run 不持有租约；
- Worker 在失去租约后必须停止提交新的工具结果；
- 已完成 Step 保持完成，恢复后从首个未完成 Step 继续。

#### 10.1.4 预算控制

AgentRun 增加或明确维护：

- `started_at`、`deadline_at`；
- `step_budget`、`steps_consumed`；
- `token_budget`、`tokens_consumed`；
- `tool_time_budget_ms`、`tool_time_consumed_ms`；
- `replan_budget`、`replan_count`。

规则：

- 计划校验时预检查最大步骤数；
- Step 真正进入 running 时消耗步骤预算，重试单独记录但不重复算业务步骤；
- 模型调用记录 prompt/completion token；无法取得真实值时使用保守估算；
- 每次调度前检查总运行截止时间；
- 预算不足时不启动新工具；
- 审批等待时间不计入工具执行时间，但计入 Run 生命周期；
- 预算耗尽必须产生明确、可展示的终止原因。

#### 10.1.5 错误分类与 REPLAN

统一错误结构：

```python
class AgentError(BaseModel):
    code: str
    category: Literal[
        "retryable", "recoverable", "fatal", "cancelled", "budget_exceeded"
    ]
    safe_message: str
    retry_after_seconds: int | None = None
    detail: dict[str, JSONValue] = Field(default_factory=dict)
```

分类示例：

| 场景 | 分类 | 处理 |
|---|---|---|
| 临时网络错误、限流、数据库瞬时失败 | retryable | 指数退避后重试 |
| 任务已被用户修改、候选日期失效 | recoverable | Observer 重新读取上下文并请求 REPLAN |
| 工具未注册、越权、Schema 不合法 | fatal | 立即终止并审计 |
| 用户取消或 Worker 失去租约 | cancelled | 停止后续步骤 |
| Token、步骤或时间超限 | budget_exceeded | 终止并展示预算原因 |

REPLAN 规则：

- 由 Observer 生成 ReplanContext，包含失败步骤、错误类别和仍有效输出；
- Planner 只能替换失败步骤及其未完成下游；
- 已产生外部副作用的 Step 不得被静默重跑；
- 新计划重新经过 Registry、Policy、依赖和预算校验；
- 新增写操作必须重新生成 ChangeSet 并重新审批；
- 每次 REPLAN 形成新 `plan_version`，旧计划保留用于审计。

#### V2.2 执行内核验收标准

- Orchestrator 不包含任何具体工具名或固定步骤编号；
- 至少支持一条包含分支依赖的 6 步计划；
- Worker 中断后在租约过期后由另一 Worker 从未完成步骤继续；
- 非法状态迁移和旧 lease token 更新均被拒绝；
- 步骤、Token、时间和 REPLAN 预算均有测试；
- recoverable 错误能够生成新 plan_version 并继续执行；
- fatal 和 budget_exceeded 不发生自动重试。

### 10.2 V2.2 安全模型

#### 10.2.1 正式 Executor

新增 `core/agent_v2/executor.py`，作为 Agent 产生副作用的唯一入口。职责：

- 接收已验证 PlanStep、PolicyDecision、ChangeSet 和 ToolContext；
- 验证审批状态、审批哈希、用户归属、租约和幂等键；
- 开启事务并调用领域服务；
- 调用 Observer 回读验证；
- 验证失败时回滚事务；
- 保存执行结果和补偿数据；
- 执行 undo/compensation，并再次回读验证；
- 记录开始、成功、失败和补偿 AuditEvent。

Orchestrator 只负责调度和状态迁移，不直接调用写领域服务。API 也不得直接调用 Agent Executor；普通用户操作继续调用共享领域服务，避免把所有业务写入都强制变成 Agent 审批。

#### 10.2.2 PolicyDecision

Policy 统一返回：

```python
class PolicyDecision(BaseModel):
    outcome: Literal["allow", "require_approval", "deny"]
    risk: Risk
    reasons: list[str]
    obligations: list[str]
    policy_version: str
    evaluated_at: datetime
```

Policy 输入至少包括：

- 用户与目标归属；
- AgentRole 和 ToolSpec；
- effect、risk、操作数量和影响范围；
- 是否包含删除、批量修改或外部发送；
- ChangeSet 摘要和当前数据版本；
- Run 预算、来源和主动/用户触发类型。

`obligations` 可包含：

- 必须审批；
- 必须二次确认高风险删除；
- 必须限制批量数量；
- 必须回读验证；
- 必须保存补偿数据；
- 必须隐藏敏感字段；
- 禁止外部发送。

#### 10.2.3 完整 ChangeSet

ChangeSet 增加：

```python
class ChangeOperation(BaseModel):
    operation_id: str
    entity: str
    entity_id: str
    field: str
    before: JSONValue
    after: JSONValue
    precondition: dict[str, JSONValue]
    reason: str
    source_step_id: str
    idempotency_key: str
    compensation: dict[str, JSONValue]

class ChangeSet(BaseModel):
    change_set_id: str
    version: int
    run_id: str
    plan_version: int
    summary: str
    operations: list[ChangeOperation]
    warnings: list[str]
```

规则：

- `precondition` 至少包含 before 值或数据版本；
- 每个 operation 的幂等键全局唯一；
- compensation 在审批前生成并随审批内容持久化；
- 编辑 ChangeSet 后 version 加一、重新计算哈希、旧批准失效；
- 用户只能移除操作或修改 Policy 允许编辑的 after 字段；
- Executor 只执行审批所绑定的精确版本；
- 空 ChangeSet 可以批准，但 Executor 不产生写入。

#### 10.2.4 审批并发

- 批准使用原子 UPDATE：只有 `pending` 审批可变为 `approved`；
- 审批同时校验 change_hash、ChangeSet version 和 Run state_version；
- 重复批准返回已有决定，不重复派发写步骤；
- 批准与编辑并发时只能有一个成功；
- 拒绝、取消、批准互斥；
- 高风险操作在审批后数据发生变化时必须重新生成方案，不允许强制覆盖。

#### V2.2 安全模型验收标准

- Agent 所有 write、destructive、external 和 undo 操作均经过 Executor；
- Policy 的 allow、require_approval、deny 均有测试；
- 并发批准 20 次只产生一次状态迁移和一次写入；
- 批量操作任一项验证失败时整批回滚；
- ChangeSet 编辑后旧哈希和旧版本都不能执行；
- compensation 与原操作都可审计、可验证；
- 从属 Agent 无法注册或调用写工具。

### 10.3 V2.3 受约束规划能力

#### 目标

让主 Agent 能根据请求和当前上下文生成不同的结构化计划，同时保证模型不能绕过 Registry、Policy 和预算。

#### 10.3.1 两级 Planner

采用两级策略：

1. 确定性 Planner：处理已知高频、规则明确的任务，作为稳定路径和模型降级方案；
2. 受约束模型 Planner：处理需要组合多个工具的复杂请求。

模型 Planner 流程：

```text
请求规范化
  → Registry 检索候选工具
  → 构建最小工具目录
  → 模型输出 Pydantic Plan
  → 服务端验证依赖、Schema、权限、预算
  → Policy 预评估
  → 接受计划或回退确定性 Planner
```

限制：

- 模型只能看到候选工具，不接收内部 Handler、数据库连接或密钥；
- `tool_name` 必须精确匹配 Registry；
- 模型不能声明新的 effect、risk、权限或超时；
- 模型输出中的 `user_id`、任意 URL、SQL、Shell 或代码字段直接拒绝；
- 写步骤必须依赖 proposal 和 review 步骤；
- 计划最大步骤、最大写操作数和最大重规划次数由服务端决定；
- 知识和 Web 内容只作为数据，不得改变系统策略或工具目录。

#### 10.3.2 计划验证

PlanValidator 必须检查：

- Step ID 唯一且依赖无环；
- 所有 OutputRef 指向存在的上游输出；
- 工具角色与 AgentRole 匹配；
- 工具输入符合对应 Pydantic Schema；
- 写工具之前存在必要的 proposal、review 和 approval gate；
- 计划估算不超过剩余预算；
- 不存在两个可并发执行的写步骤；
- 主动 suggestion Run 不包含可自动执行的写步骤。

#### 10.3.3 规划审计与质量

每次规划保存：

- `plan_version`；
- 候选工具名称和检索分数；
- 最终选择及简短理由；
- 规划模型、耗时和 Token 使用；
- 验证结果和被拒原因；
- 是否使用确定性降级。

不得保存完整系统 Prompt、密钥或未经裁剪的私密文档。

#### V2.3 规划能力验收标准

- 同一 Planner 能生成分析、知识检索、任务调整和混合请求计划；
- 未注册工具和非法参数在执行前被拒绝；
- 模型不可用或输出无效时自动降级，Run 不直接失败；
- 至少通过 30 条固定规划评测和 20 条对抗提示测试；
- 计划理由可展示，但不能作为权限依据；
- 所有模型成本受 token_budget 控制。

### 10.4 V2.3 四类从属能力

从属 Agent 是受控分析角色，不是拥有自由工具权限的独立自治 Agent。每类输出都必须包含 `summary`、`evidence`、`confidence` 和 `warnings`。

| 角色 | 输入 | 输出 | 允许工具 |
|---|---|---|---|
| 学习分析 Agent | 目标、任务、打卡、时间窗口 | 执行率、逾期任务、学习债务、证据 | context/analytics read |
| 日程优化 Agent | 候选任务、容量、不可用时段、截止日期 | 候选排期、冲突、容量警告 | schedule proposal |
| 知识检索 Agent | 查询、目标范围、来源限制 | 结果摘要、来源引用、相关性 | knowledge/web read |
| 计划审查 Agent | 计划、ChangeSet、约束和风险 | 问题、遗漏、风险、审查结论 | review read |

统一证据结构：

```python
class EvidenceRef(BaseModel):
    source_type: Literal["goal", "task", "checkin", "knowledge", "calendar", "web"]
    source_id: str | None
    label: str
    excerpt: str | None

class SubAgentResult(BaseModel):
    summary: str
    evidence: list[EvidenceRef]
    confidence: float
    warnings: list[str]
    data_types_read: list[str]
```

边界：

- evidence 只引用当前用户有权访问的数据；
- excerpt 默认限制长度并进行敏感字段裁剪；
- confidence 只用于展示和审查，不决定权限；
- 从属 Agent 的 candidate 必须由主 Agent 转换为 Plan 或 ChangeSet；
- 计划审查 Agent 不能批准自己的写入；
- 从属 Agent 失败不应导致已完成写步骤被重放。

#### V2.3 从属能力验收标准

- 四类角色均有独立 Pydantic Request/Response；
- Registry 能按角色过滤工具；
- 每个结论可以追溯到 evidence；
- 任一从属角色请求写工具时被 Policy 拒绝并审计；
- 工作台可以显示当前角色、读取类型和结论摘要；
- 不要求部署四个独立 Worker 或四套模型。

### 10.5 V2.4 工作台可观测性

#### 信息架构

工作台按“用户目标、当前活动、执行证据、安全操作”组织，不直接展示后端原始 JSON。

1. 目标摘要
   - 原始请求；
   - 结构化 intent、goal、constraints；
   - 步骤、Token、时间和 REPLAN 预算；
   - 当前 Run 状态与开始时间。
2. Agent 活动
   - 当前主 Agent/从属 Agent；
   - 正在执行的工具；
   - 已持续时间、尝试次数和心跳状态；
   - 暂停、取消和重试入口。
3. 执行计划
   - Step 依赖、状态和计划版本；
   - 工具选择依据；
   - 输入/输出摘要；
   - blocked、superseded 和 replanned 状态。
4. 数据访问摘要
   - 读取的数据类型、数量和时间；
   - 证据引用；
   - 默认不显示完整文档正文和敏感字段。
5. ChangeSet 与审批
   - before/after、原因、风险和警告；
   - 可编辑字段和不可编辑字段明确区分；
   - ChangeSet version/hash；
   - 批准、拒绝和高风险二次确认。
6. 审计 Timeline
   - plan、tool、policy、approval、executor、observer、replan、undo 事件；
   - actor、时间、结果和安全错误摘要；
   - 支持按角色和事件类型筛选。

#### API 与更新机制

- `GET /runs/{id}` 返回当前完整快照；
- `GET /runs/{id}/events?after=<cursor>` 返回增量事件；
- 第一阶段可继续 2 秒轮询，事件量增加后切换 SSE；
- Event 使用单调 cursor，页面重连后不丢事件；
- 前端状态以服务端快照为准，不在本地推测状态迁移；
- 错误展示使用 safe_message，详细堆栈仅进入服务端日志；
- AuditEvent detail 建立前端可依赖的版本化 Schema。

#### V2.4 工作台验收标准

- 用户可以在一个页面回答“目标是什么、谁在执行、读了什么、为什么这样做”；
- REPLAN 前后计划能够对比；
- 审批页面显示精确 ChangeSet 版本和风险；
- Worker 中断、租约过期和恢复在 Timeline 中可见；
- 刷新和重新登录后 Run 状态、步骤和事件完整恢复；
- 手机和桌面端均不会因长错误、长标题和批量操作产生布局溢出。

### 10.6 V2.4 可靠性测试

#### 测试分层

- 单元测试：Registry、Policy、PlanValidator、Transition Service、Resolver、预算和错误分类；
- 数据库集成测试：原子认领、并发审批、事务回滚、幂等执行和撤销冲突；
- Worker 集成测试：Celery 投递、租约续期、Worker 退出和恢复扫描；
- API 测试：认证隔离、状态冲突、审批编辑和事件游标；
- 端到端测试：工作台创建 Run、等待审批、编辑、批准、完成和撤销；
- 故障注入测试：超时、连接失败、进程退出、重复投递和数据库冲突。

#### 必测场景

| 场景 | 预期结果 |
|---|---|
| 20 个并发批准请求 | 仅一个批准成功，仅执行一次写入 |
| 相同 Celery 任务重复投递 | 仅持有有效 lease 的 Worker 执行 |
| Worker 在只读 Step 中退出 | 租约过期后从该 Step 恢复 |
| Worker 在写入提交后退出 | Observer 根据幂等结果确认，不重复写入 |
| 批量写入第 N 项失败 | 全部回滚，无部分成功 |
| 审批后任务被用户修改 | before/version 校验失败并进入 REPLAN 或重新审批 |
| 撤销前任务再次变化 | 拒绝自动撤销，不覆盖用户新值 |
| 工具超时后重试成功 | 记录 retrying，尝试次数正确 |
| 工具持续超时 | 达到上限后失败或 REPLAN，不无限重试 |
| recoverable 错误 | 生成新 plan_version，保留有效步骤 |
| fatal 越权错误 | 立即失败，不重试、不执行后续步骤 |
| Token/时间/步骤预算耗尽 | 停止调度并记录 budget.exceeded |
| 上游 Step 失败 | 下游进入 blocked，不读取空输出 |
| suggestion Run | 未经批准不产生任何写入或外部发送 |
| 跨用户读取 Run/Step/Event | 返回 404，不泄露存在性 |

#### 发布门槛

- V2.2-V2.4 新模块单元测试覆盖率不低于 85%；
- 并发和故障恢复测试连续运行 100 次无重复写入；
- 核心 E2E 在 PostgreSQL、Redis、Celery Worker 和 Beat 真实组合下通过；
- 所有写工具具备成功、重复执行、并发冲突、回滚和撤销测试；
- 数据库迁移具备 upgrade/downgrade 验证；
- 安全测试确认从属 Agent、模型输出和知识内容都不能扩大权限；
- 发布前保留 V1 兼容入口和 V2 功能开关。

### 10.7 版本依赖与交付顺序

```text
V2.2 执行内核
  → V2.2 安全模型
  → V2.3 受约束规划
  → V2.3 从属能力
  → V2.4 工作台可观测性
  → V2.4 可靠性发布门槛
  → 阶段五外部连接器
```

允许并行的工作：

- Transition Service 与 PolicyDecision 可以并行开发；
- 工作台静态信息架构可提前设计，但必须以后端事件 Schema 为准；
- 确定性 Planner 可先迁移到新 Plan Schema，为模型 Planner 提供降级路径；
- 测试夹具和故障注入框架应从 V2.2 开始同步建设。

不建议并行的工作：

- 通用 Executor 完成前接入新的写工具；
- lease/heartbeat 完成前增加长时间外部工具；
- PolicyDecision 完成前开放邮件、日历写入或外部发送；
- 通用依赖解析完成前继续在 Orchestrator 中增加固定步骤分支。

## 11. 非目标

- 不提供无限自主的通用 Agent；
- 不允许模型生成或执行任意 SQL、Shell、Python 或 HTTP；
- 不让多个 Agent 竞争修改同一数据；
- 不在无审批情况下发送外部消息或覆盖批量日程；
- 不以“模型认为成功”代替数据库回读验证。

## 12. V2.2-V2.4 实施记录

本节记录代码库中的实际实现，不替代第 10 节验收标准。未经过真实 PostgreSQL、Redis、Celery 和浏览器验证的项目不得标记为发布通过。

### 12.1 既有实现基线（2026-07-27）

V2.2 执行内核已完成以下代码改造：

- 新增 `resolver.py`，支持 `depends_on`、`OutputRef`、拓扑约束、上游输出路径解析，以及 failed/blocked/skipped 依赖传播；
- 新增 `transitions.py`，Run 与 Step 状态迁移使用 `status + state_version` CAS 更新，非法迁移和并发覆盖均拒绝；
- Run 增加 `lease_token`、`worker_id`、`heartbeat_at`、`lease_expires_at`，Worker 执行期间独立续租，Beat 扫描过期租约并重新入队；
- 增加步骤、Token、工具耗时、REPLAN 四类预算，并在调度和规划入口校验；
- 新增 `errors.py`，将错误划分为 recoverable、retryable、fatal 和 budget，并提供安全错误摘要；
- REPLAN 生成新 `plan_version`，保留满足约束的已完成步骤，并在 `plan_history` 中记录复用映射。

V2.2 安全模型已完成以下代码改造：

- 新增正式 `executor.py`，write/destructive/external 统一经过租约、Policy、审批、ChangeSet 哈希和版本检查；
- `PolicyDecision` 输出 outcome、risk、reasons、obligations，不接受模型自报权限；
- ChangeSet/Operation 增加 change_set_id、version、source_step_id、operation_id、idempotency_key、precondition 和 compensation 元数据；
- 写入后由 Observer 回读验证；批量写入使用同一事务；undo 通过 Executor compensation 路径并执行冲突检查；
- 审批校验 change_hash、ChangeSet version、Run state_version，高风险操作要求显式二次确认。

V2.3 规划与从属能力已完成以下代码改造：

- Planner 先从 Registry 检索候选工具，再约束模型只输出 Pydantic `AgentPlan`；
- 服务端验证工具注册、角色、输入 Schema、依赖、预算、写入顺序、并发写和 suggestion 边界；
- 模型不可用或计划无效时回退确定性 Planner；规划历史记录候选分数、模型、耗时、Token、验证结果和降级原因；
- 四类从属 Agent 均使用独立结构化请求/响应，结论必须引用 Evidence ID；从属角色无自由工具调用和写权限。

V2.4 工作台已完成以下代码改造：

- 工作台展示目标摘要、当前 Agent 活动、心跳、四类预算、数据读取摘要、结论与证据；
- 执行计划支持版本切换、前后对比、复用/新增/删除标记，以及工具依据和输入输出摘要；
- 审批展示 ChangeSet version/hash、Policy 风险和高风险二次确认；
- 审计 Timeline 支持按 actor 和事件类型筛选；
- `AgentAuditEvent.sequence` 由 PostgreSQL sequence 生成，`GET /runs/{id}/events?after=<sequence>` 提供增量读取。

对应数据库迁移：

- `o9p0q1r2s3t4_agent_v22_runtime_controls.py`：执行状态、预算、租约、审批和 Step 元数据；
- `p0q1r2s3t4u5_agent_v24_observability.py`：规划历史、输入摘要和单调事件序号。

### 12.2 SSE 事件机制（2026-07-27）

代码实现状态：已完成，并已通过 PostgreSQL、API 与浏览器运行验证。

- 新增 `GET /api/v2/agent/runs/{run_id}/events/stream`，打开流前校验登录用户与 Run 所有权；
- 同时接受 `after` 查询参数和 `Last-Event-ID` 请求头，并取两者最大值作为恢复 cursor；
- 事件使用 `id: <sequence>`、`event: agent.audit.v1` 和版本化 JSON data，按 sequence 升序批量发送；
- 流式轮询使用独立 `AsyncSessionLocal`，不长期占用请求依赖注入的数据库会话；
- 每 15 秒发送 heartbeat comment，响应关闭缓存和代理缓冲；
- 工作台使用带 Bearer Token 的 `fetch + ReadableStream` 解析 SSE，按 sequence 去重合并，断线后从最后 cursor 自动重连；
- 原有 2 秒 Run 快照轮询继续作为状态校准和 SSE 降级路径，前端不根据事件自行推断状态机迁移。

### 12.3 发布验证结果（2026-07-27）

#### 数据库迁移与运行服务

- 开发数据库执行 `alembic upgrade head` 后位于 `p0q1r2s3t4u5 (head)`；
- 独立空数据库从 initial schema 完整升级到 head 成功；
- 独立数据库从 `p0q1r2s3t4u5` 连续降级到 `n8o9p0q1r2s3`，再重新升级到 head 成功，覆盖 V2.2 与 V2.4 migration 的 downgrade/upgrade；
- 修复旧 migration `l6m7n8o9p0q1` 对不存在外键执行无条件 DROP 的问题，空库全量迁移不再中断；
- API、Celery Worker 和 Beat 已统一重启；API `/health` 返回 200，Worker 成功连接 Redis，Beat 能定时投递恢复扫描；
- 重启后日志未出现 `ERROR`、Traceback、`MissingGreenlet` 或 asyncpg 跨事件循环错误；
- Next.js 开发服务运行于 `http://localhost:3000`，Agent 工作台返回 200。

#### 自动化测试结果

| 测试层 | 结果 | 覆盖内容 |
|---|---:|---|
| 非集成测试 | 126 passed | 原有业务、Agent V2 API、审批、撤销与核心逻辑 |
| V2.2-V2.4 核心测试 | 35 passed | Resolver、Transition、Policy、Executor、预算、错误分类与 Planner |
| PostgreSQL/Worker/API 集成 | 11 passed | 20 次并发审批、回滚、幂等、撤销冲突、租约、恢复、重复投递、REPLAN 与 SSE |
| soak 故障测试 | 2 passed | 100 轮共 2,000 次审批竞争，以及 100 个过期 Worker Run 恢复 |

V2.2-V2.4 核心模块覆盖率：

| 模块 | 覆盖率 |
|---|---:|
| `errors.py` | 89% |
| `executor.py` | 86% |
| `planner.py` | 86% |
| `policy.py` | 100% |
| `resolver.py` | 91% |
| `transitions.py` | 90% |
| 合计 | 89% |

静态验证结果：Ruff、Python `compileall`、TypeScript `tsc --noEmit` 和 `git diff --check` 均通过。项目当前没有 ESLint 配置，`next lint` 会进入初始化向导，因此未将 ESLint 结果计入发布门槛。

#### 工作台与 SSE E2E

- 浏览器创建请求“检查最近 30 天执行情况，周六不要安排任务，修改前让我确认”；
- 外部模型超过限制时在 15,016 ms 降级为确定性 Planner，页面显示明确降级原因，未再出现约 52 秒无界等待；
- 服务端目标摘要正确保留 `lookback_days=30`、`requires_confirmation=true` 和 `excluded_weekdays=[5]`，模型不能清空归一化 objective；
- Run 进入等待审批，批准后 Executor 应用 1 项变更并由 Observer 回读验证；随后 undo 经 Executor compensation 路径恢复数据，最终状态为 `rolled_back`；
- Timeline 连续显示 `planner.fallback`、审批、Executor、完成和 undo 事件，本轮数据库 sequence 从 `#65` 单调递增到 `#110`；
- API 测试验证 SSE 的 `Last-Event-ID`/`after` 恢复、cursor 去重、非法 cursor 400 和跨用户 404；
- 桌面 `1280x720` 下 document width 与 viewport 一致，无横向溢出和越界元素；
- 移动端 `390x844` 首次检查发现历史栏挤出主工作区，已改为默认收起的覆盖式抽屉；复测 document width 为 390，无主内容裁切，抽屉可打开和关闭；
- 根布局增加 `suppressHydrationWarning` 以匹配 hydration 前主题属性注入，全新浏览器标签页控制台无错误。

#### 测试中发现并修复的问题

1. Celery 使用 `asyncio.run()` 时复用旧事件循环连接池，导致 asyncpg 跨事件循环失败；Worker 任务结束时统一 dispose runtime engine。
2. 并发重复审批会重复投递 Celery；审批服务返回是否发生真实状态迁移，API 仅在首次批准时 dispatch。
3. REPLAN 回滚后访问过期 ORM Step 触发 `MissingGreenlet`；执行前保存稳定 step ID，异常路径不再读取 expired instance。
4. Executor 事务回滚后继续访问 ORM 属性；异常处理全部改用预先捕获的稳定标识。
5. 前端撤销状态仍判断旧值 `undone`；统一为服务端状态 `rolled_back`。
6. 模型 Planner 可返回空 objective 且调用无上限；增加 15 秒超时，并强制使用服务端解析的 objective/constraints。
7. 移动端固定历史栏导致主工作区被裁切；历史栏改为移动端覆盖式抽屉，桌面三栏布局保持不变。
8. hydration 前主题脚本写入 HTML 属性产生 React warning；根元素声明预期 hydration 差异。
9. V2.3 之前生成的部分 `plan_history.steps` 没有 `step_id`，工作台计划比较调用字符串方法时产生运行时异常；前端兼容旧 Schema，并以 `tool_name + index` 生成稳定 fallback ID，新计划继续使用正式 `step_id`。

### 12.4 发布结论与剩余风险

V2.2-V2.4 已达到本章定义的发布门槛，可以进入受控发布。阶段五日历、邮件和其他外部连接器仍保持关闭，不属于本次交付。

当前非阻断风险：

- 外部模型供应商在本次 E2E 中未能在 15 秒内返回，系统通过确定性 Planner 正常降级；模型成功路径由结构化单元测试覆盖，仍需持续观察真实供应商延迟；
- Pydantic 对 `datetime.utcnow()` 产生弃用 warning，后续应统一迁移到 timezone-aware UTC；
- Celery 开发容器当前以 root 运行，并提示 Celery 6 的 broker retry 配置迁移，部署配置需在生产发布前收紧；
- 前端尚未配置 ESLint，当前以 TypeScript、浏览器 E2E 和人工视觉检查作为静态与界面门槛；
- 进入阶段五前，新增的每个外部写工具仍必须分别补齐 Policy、审批、幂等、回滚、撤销和故障注入测试。
