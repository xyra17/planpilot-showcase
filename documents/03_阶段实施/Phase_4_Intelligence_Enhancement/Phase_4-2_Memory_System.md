# Phase 4-2 Memory System

## 三层结构

| Layer | 存储 | 内容 | 更新方式 |
|---|---|---|---|
| Short Term | 不持久化新副本 | 最近 Task、Checkin、Proposal | 查询时计算 |
| Episodic | `learning_memories` | 失败、突破、恢复、计划调整、Coach 结果 | 独立事件游标增量提炼 |
| Semantic | `learner_patterns` | 带置信度的长期行为知识 | Pattern Analyzer |

`LearningMemory` 是 append-only。`source_event_id + memory_type` 唯一约束确保 Celery 重试幂等。Memory Builder 使用 `memory_builder` 复合游标，不共享或推进 `pattern_analyzer` 游标。

## Retrieval

`GET /api/v1/learner/memories` 返回三层记忆。Episodic 排序使用：

```text
score = importance × 0.65 + recency × 0.25 + lexical relevance × 0.10
```

DecisionContext 默认读取每层最多 8 条安全摘要。原始自由文本、token 和模型 prompt 不进入 Agent Context。

## 调度

`build-learning-memories` 在 Pattern 批次之后错开两分钟、每五分钟执行一次。历史事件首次运行可安全回放。

