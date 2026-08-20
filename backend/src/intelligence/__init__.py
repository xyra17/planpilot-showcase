"""Intelligence Layer — Phase 2C

职责：消费 LearningEvent，维护 LearnerProfile 和 LearnerPattern。

子模块：
- event_processor   : 事件路由 → ExtractionRule → PatternEvidence 写入（Phase 2C-3）
- extraction_rules  : YAML-configurable Pattern Extraction Rule 集合（Phase 2C-3）
- profile_builder   : 批处理 Profile 重算（Phase 2C-4）
- agent_interface   : Agent Decision Loop 只读入口（Phase 2C-5）

当前状态：Phase 2C-2（Schema 落库），event_processor 为 stub。
"""
