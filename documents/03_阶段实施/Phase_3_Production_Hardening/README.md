# Phase 3：Productization & Production Hardening

本目录记录 Phase 3 的重要实现、运行方式和验证证据。代码与迁移是事实来源，本文档用于交接和生产运维。

## 已完成范围

- Phase 3-1：真实 PostgreSQL migration 与 Chrome 端到端闭环
- Phase 3-2：LearningEvent 消费、Pattern decay、Profile batch 的 Celery Beat 调度
- Phase 3-3：DecisionContext → CoachAgent → LLM → DecisionProposal
- Phase 3-4：Dashboard 今日 AI 洞察、Coach 对话式建议卡及调整交互
- Phase 3-5：Coach Agent guardrail evaluation
- Phase 3-6：生产 Compose、non-root image、readiness、结构化日志、Sentry 与 Agent trace

## 前端供应链基线

- Next.js：`15.5.21`（Maintenance LTS）
- React：18
- production dependency audit：`0 vulnerabilities`
- production Docker image：以 `node` 用户运行，真实容器 smoke test 返回 HTTP 200

Next.js 构建依赖中的 PostCSS 与 Sharp 通过 package override 固定到已修复版本；当前剩余 npm audit 项均来自不会进入 standalone runtime 的旧 ESLint 开发工具链。

## 核心闭环

```text
User Behavior
  -> LearningEvent
  -> Pattern Analyzer (Celery)
  -> LearnerPattern
  -> Profile Builder (Celery)
  -> LearnerProfile
  -> DecisionContext
  -> CoachAgent + LLM
  -> DecisionProposal
  -> User Accept / Adjust / Reject
  -> Apply Gateway
  -> ProposalFeedback
  -> Pattern confidence calibration
```

## 数据库版本

当前 Alembic head：`v5w6x7y8z9a0`。

Phase 3 migration 为 `backend/alembic/versions/v5w6x7y8z9a0_add_proposal_agent_trace.py`，为 Proposal 增加：

- `source`
- `model_name`
- `agent_trace`

## 文档索引

- `E2E_Verification_Report.md`：真实浏览器闭环和已发现问题
- `Scheduling_and_Operations.md`：Celery、迁移、健康检查、部署
- `Agent_Runtime_and_Evaluation.md`：Coach Agent、安全边界、评估集
