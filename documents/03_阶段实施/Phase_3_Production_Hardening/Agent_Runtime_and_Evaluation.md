# Coach Agent Runtime 与质量评估

## Runtime 边界

`backend/src/agents/coach_agent.py` 负责：

1. 接收只读 DecisionContext
2. 选择由 deterministic policy 允许的动作
3. 调用结构化 LLM 生成用户可读的 title / summary / reasoning
4. 使用 Pydantic 校验输出
5. 写入 trace；模型不可用或输出越权时执行安全回退

LLM 不负责直接修改 Goal 或 Task。所有修改仍必须经过：

```text
pending Proposal -> user review -> accepted -> apply gateway -> applied
```

用户可在 pending 阶段调整日期或每日学习负荷；调整后的数据仍会在 Apply 时再次验证所有权、日期和范围。

## Guardrails

- Proposal type 白名单
- LLM 输出 type 必须等于 deterministic policy 结果
- 每条 evidence reference 必须属于当前用户且为 Active Pattern
- Task reschedule 必须属于当前用户、task id 不重复、日期不早于今天
- daily hours 限制在 0.25 到 16
- LLM 异常只记录异常类型，不把凭证或原始响应写入 trace

## Evaluation

评估集：`backend/evals/coach_agent_cases_v1.json`

当前覆盖：

- morning learner：必须识别 `09:00`，不能推荐错误学习窗口
- overdue work：必须选择 `reschedule_overdue_tasks`
- low completion：必须选择 `reduce_daily_load`

执行：

```bash
cd backend
python scripts/evaluate_coach_agent.py
```

当前结果：3 / 3，pass rate 100%。

单测还验证：

- 合法结构化 LLM 输出被接受
- LLM 尝试输出 policy 之外的动作时使用 deterministic fallback
