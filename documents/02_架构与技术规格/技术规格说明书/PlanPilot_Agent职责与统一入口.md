# PlanPilot Agent 职责与统一入口

## 产品命名

产品对外只有一位 Pilo，并提供两种工作模式：回答问题，以及在用户确认后执行行动。界面、文案和导航均不展示 `Agent v1`、`Agent v2` 或多个机器人。

内部实现分为对话运行时与行动运行时。`coach` 仅是历史兼容标识，对应学习洞察生产策略，不是第三套 Agent。

## 职责边界

| 能力 | 对话运行时 | 行动运行时 |
| --- | --- | --- |
| 普通问答、解释、资料问答 | 是 | 否 |
| 读取目标、任务、学习记录 | 用于回答上下文 | 用于行动证据 |
| 自然语言打卡 | 生成可确认预览 | 确认后执行 |
| 新建、删除、完成、移动任务 | 否 | 预览 → 确认 → 执行 |
| 逾期任务批量重排 | 否 | 预览 → 确认 → 执行 |
| 失败恢复和撤销 | 重新发送对话 | 重试、取消、恢复、撤销 |

## 统一路由

Pilo 仍使用一个输入框和 `/api/v1/agent/stream`。服务端先生成统一 `ActionIntent`，完成实体解析、缺失参数检查和消歧，再使用零模型确定性规则分流：

```text
用户请求
  ├─ 问答、解释、分析、未支持的行动
  │    → 对话 Agent 流式回答
  └─ 已支持且意图明确的任务变更
       → 创建行动 Run
       → 生成 ChangeSet 预览
       → 等待用户确认
       → 执行或保留原计划
       → 可审计、可撤销
```

模糊请求默认留在对话 Agent，不会为了“显得智能”而创建无法完成的 Run。

## 行动运行时

行动运行时不是五个自治模型 Agent，而是：

- 一个确定性 Orchestrator，维护 Run、步骤和状态；
- 学习分析能力；
- 计划与任务编排能力；
- 知识与证据能力；
- 风险与影响审查能力；
- 一套由 Policy、ChangeSet、Approval、Executor、Observer、Audit 和 Undo 组成的安全执行内核。

四类能力模块只有受控工具和结构化输入输出，不能注册或调用副作用工具。Orchestrator 只能申请执行；Executor 是唯一物理写入口。

```text
ActionIntent
  → 确定性计划或受约束 Structured Planner
  → 受控能力生成 ChangeSet
  → 风险与影响审查
  → 用户审批
  → Executor
  → 回读验证与审计
  → 可撤销补偿
```

## 学习洞察

`DecisionProposal` 作为兼容表逐步承担 Learning Insight 语义：发现风险、保存证据、理由和置信度，但不再通过 HTTP Apply 直接写业务表。用户点击“生成调整方案”后，洞察通过 `converted_run_id` 关联 Action Run，并进入统一审批链。定时任务只生产洞察，不预先制造等待审批的 Run。

## 首批开放行动

1. 将逾期任务重新安排到下周。
2. 明确新建、删除、完成任务。
3. 将明确指定的任务移到今天、明天或指定日期。

暂不自动分流的请求：

- 将大任务拆成有语义的多个子任务。
- 重新设计整个目标或长期计划。
- 只要求“给建议”、“讲思路”、“解释”的请求。

这些能力必须先有可验证的预览工具、补偿策略和测试，再加入行动路由。

## 写入安全规则

- 只读步骤可直接执行。
- 所有任务写入必须生成变更前后对比。
- 所有 AI 发起的目标和任务写入必须经过同一条 Action Run 执行链。
- 用户确认前不得调用写工具。
- 删除类操作需额外的高风险确认。
- 执行后记录审计事件；有补偿操作时显示“撤销”。
- 任务版本已变化时拒绝使用过期 ChangeSet。

## Action Beta 证据边界

Action Beta 不增加新的 Agent、模型、工具或行动能力，只为现有行动链增加服务端 cohort、证据度量和安全停机边界。

- 默认 `beta_enabled=false`；非 cohort 用户继续使用稳定行为。
- 优先使用管理员白名单，百分比分桶仅允许 5%、20%、50% 三个扩量阶段。
- 全局 kill switch 只阻止新 Action Run；已有 Run 仍可见、可审计、可继续读取和撤销。
- 扩大白名单、提升百分比、首次启用或安全停机后恢复，都要求最近一次 Runtime Safety Gate 通过且关键安全通过率为 100%。
- 未确认写入、跨用户访问、重复写入或 Review–ChangeSet 绑定失败任一大于 0，立即禁止扩量并关闭新 Action Run。
- 所有控制变化写入追加式审计，不依赖前端状态作为授权边界。

统一漏斗当前使用 `action-beta-funnel-v2`；v1 只读保留，不再作为发布判断。v2 从迁移激活时间或显式 start 起算，默认只看 Beta cohort，并以具有相同 `conversation_turn_id` 的唯一收到会话和唯一已路由会话计算路由率。Insight、Scheduler、API、Internal 和 Legacy Run 使用独立 source funnel。`GOAL_PLAN_CREATE` 与 `CHECKIN_RECORD` 不计入 Coach Insight 转化，撤销 Run 不计入净执行成功；所有比率由后端保证在 0～1。

安全观测不再把空快照解释为 0。状态只能是 `unknown`、`stale`、`observed_clear` 或 `violated`。恢复新 Action 或扩大 cohort 同时要求：与当前部署 revision、运行时代码摘要、迁移 head 和冻结数据集 hash 完全匹配且未过期的 Runtime Gate，以及同样新鲜的 `observed_clear` 审计扫描。管理员只能触发真实扫描，不能提交任意计数。

复核队列仅从 `LearningEvent`、`AgentAuditEvent` 和 `AgentRun` 的真实持久化事实生成。默认只保存伪匿名用户键和结构化上下文，不复制完整请求文本。只有人工确认、去重和脱敏后的案例才能进入 `intent-routing v1.2` 或 `action-changeset v1.2` 候选集；候选集不会进入现有冻结门禁。
# Action Gateway 语义边界补充（2026-08-24）

统一入口必须先区分“用户汇报学习进度”和“用户命令修改明确任务实体”：

- “今天完成了学习任务”“今天完成了两项，打个卡”属于自然语言打卡。它们进入对话理解完成度，再生成 `CHECKIN_RECORD` Action Run 预览；用户确认前不写入。
- “把任务‘X’标记完成”“今天把‘X’做完了，帮我标记完成”包含明确任务实体和修改命令，进入 task mutation Action Run。
- 假设、影响询问或明确“只分析不要执行”的表达保持 conversation，不创建 Run、不写入。

批量逾期重排必须有合法 `goal_id`。当请求为“把所有逾期任务重新安排到未来一周”但没有目标作用域时，Gateway 创建有时效的 `PendingActionIntent` 并 grounded clarification，请用户选择目标；不得猜成跨目标全局写入。相同请求携带归属校验通过的 `goal_id` 后，才生成 durable Action Run。该合同迁移取代旧测试中“无 goal 直接生成 Run”的假设。
