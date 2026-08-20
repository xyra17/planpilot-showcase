# Canary Strategy

阶段固定为 `internal → 1% → 5% → 20% → 50% → 100%`。

- `internal` 只对 `is_admin=true` 的内部用户分配。
- 百分比阶段使用现有 HMAC 稳定分桶；百分比表示进入实验的用户流量，实验内保留 control/candidate 固定分组。
- 已分组用户不会因阶段变更被重分组。

## 升阶条件

1. 离线门禁仍为 `passed`。
2. 当前阶段达到最小暴露数。
3. error rate ≤ 5%，fallback rate ≤ 20%，p95 latency ≤ 60s。
4. 无未处理 critical safety incident。
5. 接受率和完成率 uplift 作为质量信号；小样本不得自动得出负向结论。

critical safety incident 或 error rate > 10% 触发暂停。手动回滚会终止 Canary，保留暴露和 append-only transition，并调用现有 deployment rollback 创建新 revision。
