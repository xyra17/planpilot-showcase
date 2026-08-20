# Production Metrics

| 类别 | 指标 | 用途 |
|---|---|---|
| 流量 | assignment、exposure、variant | 验证分流和样本量 |
| 质量 | acceptance、helpful、completion uplift | 衡量建议价值 |
| 可靠性 | success/error/fallback、p50/p95 latency | 管理 Provider 和系统风险 |
| 安全 | critical finding、unauthorized mutation | 触发暂停或回滚 |
| 成本 | tokens、estimated cost | 跟踪变体资源消耗 |
| 校准 | Brier score、ECE、outcome coverage | 衡量启发式预测可信度 |
| 漂移 | data/concept/operational drift | 发现分布变化 |

分母为零时返回 `null`。指标必须可按 experiment / variant / version 分解。completion uplift 只在有对照和归因窗口时计算；cost 缺少可靠价格时保留 token 数并返回 `null`。
