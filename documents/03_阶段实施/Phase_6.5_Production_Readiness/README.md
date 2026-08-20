# Phase 6.5 Production Readiness Audit

Phase 6.5 不新增 Agent 能力，而是验证现有系统能否在多 Worker、多时区和真实 Canary 数据下稳定运营。

## 范围

- Redis 分布式 Model Gateway 熔断、单一半开探测与 Celery 持久 async runtime。
- 用户 IANA 时区，事件继续以 UTC 存储，展示和行为分析按用户时区计算。
- Canary 真实暴露、即时决策、延迟结果的可归因事实链。
- Agent Trace：Context、Model、Tool、Proposal、User Action 的层级追踪。
- 生产依赖与开发工具依赖的风险审计。

## 文档导航

- [Distributed Runtime](./Distributed_Runtime.md)
- [Timezone Design](./Timezone_Design.md)
- [Canary Observation Pipeline](./Canary_Observation_Pipeline.md)
- [Agent Tracing](./Agent_Tracing.md)
- [Dependency Audit](./Dependency_Audit.md)
- [Production Readiness Report](./Production_Readiness_Report.md)

## 兼容性边界

业务数据库时间列暂不破坏性迁移为 `timestamptz`；Agent 仍只能创建 Proposal；Experiment、Deployment 和 Rollback 继续复用 Phase 5/6 的权威实现。
