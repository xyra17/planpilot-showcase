# Phase 5 Implementation Report

日期：2026-07-30  
迁移 head：`z9a0b1c2d3e4`

## 1. 数据库

新增 `users.is_admin`，并新增 16 张控制、评估与观测表：

- `prompt_versions`、`model_configs`、`agent_policy_versions`、`agent_deployments`
- `agent_invocations`
- `evaluation_datasets`、`evaluation_cases`、`evaluation_runs`、`evaluation_results`
- `experiments`、`experiment_variants`、`experiment_assignments`、`experiment_exposures`
- `agent_feedback_events`、`agent_metrics_daily`、`agent_incidents`

所有 Phase 5 时间字段遵守 naive UTC 数据库存储契约。版本、实验和 Invocation 之间使用外键；active deployment 使用部分唯一索引保证单环境单活。

## 2. Agent Runtime

`ProposalService.generate_proposal()` 现在在调用 Coach 前解析运行配置：

1. 确保已批准的兼容基线存在。
2. 读取当前环境的 active deployment。
3. 判断有效实验并通过 HMAC 对用户稳定分组。
4. 校验 Prompt、Model、Policy 均为 approved。
5. 强制 Policy 的 `require_user_confirmation=true` 与 proposal type 白名单。
6. 使用解析后的模板和模型参数调用 Coach。
7. 在同一事务写入 Invocation、Exposure、Proposal 和 LearningEvent。

LLM 失败或功能关闭时，deterministic fallback 仍记录版本、错误类别、延迟和 trace ID。

## 3. Evaluation 2.0

Phase 4 的 20-case benchmark 被导入 frozen dataset。每次 Run 固定 Dataset、Prompt、Model、Policy 和 evaluator 版本，逐 Case 保存实际结果、安全发现和延迟。

聚合指标包括：

- overall pass rate
- recommendation accuracy
- macro precision / macro recall
- per proposal type precision / recall
- planning quality
- safety pass rate
- category score

安全检查保持 deterministic；不会用 LLM judge 决定越权或业务归属。

## 4. Experiment 与 Feedback

- 实验状态机：`draft → approved → running ↔ paused → completed/cancelled`。
- 同一环境、同一 Agent 只允许一个 running 实验。
- Assignment 与实际 Exposure 分离，并对用户稳定。
- 结果按 Variant 统计 assignment、exposure、accept rate、helpful rate 和样本充足性。
- Feedback normalizer 将 Proposal 事件幂等映射为 append-only 信号。
- Delayed outcome task 在 Apply 后 7 日计算受影响任务完成率，保留 attribution window 与 metric version。

## 5. Monitoring 与 Rollback

日聚合同时保存全局维度和 Prompt/Model/Policy/Experiment/Variant 组合维度：

- invocation、success、fallback
- latency、token
- proposal、accept、apply、helpful
- completion after advice
- context novelty

Monitoring API 区分 data、concept、operational drift。严重运行失败生成 Incident；管理员回滚会创建新的 active revision，并保留目标版本和原 deployment 历史。

## 6. API 与权限

统一命名空间：`/api/v1/agent-control`。

普通用户可读取：自己的 Runtime 摘要、Invocation、反馈历史，以及不含敏感信息的评估/实验/监控摘要。

管理员可执行：创建/批准版本、发布、回滚、运行评估、创建/变更实验、触发指标聚合。管理员能力由数据库 `users.is_admin` 控制，默认新用户为 false。

## 7. 测试证据

- 后端确定性测试：`253 passed`。
- PostgreSQL 集成测试：`74 passed, 6 skipped`；跳过项均为明确依赖外部 LLM 的旧集成场景。
- Phase 5 专项测试覆盖管理员边界、20-case 评估、稳定实验分组、Exposure、Feedback 幂等、日指标和回滚。
- PostgreSQL 已执行 `alembic upgrade head`。
- `alembic check`：No new upgrade operations detected。
- Ruff：通过；Python compileall：通过。
- 前端 lint 与 production build 通过；页面路由 `/dashboard/agent-operations` 已进入 production bundle。
- Production dependency audit：`0 vulnerabilities`；完整 audit 仍为 13 个已记录的开发工具链 high 风险，按 Phase 4.5 决策不做破坏性大版本升级。
- Playwright/Chrome 真实闭环：普通用户与管理员场景均通过；覆盖注册、Goal、Task、Checkin、Pattern、Profile、Coach、Proposal 接受/应用/反馈、智能运营调用追踪，以及管理员版本/发布视图。
- Celery Worker 已确认注册 Phase 5 三个任务，反馈标准化与日指标任务已在真实容器内执行成功。

一次包含真实外部 LLM 的全量尝试在 DeepSeek 响应后解析阶段发生 120 秒超时；该外部可用性事件与上述确定性发布门禁分开记录，未被伪装为代码测试通过。
