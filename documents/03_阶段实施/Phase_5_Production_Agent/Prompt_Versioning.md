# Phase 5-1 Prompt & Model Version Management

## 1. 设计目标

每个 Agent 输出必须能够回答：

- 使用了哪个 Prompt、Model 和 Policy 版本？
- 当时为什么选择该版本？
- 输入上下文是否相同？
- 延迟、token、fallback 和错误是多少？
- 该输出最终对应哪个 Proposal 和用户反馈？

## 2. 设计原则

- Version row 创建后不可修改内容；修订必须创建新版本。
- `version` 是 agent_type 内的人类可读标识，数据库关系使用不可变 ID。
- `active` 不直接写在多个 version row 上，由 deployment 指针决定线上版本。
- Secret 不进入数据库；model config 只引用 provider credential alias。
- 运行前一次性解析配置，运行中不得漂移。
- deterministic fallback 也必须记录为 invocation。

## 3. Schema

### 3.1 `prompt_versions`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string PK | UUID |
| `agent_type` | string | `coach`、`planner`、`learner` 等 |
| `name` | string | 稳定 Prompt 名称，如 `daily_coach_prompt` |
| `version` | string | 如 `v1`、`v2` |
| `template` | text | 模板正文 |
| `variables_schema` | JSON | JSON Schema，限制允许变量 |
| `output_schema` | JSON | 期望结构化输出 schema |
| `content_hash` | string | template + schema canonical hash |
| `status` | string | `draft/candidate/approved/retired` |
| `change_note` | text | 修改目的和假设 |
| `created_by` | string | 用户或系统主体 ID |
| `created_at` | datetime | naive UTC |

约束：

- unique `(agent_type, name, version)`
- unique `content_hash` 可限定在同一 agent/name 下
- approved/retired 内容仍不可更新
- `variables_schema` 必须拒绝未声明变量

### 3.2 `model_configs`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string PK | UUID |
| `name` | string | 配置名 |
| `version` | string | 配置版本 |
| `provider` | string | provider 稳定标识 |
| `model_name` | string | provider model identifier |
| `temperature` | float | 0–2，按 provider 能力再约束 |
| `max_tokens` | int | 输出 token 上限 |
| `timeout_ms` | int | 请求超时 |
| `retry_policy` | JSON | 次数、退避、可重试错误 |
| `credential_alias` | string | secret manager alias，不是密钥 |
| `status` | string | `draft/candidate/approved/retired` |
| `created_by` | string | 创建主体 |
| `created_at` | datetime | naive UTC |

Prompt version 不应内嵌 `system_prompt_version` 到 model config。Prompt 与 Model 是正交版本，通过 deployment/variant 组合，才能分别比较效果。

### 3.3 `agent_deployments`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string PK | UUID |
| `agent_type` | string | Agent 类型 |
| `environment` | string | `development/staging/production` |
| `prompt_version_id` | FK | 已批准 Prompt |
| `model_config_id` | FK | 已批准 Model config |
| `policy_version_id` | FK nullable | 已批准 Policy |
| `status` | string | `active/paused/rolled_back` |
| `revision` | int | 乐观并发版本 |
| `deployed_by` | string | 操作主体 |
| `deployed_at` | datetime | 发布时间 |
| `rollback_of_id` | FK nullable | 回滚来源 |

同一 `(agent_type, environment)` 只能有一个 active deployment。切换必须在单事务中完成并写审计事件。

### 3.4 `agent_invocations`

这是每次 LLM 或 deterministic fallback 调用的事实表，不替代工作流 `agent_runs`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string PK | Invocation ID |
| `user_id` | FK nullable | 用户删除后可去标识化策略需另定 |
| `goal_id` | FK nullable | Goal scope |
| `agent_type` | string | Agent 类型 |
| `agent_run_id` | FK nullable | 可关联长流程 run |
| `agent_step_id` | FK nullable | 可关联 step |
| `proposal_id` | FK nullable | 生成后关联 Proposal |
| `prompt_version_id` | FK nullable | fallback 前若已解析仍记录 |
| `model_config_id` | FK nullable | deterministic fallback 可空 |
| `policy_version_id` | FK nullable | 执行时策略 |
| `experiment_id` | FK nullable | 实验 |
| `variant_id` | FK nullable | 实验变体 |
| `input_context_hash` | string | canonical redacted context hash |
| `prompt_render_hash` | string | 最终渲染内容 hash |
| `output` | JSON | 结构化输出或安全摘要 |
| `latency_ms` | int | 端到端调用耗时 |
| `input_tokens` | int nullable | provider 返回时记录 |
| `output_tokens` | int nullable | provider 返回时记录 |
| `total_tokens` | int nullable | 总 token |
| `estimated_cost` | decimal nullable | 按运行时价格快照计算 |
| `success` | bool | 调用和解析是否成功 |
| `fallback` | bool | 是否 deterministic fallback |
| `error_category` | string nullable | 标准错误分类 |
| `trace_id` | string | 与结构化日志关联 |
| `started_at` | datetime | 开始时间 |
| `finished_at` | datetime | 结束时间 |

