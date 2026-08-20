# Phase 5-5/5-6 Online Monitoring, Safety & Rollback

## 1. 目标

上线后的版本必须可以被持续观察、自动暂停和安全回滚，同时保持历史 Invocation、Proposal、Experiment 与用户反馈可追溯。

Rollback 的对象是未来流量的版本路由，不是删除历史记录，也不是逆转已经由用户确认并应用的业务变更。

## 2. Policy Version

### `agent_policy_versions`

| 字段 | 说明 |
|---|---|
| `id` | Policy ID |
| `agent_type` | Agent 类型 |
| `name` | 策略名称 |
| `version` | 不可变版本 |
| `rules` | 结构化规则 JSON |
| `rules_schema_version` | DSL 版本 |
| `content_hash` | canonical hash |
| `status` | draft/candidate/approved/retired |
| `change_note` | 修改假设 |
| `created_by/approved_by` | 审计 |
| `created_at/approved_at` | 时间 |

Rules 使用白名单 DSL，不允许任意 Python/SQL。示例：

```json
{
  "max_tasks_per_day": 3,
  "max_reschedule_days": 14,
  "require_user_confirmation": true,
  "allowed_proposal_types": ["PLAN_ADJUSTMENT", "TASK_SPLIT"],
  "minimum_evidence_confidence": 0.6
}
```

硬安全规则如 ownership、Apply Gateway、用户确认不能被实验版本关闭。

## 3. Daily Metrics

### `agent_metrics_daily`

维度：

- `metric_date`
- `agent_type`
- `prompt_version_id`
- `model_config_id`
- `policy_version_id`
- `experiment_id/variant_id`（可空）
- `segment_key`（受控枚举，不存任意用户标签）
- `metric_version`

指标：

- invocation/success/fallback/error count
- proposal created/accepted/rejected/applied count
- accept/reject/apply/helpful rate
- completion_after_advice_7d/30d
- p50/p95/p99 latency
- input/output/total tokens
- estimated cost
- safety finding count
- data drift score
- concept/strategy drift score

unique 维度组合 + metric_date + metric_version。日聚合可由 invocation/feedback/exposure facts 重建。

## 4. Drift Monitoring

### 4.1 Data Drift

检测 Agent 输入分布变化：

- preferred learning hour 分布
- completion/debt/procrastination 分布
- Cognitive confidence 和 sample_count
- active pattern type 分布
- knowledge gap count
- Goal deadline/load 分布

方法从简单、可解释开始：Population Stability Index、分位数变化、类别占比变化。低样本 segment 不告警，只显示样本不足。

### 4.2 Concept/Strategy Drift

检测相同策略效果下降：

- accept/helpful rate 相对 rolling baseline 下降
- 同 proposal_type 的 7d completion outcome 下降
- high confidence 建议的 calibration 变差
- unhelpful/reversal rate 上升
- 某用户 segment 显著退化

Concept drift 需要控制 Prompt/Model/Policy version；混合版本聚合不能用于判断某个策略失效。

### 4.3 Operational Drift

- provider error/fallback 上升
- p95 latency 超预算
- token/cost 突增
- invalid JSON 或 schema validation error 上升
- Celery attribution/metrics task lag

## 5. Alert State

```text
healthy
  → warning
  → critical
  → recovering
  → healthy
```

每个告警规则包含 metric version、window、minimum sample、threshold、consecutive windows 和 severity。单个小样本异常不能直接触发全局 rollback。

建议初始规则：

- critical safety finding > 0：立即 critical。
- provider success rate 连续 3 个 5 分钟窗口低于阈值：切 fallback/rollback。
- p95 latency 连续窗口超限：pause experiment，保留 control。
- helpful/accept/completion 指标：只在 minimum sample 达标后触发 warning，自动动作更保守。

## 6. Incident

### `agent_incidents`

