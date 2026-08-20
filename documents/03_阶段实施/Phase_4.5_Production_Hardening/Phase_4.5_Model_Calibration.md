# Phase 4.5 Intelligence Model Calibration

## Current model class

Phase 4 的 Cognitive、Failure Prediction、Retention 和 Knowledge Gap 均为可解释 heuristic，不是训练得到的 ML 模型。这是当前缺少用户规模、稳定标签和 ground truth 时的正确基线。

## Current formulas

### Failure Prediction

```text
base = 1 - completion_rate

risk = clamp(
  base * 0.35
  + overdue_pressure
  + deadline_pressure
  + mastery_pressure
  + overload_pressure
  + procrastination_score * 0.20,
  0.02,
  0.98
)
```

风险级别：`low < 0.4`、`medium < 0.7`、`high >= 0.7`。冷启动 completion rate 使用 0.65 默认值。

### Retention

```text
retention(t) = initial_strength * exp(-forgetting_rate * elapsed_days)
```

Forgetting rate 基线为 0.04，根据掌握度下降比例增加，并限制在 `[0.02, 0.18]`。

### Cognitive confidence

```text
confidence = sample_count / (sample_count + 20)
```

认知指标由完成率、掌握度变化、恢复事件、延期/跳过、长任务完成、Proposal 接受和效果反馈组合得到。confidence 用于显式表达样本不足，不把冷启动推断伪装成确定事实。

### Knowledge Gap

Gap 取 prerequisite gap 与 retention gap 的较大值，低于 0.35 不触发；下一概念要求前置知识 retention 至少 0.65。

## Calibration metrics

进入在线学习前至少采集：

| 模型 | 主要指标 | 标签定义 |
|---|---|---|
| Failure Prediction | Brier Score、ECE、PR-AUC、high-risk precision/recall | 任务在计划窗口内是否完成 |
| Retention | MAE、分时间桶 calibration | 延迟复测后的标准化掌握分 |
| Knowledge Gap | Precision@K、复习后增益 | 推荐 gap 是否在测验中失败及复习后提升 |
| Adaptive Proposal | acceptance、apply、override、helpful rate | Proposal 生命周期和反馈 |
| Cognitive Profile | stability、coverage、segment drift | 相邻窗口变化及后续行为相关性 |

必须按新用户、高拖延、高频学习、中断恢复、长期目标和样本量分桶，避免总体均值掩盖弱势 segment。

## Promotion gates

ML 模型只有在以下条件同时满足时才可替换 heuristic：

- 有版本化 feature snapshot 和不可变 label definition。
- 时间切分离线集优于 heuristic baseline，而非随机切分泄漏未来信息。
- high-risk precision/recall 和 calibration 同时达标。
- 冷启动、缺失特征和异常值有显式 fallback。
- 先 shadow mode，再小流量 A/B；所有计划动作仍必须经过 Proposal/Review/Apply Gateway。
- 支持按 model version 一键回滚到 heuristic。

## Migration path

```text
Heuristic baseline
  -> Versioned feature/label logging
  -> Offline calibration report
  -> Candidate ML model
  -> Shadow inference
  -> Guarded A/B
  -> Online recalibration with drift monitoring
```

Phase 5 应先建设数据和评估契约，不应直接训练或在线更新模型权重。
