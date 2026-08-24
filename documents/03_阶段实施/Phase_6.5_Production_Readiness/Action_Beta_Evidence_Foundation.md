# Action Beta Evidence Foundation

## 当前结论

本阶段完成的是 Beta 证据基础设施，不是 Beta 效果验证。系统尚无足够真实 Beta 样本，因此不得声称路由率、执行成功率、学习效果或留存获得提升。

## 控制面

`agent_beta_controls` 是服务端唯一控制边界，默认关闭 Beta、允许稳定的新 Action Run。Cohort 支持白名单和确定性百分比分桶，百分比仅允许 0、5、20、50。`agent_beta_control_events` 追加记录操作者、原因与前后状态。

安全停机只拦截 `create_run`，不修改已有 Run。已有 Run 的列表、详情、审计和 Undo 都不经过新建开关。扩量前必须同时满足：

1. 最近的 `agent-v25-runtime-safety-gate-v1` 为 passed；
2. `critical_safety_pass_rate = 1.0`；
3. 未确认写入、跨用户访问、重复写入、Review 绑定失败均为 0。

## 指标定义

当前指标版本为 `action-beta-funnel-v2`，v1 仅供历史只读查询。默认 measurement window 从 f9 迁移激活时间开始，Admin 默认 `cohort=beta`、`source=conversation`。漏斗事件按用户、session、conversation turn 和 run 真实关联。主要公式：

- 路由率 = 至少创建一个用户 Action Run 的唯一会话数 / 唯一有效 `ConversationTurnReceived`；
- 澄清率 = ClarificationRequested / 收到的会话 turn 数；
- 澄清完成率 = 通过 `continued_from_turn_id` 回连的已完成澄清 / 发起澄清的唯一 turn；
- 预览编辑率 = 发生 `approval.edited` 的数量 / 预览就绪数量；
- 审批率 = approved / (approved + rejected + cancelled)；
- 净执行成功率 = (completed - rolled_back) / approved；
- 撤销率 = rolled_back / completed（completed 口径包含随后撤销的 Run）；
- 学习洞察转化率排除 `GOAL_PLAN_CREATE`、`CHECKIN_RECORD`；
- 样本数小于 30 时标记 `insufficient_data`，Admin 不呈现提升结论。

所有 rate 同时返回 numerator、denominator 和 value；0 分母返回 null。无 `conversation_turn_id` 的历史 Run 进入 `legacy_unattributed`，Insight、Scheduler、API 和 Internal Run 分别进入独立 source funnel。

## 安全状态与 Runtime Gate

空快照为 `unknown`，超过有效期或与当前部署不匹配为 `stale`，真实扫描完成且四项均为 0 才是 `observed_clear`，任一项大于 0 为 `violated` 并自动关闭新 Action。

Runtime Gate 必须在隔离 PostgreSQL 库运行，只将不可变证明导入控制库。证明绑定部署 ID/revision、运行时代码摘要、迁移 head、冻结数据集 hash、开始/决定/过期时间和 evaluator/runtime version。目标环境命令：

```bash
cd backend
PYTHONPATH=. \
BETA_VALIDATION_DATABASE_URL='postgresql+asyncpg://.../planpilot_beta_validation' \
BETA_CONTROL_DATABASE_URL='postgresql+asyncpg://.../planpilot' \
DATABASE_URL='postgresql+asyncpg://.../planpilot' \
python scripts/run_beta_runtime_gate.py

PYTHONPATH=. DATABASE_URL='postgresql+asyncpg://.../planpilot' \
python scripts/run_beta_safety_scan.py
```

证明必须 passed、关键安全 100%、四项 violation 为 0、未过期且全部绑定字段与当前部署一致，否则不能启用 Beta、恢复新 Action 或扩大 cohort。

## 自动任务

Beat/Worker 定时运行真实安全扫描、脱敏复核样本归一化和过期样本清理。扫描失败不会写入 `observed_clear`；提取依靠唯一约束保持幂等；清理数量和控制变化写入 `AgentBetaControlEvent`。

## 真实样本复核

复核样本必须能追溯到持久化事实，使用 90 天默认保留期和 HMAC 伪匿名用户键。默认不复制 `request_text`。状态为 pending、reviewed、confirmed、dismissed。

支持的人工分类包括：错误行动、漏掉行动、核心需求错误、实体错误、不必要/不足澄清、ChangeSet 大幅编辑、快速撤销、Review 假阳性/假阴性、执行失败。只有 confirmed 样本可进入 v1.2 candidate 数据集。冻结 v1/v1.1 数据集及其生产门禁不被修改。

## Admin 运维

`/admin/beta` 提供内部运维视图：控制状态、Runtime Gate、统一漏斗、预览 P50/P95、硬安全计数和脱敏复核队列。接口全部要求 Admin 权限。用户产品不展示实验指标或运维控制。
