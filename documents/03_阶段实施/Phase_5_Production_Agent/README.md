# Phase 5：Production-grade Learning Agent

状态：已实现并进入验证阶段  
日期：2026-07-30

## 交付范围

Phase 5 把 PlanPilot 的学习伙伴从“能生成可解释建议”升级为一套可版本化、可评估、可实验、可监控、可回滚的持续学习系统，同时保留原有安全边界：Agent 只能创建 Proposal，业务数据仍由用户确认后的 Apply Gateway 修改。

| 阶段 | 已交付能力 |
|---|---|
| 5-1 | Prompt、模型参数、安全策略的不可变版本；环境 Deployment；每次 Coach 调用事实与 Context Hash |
| 5-2 | 版本化 Evaluation Dataset/Case/Run/Result；20 个固定案例；准确率、Precision、Recall、规划质量和安全门禁 |
| 5-3 | 固定流量 A/B 实验；HMAC 稳定分组；Assignment 与 Exposure 分离；变体结果统计 |
| 5-4 | Proposal 行为标准化为 append-only Feedback Event；即时反馈与 7 日延迟结果分离；幂等重放 |
| 5-5 | 每日全局及版本维度指标；成功率、回退率、延迟、Token、接受/应用/有效率；Data/Concept/Operational Drift 摘要 |
| 5-6 | 管理员权限、Policy 强制确认、受控 Deployment、Incident 与手动回滚审计 |

## 实际代码入口

```text
backend/src/api/agent_control.py
backend/src/services/agent_control_service.py
backend/src/services/evaluation_v2_service.py
backend/src/services/experiment_service.py
backend/src/services/feedback_learning_service.py
backend/src/services/monitoring_service.py
backend/src/tasks/phase5_tasks.py
frontend/lib/agent-control-api.ts
frontend/app/(dashboard)/dashboard/agent-operations/page.tsx
```

数据库迁移：`z9a0b1c2d3e4_phase5_production_agent.py`。

## 运行链路

```text
DecisionContext
  → Runtime Resolver
  → Deployment / Experiment Variant
  → Prompt + Model Config + Policy
  → CoachAgent
  → AgentInvocation
  → DecisionProposal
  → User Review / Apply
  → LearningEvent
  → AgentFeedbackEvent
  → Daily Metrics / Evaluation / Experiment Result
  → Candidate Version / Controlled Deployment / Rollback
```

## 前端

- 新增中文“智能运营”页面。
- Coach 建议卡展示 Prompt 版本、Deployment 修订、实验变体和安全回退状态。
- 普通用户只读取自己的调用记录和安全摘要；管理员可查看版本/发布历史、触发离线评估与指标聚合，并从历史修订执行受控回滚。
- Prompt 正文、内部策略详情、Provider 凭据和其他用户上下文不会返回普通用户页面。

## 运维约定

- Celery Beat 每 5 分钟标准化即时反馈。
- 每日计算 7 日延迟效果并聚合 Agent 指标。
- Experiment 只允许引用已批准版本；同一 Agent/环境同时只允许一个运行中的互斥实验。
- 生产版本切换和回滚只允许管理员执行，并生成新的 Deployment revision，不改写历史 Invocation。

## 已知边界

- 当前在线实验是固定流量 A/B，不实现 Bandit 或自动流量优化。
- Drift 使用透明的统计阈值和 Context novelty proxy；需要真实线上样本后再校准阈值。
- 质量下降默认告警并人工回滚；只有未来明确批准的硬安全规则才适合自动回滚。
- Token 成本字段已预留，当前 Provider 未返回可靠价格快照时不估算金额。
