# Phase 4-4 Knowledge Intelligence

## Graph Model

- Concept Node：`learning_concepts`
- Resource Node：复用现有 `knowledge_items`
- Relationship：`knowledge_edges`

Edge 从 Concept 指向另一个 Concept 或 KnowledgeItem，数据库 CheckConstraint 保证两类目标只能选择一个。

关系类型：

- `prerequisite`
- `part_of`
- `related`
- `reinforces`
- `explained_by`

## Retention 与 Gap

Concept 保存首次掌握强度、遗忘率、最近复习时间和下次复习时间。查询时实时计算 retention，不每日覆盖历史掌握值。

Gap 综合：

- 当前 Concept retention
- prerequisite 最低 retention
- evidence 是否充足

提供“为什么不会”解释接口和“下一步学什么”接口。后者只推荐前置概念 retention 不低于 0.65 的未掌握节点。

## API

- `POST/PATCH /api/v1/intelligence/concepts`
- `POST /api/v1/intelligence/edges`
- `GET /api/v1/intelligence/knowledge-graph`
- `GET /api/v1/intelligence/knowledge-gaps`
- `GET /api/v1/intelligence/concepts/{id}/explain`
- `GET /api/v1/intelligence/next-concepts`

