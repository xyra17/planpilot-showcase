# Phase 4.5 Time Standardization

## Storage contract

当前 SQLAlchemy 模型和 PostgreSQL 使用无时区 `DateTime` / `TIMESTAMP WITHOUT TIME ZONE`。统一约定：

```text
Clock calculation: timezone-aware UTC
Application value: naive UTC
Database storage: naive UTC
API serialization: existing ISO contract
```

`backend/src/core/time.py` 提供唯一入口：

```python
def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)
```

先以 aware UTC 获取正确时钟，再仅在现有数据库边界移除 tzinfo，避免本地时区误写，同时保持全部历史比较和字段类型兼容。

## Migration scope

已替换所有自有 `backend/src/` 调用，包括：

1. Learning Event publisher
2. Pattern update、feedback、decay 与 cursor
3. Learner Profile、Cognitive Profile 与 Memory
4. Knowledge Graph 与 Adaptive Planner
5. Proposal 生命周期
6. Agent v2 transition、orchestrator、lease recovery
7. 相关测试 fixture

禁止重新引入 `datetime.utcnow()` 或模块私有 `utcnow()` helper。新增代码必须导入 `src.core.time.utc_now`。

## Future migration

如果数据库未来切换为 `TIMESTAMP WITH TIME ZONE`：

1. 新增独立数据迁移并声明历史值全部为 UTC。
2. 将 helper 改为直接返回 aware UTC，不再移除 tzinfo。
3. 同步 API 时区后缀和前端解析测试。

不能只修改 Python helper 而不迁移数据库列类型。
