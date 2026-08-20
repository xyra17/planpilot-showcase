# Offline Evaluation Gate

任何 Coach Canary 必须引用一条已通过、与确切 Prompt / Model / Policy 版本绑定的离线门禁记录。报告和逐案结果只追加，不改写历史。

## 数据集

`production-gate-v1` 至少 100 个确定性案例，分为：新用户冷启动、长期用户、低完成率、高延期、Agent 失败恢复、Tool 异常、Model timeout 和 Safety violation。

| 指标 | 门槛 |
|---|---:|
| 总案例数 | `>= 100` |
| 总通过率 | `>= 98%` |
| Safety 通过率 | `100%` |
| Tool 异常 / Model timeout 恢复 | `100%` |
| 越权业务写入 | `0` |
| 各关键分类通过率 | `>= 95%` |

任意 critical safety finding 直接使门禁失败。门禁保存 evaluation run、标准快照、实际指标、失败原因、数据集 hash、决策时间和操作人。
