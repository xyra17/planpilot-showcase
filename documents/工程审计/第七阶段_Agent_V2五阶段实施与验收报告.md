# 第七阶段：Agent V2 五阶段实施与验收报告

日期：2026-07-27

## 1. 本阶段结论

PlanPilot 已新增 Agent V2 的首条完整纵向能力：

> 分析最近两周执行情况 → 识别逾期任务 → 生成下周排期预览 → 用户审批 → 幂等写入 → 回读验证 → 审计 → 撤销。

旧版 `/api/v1/agent` 继续保留，V2 使用独立的 `/api/v2/agent`，避免一次替换导致已有聊天、规划和打卡流程中断。

## 2. 五阶段完成情况

### 阶段一：业务工具化

- 建立统一 `ToolRegistry` 和 `ToolSpec`；
- 工具声明输入/输出结构、角色、影响类型、风险、审批、超时、重试、幂等和撤销能力；
- 首批工具包括上下文读取、执行分析、知识检索、排期预览、计划审查和任务变更；
- Registry 拒绝从属 Agent 注册写工具；
- Planner 根据请求检索工具目录，分析、知识检索、重新排期会生成不同计划，不再使用 V1 的意图固定节点。

### 阶段二：多步执行引擎

- 持久化 `AgentRun` 与 `AgentStep`；
- 实现 Plan → Act → Observe 的串行依赖执行；
- 记录步骤预算、Token 预算、当前步骤、尝试次数和失败次数；
- 单工具有超时和最多重试次数；
- 失败步骤可以重试，连续失败达到上限后要求新建任务；
- Observer 在写入后回读数据库验证结果。

当前首条能力使用确定性 Planner 保证离线可靠性；模型路由后续只负责理解和提出候选计划，不能绕过 Registry、Policy 或 Executor。

### 阶段三：审批与安全执行

- 所有业务写入只能由主 Agent 的 Executor 工具执行；
- 任务调整使用 ChangeSet 展示修改前后差异；
- 审批时验证 ChangeSet SHA-256，防止用户看到的方案与实际执行内容不一致；
- 每个写步骤生成稳定幂等键；
- 执行时再次校验用户、目标和任务归属；
- 数据发生并发变化时返回 409，要求重新生成方案；
- 已执行排期支持补偿撤销。

### 阶段四：持久任务与工作台

- 新增 Agent 工作台 `/dashboard/agent`；
- 展示历史 Run、主/从 Agent、执行步骤、当前状态、变更预览和安全策略；
- 支持批准、拒绝、暂停、继续、取消、失败重试和撤销；
- 页面刷新后可从数据库恢复状态；
- V2 API 提供 Run 列表、详情和完整生命周期操作。

### 阶段五：从属 Agent、主动建议与扩展边界

- 建立学习分析、日程优化、知识检索、计划审查四类只读从属 Agent；
- 每日 08:00 检查存在逾期任务的用户，每天最多生成一条建议；
- 主动建议只进入 ChangeSet 审批状态，不会自动修改任务；
- 提供受控外部 Connector 协议：连接器由服务端注册并声明允许动作，模型不能提供任意 URL；
- 日历、邮件等真实外部连接器暂未启用，因为它们需要用户选择供应商并完成 OAuth；启用后仍沿用同一审批策略。

## 3. 数据库与 API

迁移：`n8o9p0q1r2s3_agent_v2_runtime.py`

新增表：

- `agent_runs`
- `agent_steps`
- `agent_approvals`
- `agent_audit_events`

当前 PostgreSQL 已执行 `alembic upgrade head`，结果为：

```text
n8o9p0q1r2s3 (head)
```

主要 API：

- `POST /api/v2/agent/runs`
- `GET /api/v2/agent/runs`
- `GET /api/v2/agent/runs/{run_id}`
- `POST /api/v2/agent/runs/{run_id}/approve`
- `POST /api/v2/agent/runs/{run_id}/reject`
- `POST /api/v2/agent/runs/{run_id}/pause`
- `POST /api/v2/agent/runs/{run_id}/resume`
- `POST /api/v2/agent/runs/{run_id}/cancel`
- `POST /api/v2/agent/runs/{run_id}/retry`
- `POST /api/v2/agent/runs/{run_id}/undo`
- `POST /api/v2/agent/suggestions`
- `GET /api/v2/agent/tools`

## 4. 验证结果

| 检查 | 结果 |
|---|---|
| Agent V2 专项测试 | 5/5 passed |
| 非集成测试 | 95 passed |
| 既有集成测试 | 65 passed，2 failed |
| Ruff | passed |
| TypeScript `tsc --noEmit` | passed |
| Alembic PostgreSQL 升级 | passed |
| V2 OpenAPI 路由加载 | passed |
| 未审批不修改任务 | passed |
| 审批后写入并同步任务 API | passed |
| 撤销恢复原日期 | passed |
| 跨用户访问隔离 | passed |

两项既有集成失败来自 V1 掌握度验证调用真实模型超时：

1. `test_verify_start`：`openai.APITimeoutError`；
2. `test_verify_answer_pass`：上一项未生成共享测试数据后的连锁失败。

它们不经过 Agent V2，且本次 V2 专项测试、其余集成测试均通过。上线前仍应为真实模型测试增加独立超时标记或稳定的测试模型端点。

## 5. 已知边界

- 当前任务数据只有日期，没有开始/结束时刻。“周三晚上不排任务”会保守解释为整天避开周三，并在工作台明确提示；
- V2 首条写能力只覆盖任务日期调整；创建/删除任务、目标状态、日程块等工具要逐个复用同一安全协议接入；
- Agent Run 已持久化并支持跨请求恢复；短只读步骤当前在创建请求内完成，长任务接入 Celery 后可复用同一 Run/Step 状态；
- 外部日历、邮件和通知连接器已有安全接口但未默认启用，不能在未授权时视为已连接。

## 6. 上线判断

Agent V2 的基础设施和“分析并重新排期”能力已达到受控试用标准，可在本地/测试环境开始体验。它还不是通用无限自主 Agent，也不应被描述为支持所有业务写操作。下一阶段应以真实用户任务集扩充工具覆盖率和 Agent 评测，而不是放宽 SQL、Shell 或任意 HTTP 权限。
