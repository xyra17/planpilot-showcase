# Profile Builder 与 Decision Context

## Profile Builder

`ProfileBuilder.build_for_user()` 每次全量计算最近 30 天窗口：

- 创建或更新一条 user Profile（`goal_id IS NULL`）。
- 为每个 active Goal 创建或更新一条 goal Profile。
- 优先使用 active/decayed Pattern；Pattern 低置信度时与 Event 聚合平滑混合。
- Pattern 不可用时回退到历史 Learning Event；数据仍不足则保留 `NULL`。
- 不修改 Pattern，不执行 confidence 衰减。

当前指标包括一致性、每周活跃天数、单次/每日投入时长、完成率、掌握率、掌握速度、偏好时段/星期、估时准确性、债务倾向和改期率。

为解决 SQL 中 `NULL` 不参与普通唯一约束的问题，迁移新增两个局部唯一索引：

- `user_id WHERE goal_id IS NULL`
- `(user_id, goal_id) WHERE goal_id IS NOT NULL`

## Event 兼容

历史代码实际写入 `CheckinSubmitted.completed` 与 `actual_mins`，早期设计和 Rule 使用
`completed_count` 与 `time_investment_mins`。实现采取两层兼容：

- Profile calculator 同时读取两套字段。
- 新 Checkin Event 同时写入兼容别名。
- 新 TaskCompleted Event 补充 `estimated_mins`，支持估时准确性计算。

## Decision Context

`DecisionContextBuilder` 只执行查询与序列化，输出四层信息：

1. Profile：goal Profile（至少 5 条事件）→ user Profile → default。
2. Active Patterns：只返回 `status=active AND confidence>=0.5`；目标 Pattern 优先。
3. Recent Events：最多 20 条，仅输出白名单 payload 字段。
4. Goal Context：目标、当前 Plan、任务统计、未来 7 天任务与逾期任务。

每个 Pattern 额外返回最近 6 条 PatternEvidence 来源，使前端可以解释“为什么 AI 这样建议”。
对 `delay_pattern`，每条延期证据还返回 `days_overdue`、任务标题、是否被用户标记为
外部中断以及 `evidence_id`，供学习记忆页对具体记录做可审计归因；这不会修改原始
`TaskCompleted` 事件。

## 前端

`/dashboard/coach` 展示：

- 近 30 天学习状态与数据质量。
- 最佳学习时间、平均投入、完成率与掌握趋势。
- Active Pattern 置信度、证据数、scope 和最近事件来源。
- goal selector 与手动画像重建入口。
