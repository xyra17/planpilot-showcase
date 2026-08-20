# Phase 4-3 Adaptive Planning Engine

## Failure Prediction

任务失败概率由可解释的确定性模型计算，输入包括近期完成率、任务逾期、Goal 截止压力、掌握度、当天负荷和拖延分数。输出包含：

- `failure_probability`
- `risk_level`
- `factors[]`

该模型用于排序和生成候选方案，不自动执行动作。

## Proposal 类型

| Type | Apply 行为 |
|---|---|
| `PLAN_ADJUSTMENT` | 改期任务和/或调整每日负荷 |
| `TASK_SPLIT` | 跳过原大任务并创建 2–10 个子任务 |
| `DIFFICULTY_ADJUST` | 调整估时与优先级 |
| `REVIEW_INSERTION` | 为薄弱 Concept 创建 review Task |

状态仍为：

```text
pending → accepted → applied → feedback
       ↘ rejected
```

每种 Apply 在同一事务中重新校验用户所有权、日期、数量和范围。生成 Proposal 与 Apply 分离，LLM 无写权限。

## API

- `GET /api/v1/learner/adaptive-plan/{goal_id}/assessment`
- `POST /api/v1/learner/adaptive-plan/{goal_id}/proposal`

