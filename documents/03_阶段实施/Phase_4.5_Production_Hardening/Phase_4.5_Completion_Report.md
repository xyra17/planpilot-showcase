# Phase 4.5 Production Hardening Completion Report

完成日期：2026-07-30

## Phase 4.5-1 Dependency Hardening

- `npm audit --omit=dev`：0 vulnerabilities。
- 完整 audit：13 high、0 critical，均位于 ESLint/Next build 开发工具链。
- 决策：延期到独立 Next/ESLint 主版本兼容升级，不使用 override 强行清零。
- 生产 multi-stage/standalone runtime 不包含受影响开发依赖。

## Phase 4.5-2 Time Standardization

- 新增 `backend/src/core/time.py::utc_now()`。
- Event、Pattern、Profile、Cognitive、Memory、Knowledge、Proposal、Task 与 Agent Runtime 全部改用统一时钟。
- Pydantic default factory 与测试 fixture 同步替换。
- `backend/src/` 和 `backend/tests/` 中 `datetime.utcnow` / 私有 `utcnow` 搜索结果为 0。
- 保持现有 `TIMESTAMP WITHOUT TIME ZONE` 和 naive UTC 兼容契约，不需要时间数据转换。

## Phase 4.5-3 Database Hygiene

- Alembic 将 `checkpoint_migrations`、`checkpoints`、`checkpoint_writes`、`checkpoint_blobs` 标记为 LangGraph 外部管理表。
- 模型补齐历史索引与唯一约束声明，没有删除现有保护。
- 新增手写 migration `y8z9a0b1c2d3_reconcile_business_nullability.py`，回填并收紧业务 NOT NULL 列。
- 真实 PostgreSQL：`y8z9a0b1c2d3 (head)`。
- `alembic check`：`No new upgrade operations detected.`
- 未移动、删除或重建任何 LangGraph checkpoint 数据；未来 `agent_runtime` schema 迁移方案已记录。

## Phase 4.5-4 Intelligence Calibration

- 固化 Failure Prediction、Retention、Cognitive Confidence 和 Knowledge Gap 公式。
- 定义 Brier Score、ECE、PR-AUC、Precision@K、accept/apply/helpful rate 等校准指标。
- 定义 ML promotion gate：时间切分、segment 指标、fallback、shadow、A/B 和版本回滚。
- 当前保持 heuristic baseline，不在无标签和无 ground truth 条件下训练 ML。

## Changed Files

主要新增：

- `backend/src/core/time.py`
- `backend/tests/test_time.py`
- `backend/alembic/versions/y8z9a0b1c2d3_reconcile_business_nullability.py`
- `documents/03_阶段实施/Phase_4.5_Production_Hardening/*`

主要修改：

- `backend/alembic/env.py`
- `backend/src/models.py`
- `backend/src/events/publisher.py`
- `backend/src/intelligence/*`
- `backend/src/services/proposal_service.py`
- `backend/src/core/agent_v2/{schemas,transitions,orchestrator}.py`
- `backend/src/tasks/{agent_runs,pattern_tasks}.py`
- 相关时间与 Agent 测试。

## Validation

- `ruff check .`：通过。
- `SMART_API_KEY=test pytest tests/ -q`：321 passed，6 skipped，0 warnings。
- 6 个 skip 为显式关闭外部 LLM 后的非确定性集成测试。
- `alembic upgrade head`：通过。
- `alembic check`：通过。
- `npm run lint`：通过，无 error，保留既有 warning。
- `npx tsc --noEmit`：通过。
- `npm run build`：通过，19 个路由。
- `npm audit --omit=dev`：0 vulnerabilities。
- 真实 Chrome 全新注册学习闭环：1 passed（25.9s）。

## Remaining Risks

1. 13 个开发工具依赖漏洞仍需 Next/ESLint 主版本专项升级。
2. LangGraph 表仍在 `public` schema；ownership 已隔离，物理迁移需维护窗口和回滚方案。
3. 预测模型仍是 heuristic，需要 Phase 5 先积累可靠 feature/label，再进行在线校准。
4. 前端存在既有 lint warning，但当前无 lint error 或构建错误。

## Next Step

可以进入 Phase 5 Online Learning。Phase 5 首先应实现 feature/label versioning、Prompt/Model version tracking、shadow evaluation 与安全 A/B，不应直接启用在线权重更新。
