# Phase 4.5 Alembic Metadata Audit

审计日期：2026-07-30

## Initial result

初始 `alembic check` 失败，差异分成三类。

| 表或对象 | 来源 | 处理决策 | 是否需要业务迁移 |
|---|---|---|---|
| `checkpoints` | LangGraph runtime | 外部管理，从业务 autogenerate 排除 | 否 |
| `checkpoint_writes` | LangGraph runtime | 外部管理，从业务 autogenerate 排除 | 否 |
| `checkpoint_blobs` | LangGraph runtime | 外部管理，从业务 autogenerate 排除 | 否 |
| `checkpoint_migrations` | LangGraph runtime | 外部管理，从业务 autogenerate 排除 | 否 |
| `learning_events` 单列 event type index | 历史 migration 已存在、模型漏声明 | 在模型中声明并保留索引 | 否 |
| `pattern_evidences` evidence 唯一约束 | 历史 migration 已存在、模型漏声明 | 在模型中声明并保留约束 | 否 |
| `proposal_feedback` proposal 唯一约束 | 模型 unique index 与现库 unique constraint 表达不同 | 模型对齐现有约束和普通查询索引 | 否 |
| 业务时间列 `created_at` / `updated_at` | 模型非空、早期 migration 可空 | 回填 NULL 后设为 NOT NULL | 是 |
| `goals.work_schedule` | 模型非空、早期 migration 可空 | 回填 `all` 后设为 NOT NULL | 是 |
| `plans.created_by` | 模型非空、早期 migration 可空 | 回填 `ai` 后设为 NOT NULL | 是 |

## Applied remediation

- `alembic/env.py` 新增 `EXTERNALLY_MANAGED_TABLES` 和 `include_object`，业务 Alembic 不再尝试删除 LangGraph 表。
- 手写 migration `y8z9a0b1c2d3_reconcile_business_nullability.py`，仅处理已审计业务列；未使用 autogenerate 直接产出 migration。
- migration 在设置 NOT NULL 前先执行保守回填，可回滚 nullability，不删除任何业务数据。
- 最终 `alembic check`：`No new upgrade operations detected.`

## LangGraph schema isolation plan

当前 checkpoint 表仍位于 `public`，只改变 Alembic ownership 识别，不移动现有数据。移动 schema 会影响正在运行的 Agent checkpoint，属于需单独维护窗口的架构变更。

建议后续迁移到：

```text
public          -> PlanPilot business schema
agent_runtime   -> LangGraph-owned checkpoint schema
```

安全迁移顺序：

1. 确认当前 LangGraph/Postgres saver 版本支持独立 schema 或专用连接 `search_path`。
2. 创建 `agent_runtime` schema，由 runtime initializer 创建其版本对应的表。
3. 暂停新 Agent run，等待或终止在途 run，避免复制半完成 checkpoint。
4. 切换 Agent runtime 专用连接并运行恢复、幂等和 worker fault 测试。
5. 旧 `public.checkpoint_*` 先只读保留一个回滚周期，再另行审批归档。

禁止由业务 Alembic 重建、重命名或删除 LangGraph checkpoint 表。
