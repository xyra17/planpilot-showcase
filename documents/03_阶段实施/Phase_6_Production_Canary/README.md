# Phase 6：Production Hardening & Canary Release

Phase 6 不扩展新的 Agent 产品能力，而是把 Phase 5 的版本、评估、实验、监控和回滚能力组合成可审计的生产发布流程。

## 范围

- 生产离线评估门禁，覆盖不少于 100 个固定案例。
- Coach Canary 阶段：内部流量、1%、5%、20%、50%、100%。
- Model Gateway：超时、有界重试、熔断、模型回退和延迟追踪。
- 预测结果、真实结果和校准指标持久化。
- 中文 Production Canary Dashboard 和受控回滚入口。

## 不变约束

Agent 仍然只能生成 Proposal；业务数据只能通过 User Review 和 Apply Gateway 修改。Canary 不改写历史版本和用户分组，回滚会创建新 deployment revision。

## 文档

- [Offline Evaluation Gate](./Offline_Gate.md)
- [Canary Strategy](./Canary_Strategy.md)
- [Production Metrics](./Production_Metrics.md)
- [Model Gateway Design](./Model_Gateway_Design.md)
- [Real Data Calibration](./Real_Data_Calibration.md)
- [Dependency Audit](./Dependency_Audit.md)
- [Completion Report](./Phase_6_Completion_Report.md)