不要只保存 `model_version` 字符串：provider 可能复用 model 名，必须引用不可变 `model_config_id` 并保留实际 provider response model 名作为审计字段。

## 4. Prompt 渲染

渲染流程：

```text
读取 approved immutable version
  → 按 variables_schema 白名单提取 DecisionContext
  → 类型和大小验证
  → 安全序列化
  → render
  → prompt_render_hash
  → provider call
```

限制：

- 变量不能访问任意对象属性。
- 单变量和总 Prompt 有字符/token 上限。
- Memory、Event、Knowledge 文本作为数据区隔离，不能被拼接成新的系统指令。
- System policy 不能由用户上下文覆盖。
- 未声明变量、渲染失败或超限时进入安全 fallback 并记录原因。

## 5. Context fingerprint

`input_context_hash` 的 canonical 输入需要包含影响决策的字段及其 schema version：

```json
{
  "context_schema_version": "decision-context-v2",
  "profile": {},
  "cognitive_profile": {},
  "active_patterns": [],
  "memories": {},
  "knowledge_gaps": [],
  "goal_context": {},
  "data_quality": {}
}
```

规则：key 排序、日期标准化、浮点精度固定、无序集合排序、排除 request ID 和生成时间等非语义字段。

## 6. 生命周期

```text
draft
  → candidate
  → offline_evaluated
  → approved
  → deployed through deployment/experiment
  → retired
```

- 版本自身不标记 active；deployment 决定线上使用。
- candidate 必须记录 hypothesis 和 owner。
- approved 需要 Evaluation gate 和 Safety gate。
- retired 不允许新 deployment，但历史 invocation 继续可读。

## 7. 兼容迁移

`CoachAgent.PROMPT_VERSION = coach-v1` 的初始迁移策略：

1. 创建与当前模板完全等价的 `prompt_versions` baseline row。
2. 创建与 `create_structured_routine_llm(temperature=0.2, max_tokens=700)` 等价的 model config。
3. 创建 production deployment。
4. Coach 同时记录新 invocation 和现有 `decision_proposals.agent_trace`。
5. 验证一段兼容窗口后，`PROMPT_VERSION` 常量仅作为启动失败 fallback，不再作为线上版本源。

历史 Proposal 不伪造 invocation；保留其现有 `agent_trace`，在查询层标记“历史记录”。

当前用户产品称呼已统一为“学习伙伴”，对应运行 Prompt 为 `coach-v2`。`coach-v1` 作为历史版本保留，不原地修改；活动 deployment 通过数据迁移提升 revision 并切换到 v2，因此仍可审计和回滚。

## 8. API 草案

管理员：

```text
POST /agent-control/prompts
GET  /agent-control/prompts
POST /agent-control/prompts/{id}/submit
POST /agent-control/prompts/{id}/approve
POST /agent-control/models
POST /agent-control/deployments
POST /agent-control/deployments/{id}/rollback
GET  /agent-control/invocations
GET  /agent-control/invocations/{id}
```

普通用户只能通过 Proposal/Coach API 获取：

```json
{
  "strategy_version": "伙伴策略 v2",
  "generated_at": "...",
  "evidence_summary": "..."
}
```

不返回完整 Prompt template、内部 policy rules 或 credential alias。

## 9. 前端中文显示

内部版本管理页：

- 页面名：“AI 版本管理”
- 分区：“提示词版本”“模型配置”“当前发布”“调用记录”
- 操作：“提交评估”“批准发布”“暂停流量”“回滚版本”
- 指标：“平均响应时间”“输入 Token”“输出 Token”“回退率”“成功率”

学习伙伴用户页只显示容易理解的中文，例如“本条建议由伙伴策略 v2 生成”，不直接显示 `prompt_version_id`。

## 10. 验收标准

- 同一 invocation 可追溯精确 Prompt/Model/Policy/Experiment 版本。
- 内容版本不可原地修改。
- 并发 deployment 不会产生两个 active 指针。
- fallback、解析失败和 provider error 同样有 invocation 记录。
- Context hash 在语义输入相同时稳定，在有效输入变化时改变。
- 现有 AgentRun/Proposal 状态机和 Apply Gateway 行为不变。
- 用户可见前端无英文枚举直出。
