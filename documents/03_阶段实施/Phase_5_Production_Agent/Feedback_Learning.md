# Phase 5-4 Feedback Learning Loop

## 1. 目标

把现有 Proposal 接受/拒绝和 helpful/neutral/unhelpful 反馈升级成可归因、可重放、可评估的学习信号：

```text
Invocation
  → Proposal
  → Review / Apply
  → Explicit Feedback
  → Delayed Behavioral Outcome
  → Evaluation Signal
  → Candidate Strategy
```

学习循环不会直接编辑 production Prompt、Policy 或 Model deployment。

## 2. 现有事实来源

- `decision_proposals`：pending/accepted/rejected/applied 生命周期。
- `proposal_feedback`：每个 applied proposal 一条显式效果反馈。
- `learning_events`：ProposalCreated/Accepted/Rejected/Applied/FeedbackRecorded 及任务行为。
- `PatternEvidence`：反馈对 Pattern confidence 的可追溯信号。

这些表继续是业务事实源。新增 `agent_feedback_events` 是 Evaluation/Experiment 使用的标准化 append-only 信号，不替代或双写修改业务状态。

## 3. `agent_feedback_events`

| 字段 | 说明 |
|---|---|
| `id` | Feedback Event ID |
| `user_id` | User FK |
| `goal_id` | Goal FK nullable |
| `agent_invocation_id` | Invocation FK nullable |
| `proposal_id` | Proposal FK nullable |
| `source_event_id` | LearningEvent FK nullable |
| `feedback_type` | 标准信号类型 |
| `value` | 数值或枚举 JSON |
| `reason` | 用户原因或安全摘要 |
| `attribution_window` | 如 `immediate/24h/7d/30d` |
| `metric_version` | 派生规则版本 |
| `occurred_at` | 原事实发生时间 |
| `created_at` | 信号生成时间 |

幂等键按来源确定：

- 即时 Proposal 事件：unique `(source_event_id, feedback_type, metric_version)`。
- 延迟 outcome：unique `(proposal_id, feedback_type, attribution_window, metric_version)`。

## 4. 信号分类

### 4.1 Immediate review signals

- `proposal_accepted`
- `proposal_rejected`
- `proposal_applied`
- `proposal_adjusted`
- `feedback_helpful`
- `feedback_neutral`
- `feedback_unhelpful`

接受不等于有效；它只表示建议可接受。应用也不等于学习效果提升。

### 4.2 Delayed behavioral outcomes

- `task_completed_after_advice`
- `task_overdue_after_advice`
- `completion_rate_7d`
- `completion_rate_30d`
- `mastery_gain_7d`
- `recovery_after_advice`
- `advice_reverted`

这些信号由 Celery 按 attribution window 计算，必须保存 metric version 和当时的 eligible task set。

### 4.3 Negative and safety signals

- `unsupported_evidence_reported`
- `user_opted_out`
- `policy_blocked`
- `proposal_apply_failed`
- `critical_safety_finding`

安全信号不得与普通质量分平均后被抵消。

## 5. Attribution

Proposal 可能只影响部分任务，不能把 Goal 全部变化都归因给它。

每个 proposal_type 定义 attribution contract：

| Proposal | Eligible outcome |
|---|---|
| `TASK_SPLIT` | 新子任务在窗口内的完成/延期 |
| `PLAN_ADJUSTMENT` | 被调整任务和计划容量 |
| `DIFFICULTY_ADJUST` | 目标任务完成、掌握变化 |
| `REVIEW_INSERTION` | 新复习任务及对应 concept retention/mastery |
| `learning_nudge` | 只做弱归因，不宣称直接因果 |

Apply Gateway 应返回或记录实际 change set identifiers，使 attribution 使用实际写入结果而非 Proposal 原始草案。

## 6. Learning signal pipeline

```text
LearningEvent / ProposalFeedback
  → FeedbackNormalizer
  → agent_feedback_events
  → OutcomeAttributionTask
  → versioned metrics
  → Evaluation / Experiment aggregation
  → CandidateStrategyGenerator
```

- Normalizer 使用独立 cursor，失败可重放。
- append-only event 不更新旧信号；规则变化创建新 metric_version。
- 聚合表可从 event 重建。
- CandidateStrategyGenerator 只能生成 candidate，不得自动 active。

## 7. Pattern 与 Strategy 更新边界

现有显式 feedback 可继续通过 `apply_pattern_signal` 小幅调整 Pattern confidence，但需要：

- 贡献值有版本。
- 负反馈不能把单个 Pattern 立即归零。
- 多个 Proposal 引用同一 Pattern 时避免重复归因同一结果。
- Pattern confidence 与 Agent strategy quality 分开计算。

Prompt/Policy 的改进流程：

```text
聚合反馈发现候选问题
  → 生成 change hypothesis
  → 新建 prompt/policy candidate
  → Offline Evaluation
  → Experiment
  → Approval / Deployment
```

禁止“某用户拒绝一次 → 直接全局修改 Prompt”。

## 8. 用户原因与中文分类

前端拒绝/调整建议时提供可选中文原因：

- “时间安排不合适”
- “任务难度判断不准确”
- “建议依据不符合实际”
- “我暂时不想调整计划”
- “其他原因”

反馈后显示：

- “已记录你的反馈”
- “这会帮助学习伙伴改进后续建议”
- “反馈不会自动修改你的计划”

自由文本需要长度限制、内容安全处理和隐私提示；内部分析优先使用结构化 reason code。

## 9. Metrics

- accept/reject/apply/adjust rate
- helpful/unhelpful rate
- feedback coverage：applied proposal 中有反馈的比例
- 7d/30d completion after advice
- recommendation reversal rate
- outcome attribution coverage
- per prompt/model/policy/variant quality
- per user segment quality
- delayed signal processing lag

报告必须区分“用户喜欢”与“学习结果改善”。

## 10. API 草案

用户：

```text
POST /learner/proposals/{id}/feedback
GET  /learner/feedback/summary
GET  /learner/feedback/history
```

内部：

```text
GET /agent-monitoring/feedback-events
GET /agent-monitoring/outcomes
POST /agent-control/strategy-candidates
```

历史接口保持兼容；新字段使用可选扩展，避免破坏现有 Coach 页面。

## 11. Retention 与删除

- Feedback event 含用户关联，必须遵守账户删除和数据保留策略。
- Evaluation 使用的样本需去标识化后进入 Dataset。
- 删除用户时不能留下可反查的 reason/context snapshot。
- Experiment 汇总可保留匿名统计，但 assignment 和原始反馈按策略删除。

## 12. 验收标准

- 同一来源事件重放不会产生重复 feedback event。
- 即时信号和延迟结果明确分开。
- Attribution 只覆盖 Apply 后实际受影响对象。
- metric version 变化不会覆写历史结果。
- Feedback 不会直接发布 Prompt/Policy。
- Pattern 和 Strategy quality 不混为一个 confidence。
- 中文反馈原因和状态在前端完整展示。
