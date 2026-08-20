# Phase 4-5 Agent Evaluation

## Framework

`agent_evals` 持久化每个版本化 benchmark case 的输入、期望、实际输出和四类质量指标：

- Planning Quality
- Recommendation Accuracy
- User Acceptance
- Long-term Improvement

同一 `benchmark_name + case_id` 使用 upsert 语义，便于持续追踪而不重复堆积相同 case。

## Benchmark V2

`backend/evals/agent_benchmark_v2.json` 包含 20 个 deterministic cases，覆盖：

- 新用户
- 高拖延用户
- 高频学习用户
- 中断恢复
- 长期目标

测试对象包括 Coach action guardrail、Failure Prediction 和 Forgetting Curve。当前基准结果：20/20，pass rate 100%。

执行：

```bash
cd backend
python scripts/evaluate_agent_v2.py \
  --output evals/agent_evaluation_report_v2.json \
  --persist
```

持久化汇总接口：`GET /api/v1/intelligence/evaluations/summary`。

