# 调度与生产运维

## Celery Beat 学习循环

定义位置：`backend/src/celery_app.py`。

| Job | Schedule (Asia/Shanghai) | Purpose |
|---|---:|---|
| `process-learning-events` | 每 5 分钟 | 使用复合游标消费 LearningEvent，更新 Pattern |
| `decay-learner-patterns` | 每天 00:30 | active → decayed → archived |
| `rebuild-learner-profiles` | 每天 01:00 | 重算所有近期活跃用户的 user / goal Profile |

Event Processor 游标现在按 `(created_at, event_id)` 排序，避免多事件同时间戳时使用单字段游标造成遗漏。

## 手动运维

执行 migration：

```bash
cd backend
alembic upgrade head
```

触发任务：

```bash
celery -A src.celery_app.celery_app call src.tasks.pattern_tasks.process_learning_events
celery -A src.celery_app.celery_app call src.tasks.pattern_tasks.decay_learner_patterns
celery -A src.celery_app.celery_app call src.tasks.profile_tasks.rebuild_learner_profiles
```

健康检查：

- `/health`：进程存活
- `/ready`：PostgreSQL 与 Redis 均可访问
- `/health/ai`：LLM / embedding runtime 状态
- API 容器：调用 `/ready`
- worker 容器：执行 Celery inspect ping
- beat 容器：不继承 API 的 HTTP healthcheck，Docker 进程状态作为存活判断

## 生产部署

1. 复制 `backend/.env.production.example` 为 `backend/.env.production`。
2. 设置强随机 `SECRET_KEY`、模型凭证、CORS 和 Sentry。
3. 在 shell 设置 `POSTGRES_PASSWORD`、`REDIS_PASSWORD`。
4. 启动：

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

生产 Compose 包含：

- PostgreSQL
- Redis（密码与 AOF）
- 一次性 migration service
- API（2 workers）
- Celery worker
- Celery beat
- Frontend

Backend 与 Frontend image 分别使用 `planpilot`、`node` 非 root 用户；日志启用轮转上限。开发 Compose 因宿主机 bind mount 的文件所有权显式使用 root，生产 Compose 不挂载源代码且保持非 root。

生产配置可在不启动服务时验证：

```bash
POSTGRES_PASSWORD=config-check REDIS_PASSWORD=config-check \
  docker compose -f docker-compose.prod.yml config -q
```

## Observability

- 所有 API 日志为 JSON
- 每个 HTTP 请求生成或透传 `X-Request-ID`
- request completion 记录 method、path、status、elapsed time
- Sentry 支持 environment 与 trace sample rate
- Proposal 持久化 `agent_trace.trace_id`、runtime、fallback、model、latency

日志不得记录 access token、密码、完整 prompt 或完整模型 response。
