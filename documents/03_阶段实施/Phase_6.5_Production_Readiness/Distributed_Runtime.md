# Distributed Runtime Hardening

## 问题

进程内熔断会让 Worker A 已阻断失败模型时，Worker B 仍继续施压。Phase 6.5 将状态迁移到 Redis，但保留 Redis 故障时的进程内应急熔断。

## 状态模型

每个 provider/model route 经过 SHA-256 摘要形成不泄露凭据的键：

```text
planpilot:model_gateway:circuit_state:{route_hash}
planpilot:model_gateway:circuit_lock:{route_hash}
planpilot:model_gateway:circuit_probe:{route_hash}
```

状态包含 `status`、`failures`、`opened_at`、`retry_after` 和 route。失败计数更新使用 Redis distributed lock；冷却到期后，`SET NX EX` 只允许一个 Worker 执行 half-open probe。

```text
closed --连续失败达到阈值--> open
open --冷却未到期--> 拒绝请求
open --冷却到期且抢到 probe--> half_open
half_open --成功--> 删除共享状态（closed）
half_open --失败--> open 并刷新 retry_after
```

## 故障策略

- Redis 可用：所有 Worker 共享熔断事实。
- Redis 暂时不可用：记录结构化 warning，使用进程内 breaker，不让 Redis 故障直接阻断 Agent。
- Primary 不可用：按 Model Gateway 的 bounded retry 和 fallback route 执行。
- 所有 attempt 进入 Agent Trace，不保存原始 prompt。

## Celery async runtime

Celery prefork 会在同一子进程内连续执行多个同步 task。旧实现为每个 task 调用一次 `asyncio.run()`，但 asyncpg/Redis pool 仍可能绑定到上一个已关闭的 loop，生产日志会出现 `Future attached to a different loop`。Phase 6.5 新增每 worker thread/process 持久的 asyncio loop；所有异步 Celery 入口统一通过 `tasks.runtime.run_async()` 执行，并在 fork PID 变化时重建 loop。

实际 Worker 验证连续向同一个 ForkPoolWorker 投递 6 次 recovery 和 4 次 Canary normalization，全部成功，无跨 loop 连接错误。

## 验证

自动化测试用两个独立 `_DistributedCircuit` 实例共享同一 Redis 仿真：Worker A 与 B 累计失败后同时看到 open；冷却后并发请求只有一个获得探测权。生产部署还需持续观察 Redis 可用性和 `local_fallback` 状态源。
