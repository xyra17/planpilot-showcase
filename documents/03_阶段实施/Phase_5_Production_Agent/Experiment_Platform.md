# Phase 5-3 Online Experiment Platform

## 1. 目标

对已通过离线评估和安全门禁的版本组合进行可控在线比较，回答 Prompt、Model 或策略变化是否带来真实学习效果提升。

Phase 5 初期只支持固定流量、稳定分组的 A/B，不实现 bandit 或自动流量优化。

## 2. 核心原则

- Assignment 与 Exposure 分离：分到实验组但未触发 Agent，不算曝光。
- 用户在一个实验周期内稳定分组，避免跨组污染。
- 变体只引用不可变 Prompt/Model/Policy version IDs。
- 实验不能绕过 deployment、安全 policy、Proposal 和用户审核。
- 指标、窗口、停止条件必须在启动前锁定。
- 不能因看到中间结果而静默修改 primary metric。

## 3. Schema

### 3.1 `experiments`

| 字段 | 说明 |
|---|---|
| `id` | Experiment ID |
| `name` | 稳定名称 |
| `hypothesis` | 可证伪假设 |
| `agent_type` | 作用 Agent |
| `environment` | 默认 production |
| `status` | draft/approved/running/paused/completed/cancelled |
| `allocation_percent` | 总实验流量比例 |
| `primary_metric` | 启动前锁定 |
| `secondary_metrics` | JSON |
| `guardrail_metrics` | JSON |
| `eligibility_rules` | JSON DSL |
| `start_at/end_at` | 实验窗口 |
| `minimum_sample_size` | 最小曝光用户数 |
| `analysis_plan` | 显著性和分群计划 |
| `created_by/approved_by` | 审计 |
| `created_at/updated_at` | 时间 |

### 3.2 `experiment_variants`

| 字段 | 说明 |
|---|---|
| `id` | Variant ID |
| `experiment_id` | Experiment FK |
| `key` | `control/treatment_a/...` |
| `display_name` | 中文显示名 |
| `traffic_weight` | 变体内部权重，合计 1 |
| `prompt_version_id` | Prompt FK |
| `model_config_id` | Model FK |
| `policy_version_id` | Policy FK |
| `is_control` | 是否对照 |

### 3.3 `experiment_assignments`

| 字段 | 说明 |
|---|---|
| `id` | Assignment ID |
| `experiment_id` | Experiment FK |
| `user_id` | User FK |
| `variant_id` | Variant FK |
| `bucket` | 0–9999 hash bucket |
| `assignment_version` | 分流算法版本 |
| `eligibility_snapshot` | 安全摘要 |
| `assigned_at` | 时间 |

unique `(experiment_id, user_id)`，普通运行过程中不改组。

### 3.4 `experiment_exposures`

| 字段 | 说明 |
|---|---|
| `id` | Exposure ID |
| `assignment_id` | Assignment FK |
| `agent_invocation_id` | Invocation FK unique |
| `exposed_at` | 首次实际使用变体时间 |
| `context_hash` | 输入 fingerprint |

一个 invocation 最多产生一个 exposure。指标分析以首次曝光或预注册的重复曝光规则为准。

## 4. 稳定分组

建议算法：

```text
bucket = HMAC_SHA256(experiment_salt, user_id) mod 10000
```

- salt 属于实验且不可在运行中改变。
- HMAC key 来自配置/secret，不暴露用户 ID hash 字典。
- 先判断 eligibility，再判断是否进入 allocation_percent，最后按 variant cumulative weight 分组。
- assignment 落库后以数据库结果为准，不在每次请求重新计算并覆盖。

## 5. Eligibility

初期 JSON DSL 只允许白名单条件：

- account age / locale
- active goal count
- minimum evidence/sample count
- coach enabled
- 未加入互斥实验组
- 用户实验 opt-out

禁止执行任意表达式或 SQL。Eligibility snapshot 只存安全摘要，不能复制完整用户画像。

## 6. 指标与归因

### Primary outcome 示例

- 7 日任务完成率
- Proposal helpful rate
- Applied Proposal 后 7 日 completion uplift

### Secondary

- accept rate、apply rate、reject rate
- recovery rate、mastery velocity
- 建议后任务延期率

### Guardrails

- critical safety findings
- unhelpful rate
- fallback/error rate
- p95 latency
- token cost per successful proposal
- 用户关闭 Coach/实验的比例

归因窗口从实际 exposure 开始，而不是 assignment 时间。一个 outcome 必须保存 attribution window、metric version 和计算日期。

## 7. 统计检查

- 报告每组 unique assigned、exposed、outcome count。
- 检测 Sample Ratio Mismatch（实际分组显著偏离配置权重）。
- primary metric 显示 absolute difference、relative uplift、置信区间。
- 分析 Intent-to-Treat 和 Exposed population 时必须明确区分。
- 多次查看中间结果时使用预设 sequential rule，或只在结束时做正式结论。
- 小样本显示“样本不足”，不输出胜者。

## 8. 生命周期状态机

```text
draft
  → approved
  → running
  → paused
  → running
  → completed

draft/approved/running/paused
  → cancelled
```

- running 后 hypothesis、versions、metrics、weights 不可修改。
- 流量调整创建新 experiment revision，不能改写历史 exposure。
- paused 阻止新 assignment/exposure，已有历史保留。
- completed 只读。

## 9. 故障和安全行为

- Resolver 或数据库失败时使用 production control deployment，不猜测 variant。
- 实验版本 provider 失败可以进入已批准 fallback；Invocation/Exposure 必须记录实际 fallback，主要分析中单独分层。
- Guardrail critical 时自动 pause 实验，并创建 incident；是否 rollback deployment 由 Safety policy 决定。
- 取消实验不会撤销已应用业务变更。

## 10. API 草案

管理员：

```text
POST /agent-experiments
POST /agent-experiments/{id}/approve
POST /agent-experiments/{id}/start
POST /agent-experiments/{id}/pause
POST /agent-experiments/{id}/complete
GET  /agent-experiments/{id}/results
GET  /agent-experiments/{id}/health
```

用户：

```text
GET  /learner/coach-experiment-disclosure
POST /learner/coach-experiment-opt-out
```

## 11. 前端中文显示

内部页面：“在线实验”

- “实验假设”“对照组”“实验组”“流量比例”
- “主要指标”“护栏指标”“样本量”“可信区间”
- “样本分配异常”“样本不足”“实验已暂停”
- 操作：“批准实验”“开始实验”“暂停流量”“结束实验”

用户侧披露：

> 正在体验一项学习伙伴策略改进。它不会自动修改你的计划，你仍可以审核、拒绝或退出。

不得向普通用户展示其他组结果、内部版本 ID 或统计诊断信息。

## 12. 验收标准

- 同一用户稳定进入同一 variant。
- 未 Invocation 的 assignment 不计 exposure。
- Experiment running 后配置不可变。
- Resolver 失败安全回到 control deployment。
- 指标按预注册窗口计算并可重算。
- SRM、guardrail 和样本不足能阻止错误结论。
- 实验建议仍需 Proposal Review/Apply。
- 所有前端文字为中文。
