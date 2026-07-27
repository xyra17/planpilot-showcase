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

## 9. 非目标

- 不提供无限自主的通用 Agent；
- 不允许模型生成或执行任意 SQL、Shell、Python 或 HTTP；
- 不让多个 Agent 竞争修改同一数据；
- 不在无审批情况下发送外部消息或覆盖批量日程；
- 不以“模型认为成功”代替数据库回读验证。
