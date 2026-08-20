# Agent Trace

## Trace 模型

每次 Agent Invocation 的 `trace_id` 对应一组父子 span：

```text
Agent Run
├── Retrieve Decision Context
├── Model Call（每次 retry/fallback 独立记录）
├── Tool Call（存在时）
├── Create Proposal
└── User Action（接受/拒绝/应用/反馈归一化后追加）
```

Span 记录 `trace_id`、`span_id`、`parent_span_id`、status、latency、token、cost、版本/route 等低敏属性和 error category。原始 Prompt、完整上下文与模型响应不写入 Trace。

## 如何调试 Agent

在中文“智能运营”页点击最近 Agent 调用即可打开 Trace 时间线，回答以下问题：上下文是否成功读取、调用了哪个 route、是否 retry/fallback、哪个步骤耗时、哪里产生错误、Proposal 是否创建、用户之后采取了什么动作。管理员也可通过 `GET /api/v1/agent-control/traces/{trace_id}` 获取同一证据链。

普通用户只能读取自己的 Trace；管理员可以跨用户排障。结构兼容未来接入 OpenTelemetry exporter，但当前数据库仍是产品审计事实源。
