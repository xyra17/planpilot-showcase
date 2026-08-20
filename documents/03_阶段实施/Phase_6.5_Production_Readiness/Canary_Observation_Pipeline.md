# Real Canary Observation Pipeline

## 目标

将真实生产行为从运行日志升级为可重复聚合、可归因、不可重复写入的事实：

```text
Experiment Exposure
  → Agent Invocation / Proposal
  → Accept / Reject / Apply
  → 7-day Outcome
  → Canary Observation / Calibration
```

## 数据结构

`canary_observations` 记录 release、experiment、variant、user、invocation、proposal、observation type、metric、value、attribution window 和 occurred time。`dedupe_key` 唯一，允许后台任务安全重跑。

三类事实：

- `exposure`：调用成功、fallback、latency、token 和 cost。
- `decision`：接受、拒绝、应用、调整和反馈。
- `outcome`：7 天完成率等延迟结果。

## 运营指标

Canary Dashboard 展示真实暴露/决策/结果数量和结果覆盖率，并继续使用 Phase 6 的 acceptance、completion uplift、error、latency、cost 与 safety guardrail。Observation 只建立可审计的关联，不把相关性宣称为因果。

后台每 5 分钟归一化一次；管理员也可调用幂等 normalize API 做运行验证。
