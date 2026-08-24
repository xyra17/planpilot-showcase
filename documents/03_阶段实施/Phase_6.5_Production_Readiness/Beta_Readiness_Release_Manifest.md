# Beta Readiness Calibration — Release Manifest

生成时间：2026-08-23（Asia/Shanghai）

## 发布结论边界

- 本清单冻结的是“正式开放内部 Beta 前的校准基线”，不是 Beta 效果结论。
- Beta 保持 `disabled / allowlist / 0%`，未自动加入任何用户。
- 工作区仍为脏状态，未获得授权，因此没有 commit、tag 或远端发布操作。

## 代码与数据基线

| 项目 | 值 |
| --- | --- |
| Git HEAD | `b34820f25e141eb64c83a68a4cdfb925d9f434da` |
| Migration head | `f9g0h1i2j3k4` |
| Funnel metric | `action-beta-funnel-v2`（v1 只读） |
| Safety metric | `action-beta-safety-v2` |
| Runtime Gate | `947d93c1-83d5-43f5-9586-9727c1a64246` |
| Gate status / safety | `passed / 1.0` |
| Runtime dataset hash | `02358bd2340693c296c21fed1879e4555280ec5b22b102bc416162adc17a02de` |
| Deployment revision | `24` |
| Runtime code digest | `75808102e3f7a4b3e2d75764e80e4a8d78f8100d9c8e29a72577392fe5e6063c` |
| Gate expires | `2026-08-24T05:00:03.624964Z` |
| Safety state at freeze | `observed_clear`；四项均为 0 |

## 容器镜像摘要

| 服务 | 摘要 |
| --- | --- |
| API | `sha256:7b65bced9fdf9823d102835b0931ffff4f4b839366df7f7758989033ca3432e2` |
| Worker | `sha256:f95b535737682ab8d96c6ea73665b0dd8536e39519d27e8e31d8375d6f16ecc3` |
| Beat | `sha256:cb4412d525d4adb7e47a069e01879c526148424cf114363820a7d9062990be29` |
| Frontend | `sha256:0cf58223016b2f4f257ccf6bcc0eb2c74e93f3e4c745a9669b3aec274e023bd8` |
| Migrate | `sha256:262e833abc9979f8892f6260bb60a181f71c36e8411c66efafcfff0b208266e8` |

## 变更分类与提交分组建议

### A. Beta Readiness Calibration（本阶段）

- 漏斗、Gate、安全扫描和候选样本：`backend/src/services/beta_evidence_service.py`
- 控制 API、Action 来源归因、部署门禁：`backend/src/api/agent_control.py`、`backend/src/api/agent_v2.py`、`backend/src/core/agent_v2/orchestrator.py`、`backend/src/services/evaluation_v2_service.py`、`backend/src/services/proposal_service.py`
- 配置、模型、迁移：`backend/src/config.py`、`backend/src/models.py`、`backend/alembic/versions/f9g0h1i2j3k4_beta_readiness_calibration.py`
- 自动任务：`backend/src/tasks/beta_readiness_tasks.py`、`backend/src/celery_app.py`
- 可重复运行脚本：`backend/scripts/run_beta_runtime_gate.py`、`backend/scripts/run_beta_safety_scan.py`
- 专项测试：`backend/tests/test_beta_evidence_foundation.py`、`backend/tests/integration/test_15_agent_v25_runtime_gate.py` 及必要 fixture 校准
- Admin Beta：`frontend/lib/agent-control-api.ts`、`frontend/app/(admin)/admin/_components/AgentOperationsPage.tsx`、`frontend/e2e/beta-evidence.spec.ts`
- 本阶段文档：Agent 统一入口规范、Action Beta Evidence Foundation、本清单

### B. 已独立验收的 V2.5.1 / Beta Foundation

包括 b5～e8 迁移、ActionIntent/dispatch、Runtime Gate 数据集、Review–ChangeSet 绑定、Action E2E、SSE 行动卡等前序成果。建议独立于本阶段提交，以保留迁移和安全内核的审阅边界。

### C. 无关或更早的用户改动

当前约百项 tracked/untracked 变化还包含知识库、隐私、认证、目标页、主题、Pilo 组件、脚本和研究文档等内容。本阶段未 reset、checkout、删除或覆盖这些改动。因多个共享文件含混合 diff，提交时必须使用交互式分块暂存；不能直接 `git add .`。

## 验收结果

- Backend unit：`410 passed`。
- PostgreSQL integration：`92 passed, 6 skipped`，包含真实 20 并发和 soak。
- Runtime Gate：正常 Gate 通过；ownership、unconfirmed、idempotency 三类变异 Gate 失败。
- Frontend：TypeScript、定向 ESLint、production build 通过。
- E2E：三条真实 Action 主链 + Admin Beta 桌面/375px 通过。
- Ruff 全仓通过；`git diff --check` 通过。
- API、Worker、Beat、Frontend、PostgreSQL、Redis 健康；三个 Beta 定时任务已由 Worker 注册并被 Beat 实际调度。

## 回滚顺序

1. 先通过 Admin kill switch 关闭新 Action；确认 Beta 仍 disabled、0%。
2. 使用当前 migrate 镜像执行 `alembic downgrade e8f9g0h1i2j3`。该步骤只移除 v2 measurement activation 列并恢复 v1 指标标识。
3. 恢复上一轮已验收镜像：API `4cae5ebe…`、Worker `0dbcee92…`、Beat `48d84ce6…`、Frontend `2ef5c5f7…`、Migrate `711e6989…`；启动时禁止重新 build。
4. 保持 `new_action_runs_enabled=false`，验证已有 Run 仍可读、审计和撤销。
5. 验证 `/ready`、Worker registered tasks、前端健康和数据库 head；必要时只恢复服务，不恢复业务数据。
6. 重新运行 e8 对应 Runtime Gate 和三条 Action E2E 后，才可人工恢复新 Action。

## Patch / Hash 说明

由于清单文件本身会改变工作区 hash，冻结时应采用以下两个互不循环的摘要：

- tracked patch：对 `git diff --binary` 计算 SHA-256（本清单为 untracked，不进入 tracked patch）；
- untracked inventory：按路径排序，对除本清单外的每个 untracked 文件生成 `文件 SHA-256 + 两个空格 + 路径` 清单，再对该清单计算 SHA-256。

- tracked patch SHA-256：`107f26f83e2e4a90183bac079748de511502c8c1de7f4f3cb42c6068038db689`
- untracked inventory SHA-256（排除本清单）：`57d73b36ae212204cfafd078aec87ae58e44cca792bf2c9ba00704dfebe8a2ef`
- tracked diff 规模：113 files changed；untracked 文件：52（含本清单）

不得把这些 hash 当作 Git tag。
