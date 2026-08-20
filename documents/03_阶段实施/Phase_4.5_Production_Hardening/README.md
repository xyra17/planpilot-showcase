# Phase 4.5 Production Hardening

Phase 4.5 在进入 Online Learning 前收敛 Phase 4 的依赖、时间、数据库 metadata 和模型校准边界，不改变现有产品架构。

## 完成范围

- Dependency Hardening：区分生产与开发依赖风险，冻结主版本升级决策。
- Time Standardization：所有自有后端代码统一使用 `src.core.time.utc_now()`。
- Database Hygiene：隔离外部 LangGraph 表的 Alembic 管理边界，手写 migration 修复业务 metadata drift。
- Intelligence Calibration：记录启发式模型、当前指标、校准门槛与未来 ML 路径。

## 文档

- [Dependency_Audit.md](./Dependency_Audit.md)
- [Phase_4.5_Time_Standardization.md](./Phase_4.5_Time_Standardization.md)
- [Phase_4.5_Alchemy_Metadata_Audit.md](./Phase_4.5_Alchemy_Metadata_Audit.md)
- [Phase_4.5_Model_Calibration.md](./Phase_4.5_Model_Calibration.md)

最终验证结果见 [Phase_4.5_Completion_Report.md](./Phase_4.5_Completion_Report.md)。
