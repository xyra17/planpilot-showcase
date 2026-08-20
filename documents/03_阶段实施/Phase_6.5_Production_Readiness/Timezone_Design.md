# Timezone / Timestamp Migration Design

## 当前决策

本阶段不修改历史 `TIMESTAMP WITHOUT TIME ZONE` 列，避免一次高风险全库转换。数据库继续保存 naive UTC；应用计算先恢复为 aware UTC，再转换到用户 IANA 时区。

```text
event_time: UTC
storage: naive UTC（兼容现状）
display_time: users.timezone
behavior analysis: users.timezone
```

`users.timezone` 默认 `Asia/Shanghai`，API 使用 Python `zoneinfo` 校验。前端设置页提供上海、东京、纽约、伦敦和 UTC，并允许后续扩展完整 IANA 列表。

## 已接入链路

- Learning Event 在 Decision Context 中同时返回 UTC 和本地时间。
- preferred learning hour / weekday 按用户时区计算。
- Habit H-1 的证据和 pattern value 记录计算时区。
- Weekly frequency H-4 的日期与星期按用户时区生成。
- Profile Builder 显式读取用户时区；底层独立工具函数保留 UTC 默认值以兼容旧调用。

旧版 `preferred_learning_time` 没有时区标签，不能安全解释为用户本地时间。Decision Context 会暂时排除这类旧 Pattern，Profile 使用原始 Event 按当前用户时区重算 fallback；新证据进入后，聚合器只使用同一时区的 evidence 并写入 `pattern_value.timezone`，避免跨时区样本混合。

## 后续迁移门槛

迁移 `timestamptz` 前必须完成列清单、历史数据抽样、双读比对、可回滚备份和停写窗口评审。不得把 naive 历史值直接交给 PostgreSQL 按服务器本地时区解释。
