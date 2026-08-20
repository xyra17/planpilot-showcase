# Real Data Calibration

Cognitive Profile 和 Failure Prediction 是可解释 heuristic。Phase 6 不调整公式与阈值，只补齐校准数据链路。

1. 预测时写入类型、算法版本、概率、特征快照、对象和结果到期时间。
2. 任务完成、跳过或到期后填入 actual outcome，保留归因方式和观测时间。
3. 周期聚合 sample count、outcome coverage、Brier score、ECE 和概率分箱。

- `<100` 个有结果样本：只显示数据积累，禁止调阈值。
- `100–499`：允许离线分析，不自动上线。
- `>=500` 且覆盖多用户分层：可创建新 algorithm version，重走门禁和 Canary。

特征快照不复制用户原始文本，用户删除时随外键级联清理。
