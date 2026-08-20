# Phase 3-1 真实端到端验证报告

验证日期：2026-07-30（Asia/Shanghai）

## 环境

- PostgreSQL 16 + pgvector：Docker，真实持久化卷
- Redis 7：Docker
- API / Celery worker / Celery beat：Docker，挂载当前工作区
- Frontend：Next.js 15.5.21 production build
- Browser：Google Chrome，由 Playwright 驱动
- LLM：真实 OpenAI-compatible runtime；Proposal trace 记录实际模型和耗时

## Migration

执行：

```bash
alembic upgrade head
```

数据库从 `q1r2s3t4u5v6` 升级到 `v5w6x7y8z9a0`。已确认以下表真实存在：

- `learning_events`
- `learner_profiles`
- `learner_patterns`
- `pattern_evidences`
- `decision_proposals`
- `proposal_feedback`

## 浏览器验证链路

自动化用例：`frontend/e2e/learner-loop.spec.ts`

已验证：

1. UI 注册用户
2. UI 创建 Goal
3. UI 创建并完成 8 个 Task
4. UI 提交 Checkin
5. worker 消费 LearningEvent
6. Pattern 从 candidate 转为 active
7. worker 生成 user / goal LearnerProfile
8. Dashboard 显示今日 AI 洞察
9. Coach 显示 Profile、Active Pattern 和证据来源
10. 真实 LLM 生成 Proposal
11. 用户 Accept
12. Apply Gateway 执行
13. 用户提交 helpful Feedback
14. 断言关联 Pattern confidence 上升
15. 再生成 Proposal 并验证 Reject

Next.js 15.5.21 升级后的最终回归结果：`1 passed (24.3s)`。

运行命令：

```bash
cd frontend
PLANPILOT_E2E=1 npm run test:e2e
```

## 浏览器联调发现并修复的问题

### 前后端日期跨天不一致

症状：前端 Asia/Shanghai 已进入 7 月 30 日，UTC 容器仍为 7 月 29 日；Dashboard 的今日任务在 Checkin API 中显示为 0 条。

修复：开发与生产 Compose 的 API、worker、beat、frontend 统一设置 `TZ=Asia/Shanghai`。该问题无法通过单纯 API 单测稳定发现。

### LangGraph checkpointer 静默降级

症状：`CREATE INDEX CONCURRENTLY cannot run inside a transaction block`，启动时降级到 MemorySaver。

修复：psycopg async pool 设置 `autocommit=True`、`prepare_threshold=0`、`row_factory=dict_row`。真实启动日志已确认 `Agent initialized with AsyncPostgresSaver`。

### E2E 等待真实 LLM

真实模型延迟可能高于 15 秒。Playwright 对 Proposal 出现使用 60 秒的局部等待，但全用例仍有 180 秒硬超时，避免无限挂起。

### 每日计划弹窗干扰复用账号

症状：由于注册接口存在合理的限流，重复回归会复用已存在的 E2E 账号；该账号的每日计划 Agent 请求较长时间未完成，弹窗覆盖 Dashboard 任务控件。

修复：用例在页面初始化时写入产品已有的 `lastPlanDate` 标记，使本场景只验证学习闭环。每日计划能力保留其独立产品行为，不再污染该闭环用例。

### Goal 选择与重复任务定位

复用账号拥有多个 Goal。用例现在明确选择本次创建的 Goal，并用唯一任务标题和任务行作用域定位按钮，避免任务写入历史 Goal 或严格定位冲突。