| 字段 | 说明 |
|---|---|
| `id` | Incident ID |
| `severity` | warning/critical |
| `agent_type` | Agent 类型 |
| `deployment_id` | 受影响 deployment |
| `experiment_id` | 可空 |
| `trigger_metric` | 指标与版本 |
| `evidence_snapshot` | 聚合安全快照 |
| `status` | open/mitigating/resolved |
| `action_taken` | pause/rollback/kill_switch/manual |
| `rollback_deployment_id` | 可空 |
| `created_at/resolved_at` | 时间 |
| `resolved_by` | 主体 |

Incident append audit event，处置说明不可静默覆盖。

## 7. Rollout

版本发布顺序：

```text
Offline gate
  → Shadow 0% user-visible
  → Internal users
  → 1% canary
  → 10%
  → 50%
  → 100%
```

每个阶段需要 minimum duration/sample 和 guardrail。推进创建 deployment revision，不修改原记录。

Shadow invocation：

- 不生成用户可见 Proposal。
- 不执行 Apply。
- 有独立 token/cost budget。
- 结果只进入 Evaluation，不影响用户 Pattern。

## 8. Rollback

### 8.1 Manual rollback

管理员选择最近一个已批准且健康的 deployment，提供中文原因并确认。Service 在单事务中：

1. 校验目标版本已批准且与 agent_type/environment 匹配。
2. 锁定当前 active deployment。
3. 创建新的 rollback deployment revision，引用 `rollback_of_id`。
4. 更新 resolver cache/version。
5. 写结构化 audit event 和 incident action。

### 8.2 Automatic rollback

只允许预先批准的 hard guardrail 自动触发：

- critical safety violation
- 大规模 provider/schema failure
- 明确的错误率或延迟灾难

质量 uplift 下跌默认先 pause experiment/canary 并通知人工，不在低样本下自动全局回滚。

### 8.3 Kill switch

粒度：

- 全局 Agent
- agent_type
- provider/model config
- experiment

Kill switch 后：

- Coach 进入已批准 deterministic fallback，或显示中文可用性提示。
- 不丢失用户提交的 Feedback。
- 不尝试补执行已过期 Proposal。
- 恢复需要显式操作和健康检查。

## 9. 并发与缓存

- Deployment 使用 revision 做 optimistic concurrency。
- Resolver cache key 包含 environment + agent_type + deployment revision。
- rollback 提交后先更新数据库，再发布 cache invalidation；缓存失败时短 TTL 保证收敛。
- Invocation 保存解析快照，即使 rollback 同时发生，也能说明该请求实际使用哪个版本。

## 10. API 草案

```text
GET  /agent-monitoring/health
GET  /agent-monitoring/metrics/daily
GET  /agent-monitoring/drift
GET  /agent-monitoring/incidents
POST /agent-control/deployments/{id}/rollback
POST /agent-control/kill-switches
POST /agent-control/kill-switches/{id}/restore
```

所有写控制面 API：管理员授权、CSRF/认证保护、reason 必填、request ID 和审计记录。

## 11. 前端中文显示

内部页面：

- “AI 运行监控”
- “运行状态”“建议接受率”“建议后完成率”“回退率”
- “数据变化”“策略效果变化”“响应时间”“Token 成本”
- “安全事件”“当前发布”“最近稳定版本”
- 操作：“暂停实验”“停止新建议”“回滚到此版本”“恢复服务”

回滚确认文案必须明确：

> 回滚只影响后续 AI 建议，不会撤销用户已经确认并应用的计划修改。

用户侧降级：

- “学习伙伴暂时使用基础建议模式，你仍可以正常管理学习计划。”
- 不显示堆栈、provider 名或内部 incident 内容。

## 12. 验收标准

- Daily metrics 可由事实表重建且有 metric version。
- Drift 按固定版本和 segment 计算。
- 低样本不产生错误胜负或自动质量回滚。
- Rollback 不修改历史 invocation/proposal/exposure。
- Critical safety/provider failure 可自动切安全版本或 fallback。
- 并发发布/回滚不会产生两个 active deployment。
- 所有控制操作有主体、原因和 audit trace。
- 前端状态、告警和确认均为中文。
