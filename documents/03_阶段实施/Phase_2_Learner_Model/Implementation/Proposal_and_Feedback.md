# Decision Proposal 与 Feedback Loop

## Proposal 状态机

```text
pending ──accept──> accepted ──apply──> applied
   └────reject────> rejected
```

- `pending` 才能接受或拒绝。
- `accepted` 才能应用。
- 重复 accept/apply 对相同终态保持幂等。
- 过期 Proposal 不允许接受或应用。
- 所有 Proposal 必须引用至少一个属于当前用户的 Active Pattern。

当前生成器每次最多生成一条建议：

1. 有逾期任务：`reschedule_overdue_tasks`。
2. 无逾期且 30 天完成率低于 70%：`reduce_daily_load`。
3. 无需结构变更：`learning_nudge`。

## Apply Gateway

Agent 不拥有 Goal/Task 写权限。用户接受后，Apply Gateway 只执行白名单操作：

- 重新安排当前用户拥有的任务，日期必须为今天或未来。
- 调低当前用户拥有目标的 `daily_hours`，范围为 0.25~16。
- 对纯提醒 Proposal 只记录应用状态，不修改业务实体。

每次应用会在同一事务中写入对应业务变更及 `TaskRescheduled`、`GoalUpdated`、
`ProposalApplied` Learning Event。

必须存在的审计事件：

- `ProposalCreated`
- `ProposalAccepted`
- `ProposalRejected`

## Feedback Loop

只有 `applied` Proposal 可以记录一次效果反馈：

- `helpful`：提高引用 Pattern 的 confidence。
- `neutral`：保留 confidence，但记录证据。
- `unhelpful`：降低引用 Pattern 的 confidence；低于阈值时转为 `decayed`。

反馈会同时写入：

- `proposal_feedback`
- `ProposalFeedbackRecorded` Learning Event
- 每个引用 Pattern 对应的新 PatternEvidence

Review 本身也是弱信号：接受建议以 `+0.01` 轻量确认引用 Pattern，拒绝建议以
`-0.02` 轻量削弱；实际效果反馈使用更强的 `+0.05 / 0 / -0.08` 信号。这样既利用
accept/reject rate，又避免把“暂时不想执行”误当作强烈的 Pattern 反证。

统计 API 返回 accept rate、reject rate、apply rate、反馈分布、整体 Pattern accuracy 与逐 Pattern accuracy。

## 前端交互

学习伙伴页支持完整流程：查看依据 → 接受/拒绝 → 应用 → 有效/一般/无效反馈，并显示建议接受率、应用率和 Pattern 准确率。
