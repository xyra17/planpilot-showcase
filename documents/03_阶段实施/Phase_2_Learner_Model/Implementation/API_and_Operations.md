# Phase 2C API 与运行说明

所有接口均要求 Bearer JWT，且只操作当前登录用户的数据。

## Profile 与 Context

```text
POST /api/v1/learner/profile/rebuild
GET  /api/v1/learner/profile?goal_id=<optional>
GET  /api/v1/learner/decision-context?goal_id=<optional>
```

Profile 重建是显式用户级触发，不接受 `user_id` 参数，也不执行全局批处理。

## Proposal

```text
GET  /api/v1/learner/proposals?goal_id=<optional>&status=<optional>
POST /api/v1/learner/proposals/generate
POST /api/v1/learner/proposals/{id}/accept
POST /api/v1/learner/proposals/{id}/reject
POST /api/v1/learner/proposals/{id}/apply
```

`generate` body：

```json
{"goal_id": "optional-goal-id"}
```

`reject` body：

```json
{"reason": "当前阶段不适合执行"}
```

## Feedback

```text
POST /api/v1/learner/proposals/{id}/feedback
GET  /api/v1/learner/feedback/summary?goal_id=<optional>
```

Feedback body：

```json
{
  "outcome": "helpful",
  "rating": 5,
  "comment": "调整后更容易执行",
  "observed_metrics": {}
}
```

## 返回码

- `400`：Proposal 变更结构或目标值非法。
- `404`：Goal/Proposal 不存在或不属于当前用户。
- `409`：状态转换非法、Proposal 过期或重复提交 Feedback。
- `422`：请求 Schema 校验失败。

## 部署注意

1. 部署后先运行 `alembic upgrade head`。
2. 再发布后端与前端，避免前端先访问不存在的表。
3. Profile 是快照；首次使用学习伙伴时可点击“更新画像”。
4. 当前没有后台定时 Profile Job，`run_batch()` 仅保留为内部能力。
5. Pattern decay 仍应由独立生命周期任务调度，不应接入 Profile rebuild。
