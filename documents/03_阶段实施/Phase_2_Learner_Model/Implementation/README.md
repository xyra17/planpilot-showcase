# PlanPilot Phase 2C-4 ~ 2C-7 实施记录

本目录记录 2026-07-29 在真实代码基础上完成的 Learner Model 后半程改动。
现有 Phase 1、Phase 2A、Phase 2B 和 Phase 2C-1~3 架构保持不变。

## 最终闭环

```text
LearningEvent
  → Pattern Analyzer
  → LearnerPattern
  → Profile Builder
  → LearnerProfile
  → Decision Context（只读）
  → DecisionProposal（待审）
  → Accept / Reject
  → Apply Gateway
  → ProposalFeedback
  → PatternEvidence + confidence 校准
```

## 重要文件

- `backend/src/intelligence/profile_metrics.py`：无 IO 的画像指标计算。
- `backend/src/intelligence/profile_builder.py`：user/goal Profile 查询与 upsert。
- `backend/src/intelligence/decision_context.py`：Agent 只读上下文与 Evidence 溯源。
- `backend/src/services/proposal_service.py`：Proposal 状态机和白名单 Apply Gateway。
- `backend/src/services/feedback_service.py`：效果反馈、统计和 Pattern confidence 校准。
- `backend/src/api/learner.py`：Phase 2C 对外 API。
- `frontend/app/(dashboard)/dashboard/coach/page.tsx`：学习伙伴完整交互页面。
- `backend/alembic/versions/u4v5w6x7y8z9_add_decision_feedback_loop.py`：数据库迁移。

## 不变量

1. Profile Builder 不修改 Pattern、不调用 Agent、不生成建议。
2. Decision Context Builder 只读，不产生数据库写入。
3. Agent 只能创建 Proposal，不能越过 Proposal 直接修改 Goal/Task。
4. Proposal 必须引用属于当前用户的 Active Pattern。
5. 业务变更只能在用户接受后通过 Apply Gateway 执行。
6. Proposal、业务变更和 Learning Event 在同一事务提交。
7. Feedback 会留下 LearningEvent 与 PatternEvidence，可追溯 confidence 变化。

## 数据库升级

```bash
cd backend
alembic upgrade head
```

新迁移 head：`u4v5w6x7y8z9`。

## 验证命令

```bash
cd backend
pytest -q tests/test_learner_loop.py
pytest -q tests/test_learning_events.py tests/test_pattern_analyzer.py
ruff check src tests/test_learner_loop.py

cd ../frontend
npm run build
```

更详细的职责、API 和运维说明见同目录其余文档。
