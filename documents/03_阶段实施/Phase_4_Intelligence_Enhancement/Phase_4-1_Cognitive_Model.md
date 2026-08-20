# Phase 4-1 Learner Cognitive Model

## 模型边界

`learner_cognitive_profiles` 是可重算的认知状态快照，不是临床或心理诊断。字段均为 0–1 的行为估计，只有 `forgetting_rate` 表示每日指数衰减率。

| 字段 | 数据来源 |
|---|---|
| learning_speed | mastery velocity、任务掌握变化 |
| retention_rate | 掌握记录按遗忘曲线计算后的平均保持率 |
| forgetting_rate | 复习间隔与掌握下降信号；证据不足时使用保守先验 |
| transfer_score | 多目标/多类型任务的稳定掌握比例 |
| persistence_score | consistency、连续活跃与完成行为 |
| procrastination_score | 逾期、跳过和改期行为 |
| recovery_score | 失败/改期之后重新完成任务的比例 |
| difficulty_preference | 当前任务难度与 Pattern 的组合估计 |
| challenge_tolerance | 高负荷任务完成情况 |
| feedback_acceptance | Proposal 接受与 helpful feedback 比例 |

## Schema

```text
learner_cognitive_profiles
  id, user_id, goal_id
  learning_speed, retention_rate, forgetting_rate, transfer_score
  persistence_score, procrastination_score, recovery_score
  difficulty_preference, challenge_tolerance, feedback_acceptance
  observation_window_days, sample_count, confidence
  last_computed_at, created_at, updated_at
```

与 `learner_profiles` 相同，维持一条 user scope 和每个 active Goal 一条 goal scope，并使用 partial unique index。

## Forgetting Curve

```text
retention(t) = initial_score × exp(-forgetting_rate × elapsed_days)
```

`initial_score` 从 L1–L4 映射为 0.25–1.0。结果 clamp 到 0–1。低于 0.6 的已学习概念进入复习候选，但复习任务只能由 `REVIEW_INSERTION` Proposal 在用户接受后创建。

