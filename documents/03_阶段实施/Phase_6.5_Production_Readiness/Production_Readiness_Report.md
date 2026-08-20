# Phase 6.5 Production Readiness Report

完成日期：2026-07-30。状态：已完成并通过真实 PostgreSQL、Redis、Docker 与 Chrome 验证。

## 已实现

- Redis 共享 Model Gateway circuit state、distributed lock、单一 half-open probe 和本地应急模式。
- Celery 每 worker 持久 event loop，消除 asyncpg/Redis 跨 loop 连接复用错误。
- `users.timezone`、IANA 校验、中文设置界面、Pattern/Profile/Context 本地时间语义。
- Canary exposure/decision/outcome 事实表、幂等归一化任务和运营摘要。
- Agent Trace span 表、Runtime 写入、用户行为追加、按所有权读取和中文时间线。
- 向后兼容的 Alembic migration `b1c2d3e4f5g6`。

## 安全与兼容

- Agent 仍通过 Proposal → User Review → Apply Gateway，Trace 和 Observation 不写业务实体。
- Redis 故障降级不暴露 prompt/context；route key 使用摘要。
- 未进行 `timestamptz` 破坏性迁移，未升级 Next/ESLint 主版本，未调整 heuristic 阈值。

## 数据库与 API

Migration `b1c2d3e4f5g6_phase65_readiness.py`：

- `users.timezone`
- `agent_trace_spans`
- `canary_observations`

新增 API：

- `GET /api/v1/agent-control/traces/{trace_id}`
- `GET /api/v1/agent-control/gateway/circuits`（管理员）
- `POST /api/v1/agent-control/canary/observations/normalize`（管理员）
- `PATCH /api/v1/auth/me` 新增 `timezone`

## 前端

- 设置页新增中文“学习时区”选择并持久化；Agent Workbench 和智能运营时间按该时区显示。
- 智能运营新增 Redis 分布式 Gateway 状态、真实 Canary 观测计数。
- 最近 Agent 调用可展开中文 Trace 时间线，展示上下文、模型、工具、Proposal 和用户动作。

## 最终验证

- [x] 两 Worker 共享熔断与单一 half-open probe 自动测试
- [x] Failure injection 与 fallback 测试
- [x] 时区 API、非法时区和跨日期换算测试
- [x] Trace 层级与 Canary Observation 幂等测试
- [x] Backend：`261 passed`；Ruff、compileall passed
- [x] PostgreSQL integration：`74 passed, 6 skipped`（无外部 LLM 密钥）
- [x] PostgreSQL：upgrade/current/check passed，head `b1c2d3e4f5g6`，无 metadata drift
- [x] Frontend：lint passed（仅历史 warning），production build passed
- [x] Dependency：production `0 vulnerabilities`；full audit `13 high` dev-only
- [x] Chrome 普通用户：时区、Goal/Task/Checkin、Pattern/Profile、Coach、Accept/Apply/Feedback、Trace passed
- [x] Chrome 管理员：Offline Gate、Redis Gateway、Canary 创建与 Rollback passed
- [x] Docker API/Worker/Beat 重建并健康；Canary observation task 已注册
- [x] 同一 ForkPoolWorker 连续执行 6 次 recovery + 4 次 Canary normalization，全部成功且日志无跨 loop 错误
- [x] 真实 Redis 跨容器 failure injection：Worker 写入 open，API 读取并拒绝，清理后 Worker 读取 closed

## 剩余风险

1. Redis 本身仍是共享熔断的基础设施依赖；当前 Redis 不可用时会退回进程内保护，需要生产 Redis HA、告警和持久化策略。
2. 历史数据库仍是 naive UTC；`timestamptz` 迁移必须走独立的数据审计与双读方案。
3. 当前真实环境已有 Trace 和用户时区数据，但没有处于运行阶段且产生 Agent exposure 的 Canary，因此 Observation 表的真实 outcome 覆盖率仍需下一次内部 Canary 积累。
4. 13 个开发依赖告警暂缓；升级应在独立变更窗口进行，不与 Agent 策略发布捆绑。
5. Trace 数据库是当前审计事实源，尚未导出到 OpenTelemetry collector；高并发生产环境需增加采样和 retention policy。

## 结论

Phase 6 遗留的进程内熔断、多时区语义、Canary 真实归因和 Agent 可调试性均已形成可运行闭环。PlanPilot 已从“测试环境生产级”推进到可进行真实内部 Canary 运营的状态；下一步应积累观测数据和 SLO，不应继续扩展新 Agent 功能。
