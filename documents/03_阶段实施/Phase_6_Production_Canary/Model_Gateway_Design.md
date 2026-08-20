# Model Gateway Design

`CoachAgent → ModelGateway → versioned model runnable → provider`。Gateway 不改变 Proposal 权限边界，也不记录 prompt 和完整回复。

1. 每个尝试都由 `asyncio.wait_for` 施加硬超时。
2. 只对 timeout 和短暂 Provider 异常执行有界重试，默认最多 1 次。
3. provider/model 连续失败达阈值后熔断，冷却后半开探测。
4. 主模型不可用时改用已有 `configured-router`；全部失败时回到 Coach 确定性建议。
5. trace 记录每次尝试的 route、outcome、latency、error category 和回退状态。

日志不记录 prompt、用户上下文或 Provider key。Phase 6 初版使用进程内熔断；Phase 6.5 已升级为 Redis 共享状态、distributed lock 和单一 half-open probe，细节见 [Distributed Runtime](../Phase_6.5_Production_Readiness/Distributed_Runtime.md)。重试与 fallback 不改变实验归属。
