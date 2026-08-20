# Phase 4：Intelligence Enhancement

Phase 4 在 Phase 2C/3 的事件、Pattern、Profile、DecisionContext、Proposal 和 Feedback 闭环上增加认知状态、三层记忆、预测式规划与知识图谱。所有会修改 Goal/Task 的智能动作仍必须经过 Proposal review 和 Apply Gateway。

## 数据流

```text
LearningEvent
  ├─ Pattern Analyzer → LearnerPattern
  ├─ Profile Builder → LearnerProfile
  ├─ Cognitive Builder → LearnerCognitiveProfile
  └─ Memory Builder → LearningMemory

KnowledgeItem/TaskMastery → LearningConcept → KnowledgeEdge → Knowledge Gap

DecisionContext + Cognitive + Memory + Gap + Risk
  → Adaptive Planner / Coach Agent
  → DecisionProposal
  → User Review
  → Apply Gateway
  → Feedback
```

## 兼容原则

- 不修改 Phase 2C 的 Profile/Pattern 语义。
- 不允许 Agent 直接写 Goal、Task 或 Plan。
- KnowledgeItem 继续作为 RAG 资源事实来源。
- 新模块使用独立 Service 与批处理任务，Router 保持薄层。

## 实施结果

- Phase 4-1 至 4-5 已完成，并已接入现有 Dashboard、Coach 与 Proposal 闭环。
- 数据库当前版本：`x7y8z9a0b1c2 (head)`。
- Agent Benchmark：20/20 通过。
- 后端回归：320 passed、6 skipped；前端生产构建和真实 Chrome E2E 通过。

完整交付与风险记录见 [Phase_4_Completion_Report.md](./Phase_4_Completion_Report.md)。
