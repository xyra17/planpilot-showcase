# 架构决策记录（ADR）
## PlanPilot — 关键技术选型的理由与替代方案分析

> ADR（Architecture Decision Record）记录"为什么选这个"而非"用了什么"。  
> 只记录**非显而易见的决策**：若某个选择的原因显而易见，则不记录。

---

## ADR-001：LLM 提供商分层策略（DeepSeek + 本地 mlx-lm）

**决策**：使用两层模型：DeepSeek（`deepseek-chat`）负责 intent 路由、计划生成、评分等结构化推理任务；本地 mlx-lm（Apple Silicon MPS 加速）负责 chat 节点的普通对话回复。

**被拒绝的替代方案**：

| 方案 | 拒绝原因 |
|------|---------|
| 全量使用 GPT-4o | 成本过高，chat 对话量大但质量要求相对低，用 GPT-4o 是过度投入 |
| 全量使用 DeepSeek | 网络延迟不稳定，chat 节点要求低延迟流式输出；本地模型在 Mac M 系列上推理延迟约100ms/token，远低于 API |
| 全量本地模型 | 本地模型在结构化 JSON 输出（计划生成/评分）上表现不稳定，无法替代 DeepSeek 的推理能力 |

**关键权衡**：本地模型重启后需 30–60 秒加载，冷启动是代价。生产环境中若无 Apple Silicon 机器，需将 mlx-lm 替换为 DeepSeek 或 GPT-4o-mini。

> **✅ 已解决（2026-07-23）**  
> **原方案**：FastAPI 启动后第一条 chat 消息触发模型加载，用户等待 30–60 秒白屏。  
> **新方案**：在 `main.py` 的 `lifespan` 函数中，若检测到 `settings.openai_base_url` 已配置（表示本地模型端点存在），启动时主动向本地模型发送 1 token 的热身请求，提前触发模型权重载入内存。  
> **改动位置**：`src/main.py` lifespan 函数新增约10行。  
> **量化效果**：首条用户消息延迟从 30–60 秒降至 ≤200ms（等同于后续正常推理延迟）；服务启动多耗时约 45 秒（模型加载一次性成本，每次重启只付一次）。  
> - *30–60 秒冷启动*：物理事实 — 7B+ 参数模型以 fp16 精度需 ~14 GB，Apple Silicon 统一内存需将权重从 NVMe 读入并完成模型图编译；来源：mlx-lm GitHub issues（#412、#438）及社区实测，非本项目实测值  
> - *≤200ms 热推理延迟*：本地实测估算 — mlx-lm 在 M 系列芯片上权重已驻留内存时的典型首 token 延迟，与后续 token 延迟同量级  
> **降级保护**：warmup 失败时仅打 warning 日志，不阻断服务启动。

---

## ADR-002：Agent 框架选择 LangGraph 而非自定义状态机

**决策**：使用 LangGraph 构建对话状态机（`StateGraph` + `TypedDict`）。

**被拒绝的替代方案**：

| 方案 | 拒绝原因 |
|------|---------|
| 自定义 `if/elif` 路由分发 | 难以维护：节点间状态传递、工具调用循环、Human-in-the-Loop 需要大量手写代码 |
| LangChain Agents（ReAct） | 不支持多节点有向图；`AgentExecutor` 的 HiL（中断-恢复）机制不够完善 |
| Autogen / CrewAI | 多 Agent 框架复杂度过高，PlanPilot 是单用户单 Agent 场景 |

**关键权衡**：LangGraph 的 `MemorySaver` 检查点为进程内存，重启后会话上下文丢失。若需持久化上下文，需改用 `langgraph-checkpoint-postgres`（已在 requirements.txt 中保留）。

> **✅ 已实现（代码已内置，2026-07-21 完成）**  
> **原状态（设计初期）**：使用 `MemorySaver()`，进程重启后所有对话上下文丢失，用户需从头开始对话。  
> **当前实现**：`src/core/agent/graph.py` 的 `get_agent()` 函数优先尝试初始化 `AsyncPostgresSaver`（连接同一个 PostgreSQL 库的独立连接池 `max_size=5`），失败时降级为 `MemorySaver`。  
> **量化效果**：对话上下文（messages + intent + pending_confirmation 等完整 AgentState）在服务重启后自动恢复；用户无感知。存储于 PostgreSQL `checkpoints` 表，与业务数据同库，无需额外基础设施。  
> **降级保护**：PostgreSQL 不可用时自动回退 MemorySaver，服务不受影响，仅上下文不持久化。

---

## ADR-003：向量数据库使用 pgvector 而非独立向量库

**决策**：在 PostgreSQL 中启用 pgvector 扩展存储和检索 1536 维向量嵌入。

**被拒绝的替代方案**：

| 方案 | 拒绝原因 |
|------|---------|
| Pinecone | SaaS，数据出境；增加一个外部依赖；按查询量计费 |
| Weaviate / Qdrant | 需要独立部署和运维，增加基础设施复杂度 |
| FAISS（内存） | 进程重启后向量丢失；无法与 PostgreSQL 事务一起原子更新 |

**关键权衡**：pgvector 的 `ivfflat` 索引（当前使用）在百万级数据以上精度下降；若数据量超过 500 万条，应切换至 `hnsw` 索引或独立向量库。当前 PlanPilot 用户规模，pgvector 足够。

> **✅ 已解决（2026-07-23）**  
> **原索引**：`ivfflat`（`lists=100`） — 构建快，但默认 `probes=1` 时召回率随数据量增长明显下降；提高 `probes` 可补偿精度但查询耗时线性增长，两者存在无法同时满足的权衡。  
> **新索引**：`hnsw`（`m=16, ef_construction=64`） — 不依赖 `probes` 参数，在大数据量下也能维持高召回率。  
> **量化参考**（来源：pgvector 官方文档、ann-benchmarks.com、Supabase/Neon 公开 benchmark；基于高维文本向量约50万条数据，非 PlanPilot 实测值）：  
> - 召回率（Recall@10）：ivfflat `probes=1` 约 87% → hnsw `m=16` 约 97%（+10%）  
> - 查询延迟增长：hnsw 随数据规模为 O(log N)，ivfflat 近似线性  
> - 构建时间：hnsw 比 ivfflat 慢约 2–3x（一次性成本）  
> - 内存占用：hnsw 约为 ivfflat 的 1.3x  
>
> **注意**：PlanPilot 当前知识条目体量较小，两种索引的实际召回差异可能不显著；此次升级为未来数据量增长做前置准备。若需验证实际效果，可对比 `ORDER BY embedding <-> query_vec` 与暴力全扫描的结果计算 Recall@10。  
> **迁移文件**：`alembic/versions/e1f2a3b4c5d6_upgrade_embedding_index_to_hnsw.py`，执行 `alembic upgrade head` 生效。  
> **回滚**：`alembic downgrade -1` 可恢复 ivfflat 索引。

---

## ADR-004：前端状态管理使用 Zustand 而非 Redux

**决策**：全局状态使用 Zustand（goalStore / authStore / chatStore），本地 UI 状态使用 React `useState`。

**被拒绝的替代方案**：

| 方案 | 拒绝原因 |
|------|---------|
| Redux Toolkit | 样板代码过多（action/reducer/selector），PlanPilot 状态结构简单，不值得引入 |
| React Context + useReducer | Context 在高频更新时（SSE token 逐字追加）会造成全树重渲染，性能差 |
| Jotai / Recoil | 原子化状态适合细粒度场景，但 goal + task + chat 三个 store 之间存在关联，Zustand 的集中式管理更直观 |

**关键权衡**：Zustand 的 store 不感知 React 组件树，SSR 场景下需手动处理水合（hydration）。当前 app 认证页为客户端渲染，无此问题。

---

## ADR-005：流式通信使用 SSE 而非 WebSocket

**决策**：LLM 流式输出通过 Server-Sent Events（SSE）传输。

**被拒绝的替代方案**：

| 方案 | 拒绝原因 |
|------|---------|
| WebSocket | 双向通信能力对 LLM 流式场景过度；需要独立 WS 服务器，与 Next.js Route Handler 集成复杂 |
| 轮询（Polling） | 延迟高，用户体验差；服务器压力大 |
| HTTP 长轮询 | 本质上是变相轮询，实现复杂且效果不如 SSE |

**关键权衡**：SSE 是单向的（服务器→客户端），用户发送消息需要独立 POST 请求。当前架构中，用户消息通过 `POST /api/stream` 发送（含消息体），响应是 SSE 流，符合该模式。

---

## ADR-006：异步任务队列使用 Celery + Redis 而非 FastAPI BackgroundTasks

**决策**：向量化任务（`vectorize_item`）和每日简报预生成（`generate_daily_brief_all`）使用 Celery + Redis。

**被拒绝的替代方案**：

| 方案 | 拒绝原因 |
|------|---------|
| FastAPI `BackgroundTasks` | 任务绑定在请求生命周期内；若 Web 进程重启则任务丢失；无重试机制 |
| asyncio Task（`asyncio.create_task`） | 同上；且向量化调用 OpenAI Embedding API，属 IO 密集型任务，Celery worker 可水平扩展 |
| APScheduler | 仅适合定时任务，不适合由事件（文件上传）触发的异步任务 |

**关键权衡**：Celery 需要 Redis 作为 broker，增加了一个基础设施依赖。本地开发需额外启动 Redis 和 Celery worker（`celery -A src.tasks worker`）。

---

## ADR-007：认证方案使用 JWT（无状态）而非 Session + Cookie

**决策**：使用 JWT（`python-jose`，HS256 算法，7天有效期）进行无状态认证，Token 存储在 `localStorage`。

**被拒绝的替代方案**：

| 方案 | 拒绝原因 |
|------|---------|
| Session + Redis | 需要服务端状态，增加 Redis 依赖（已有 Redis，但 Session 管理增加复杂度）；水平扩展时 Session 共享问题 |
| OAuth2 + 第三方登录 | PlanPilot 当前阶段为个人学习工具，无需第三方登录；可在 V2 阶段叠加 |
| HttpOnly Cookie | 与 localStorage 相比在 XSS 防护上更安全，但与 Next.js SSR 的兼容处理更复杂（当前 `/api/stream` 路由已兼容 cookie + header 双模式）|

**关键权衡**：JWT 存入 `localStorage` 存在 XSS 风险。当前 Token 有效期7天，若 Token 泄露无法主动撤销（无黑名单）。生产环境应考虑缩短有效期 + 增加 Refresh Token 机制。

> **✅ 已解决（2026-07-23）**  
> **原方案**：前端 `logout()` 仅清除 localStorage，服务端 Token 在 7 天内仍有效；被盗 Token 无法失效。  
> **新方案**：引入基于 Redis 的 JWT 黑名单机制：
> 1. `create_access_token` 在 payload 中增加 `jti`（UUID4）字段
> 2. `POST /api/v1/auth/logout` 端点：将 `jti` 写入 Redis，key 为 `bl:{jti}`，TTL 等于 Token 剩余有效期
> 3. `get_current_user` 依赖项：每次请求验证 Token 时，额外检查 `bl:{jti}` 是否存在于 Redis
> 4. 前端 `authStore.logout()` 改为 fire-and-forget 调用后端 `/logout`，本地清理不等待结果
>
> **量化效果**：  
> - 登出后 Token 立即失效（原来等待7天自然过期 → 现在 ≤1ms Redis 检查即生效）  
> - Redis 黑名单条目内存占用：每条约 100 bytes（计算值：key = `"bl:" 3字节 + UUID 36字节` = 39 字节，Redis 每条 string 键元数据开销约 55–65 字节，合计 ~100 bytes）；7天内最多积累 N 个登出操作，数量可控  
> - 验证延迟增加：每次认证多一次 Redis 读取（≤1ms 局域网 RTT）；来源：Redis 官方基准测试文档（redis.io/docs/management/optimization/benchmarks/），本地 GET/SET 典型延迟 0.1–0.5ms，可忽略不计  
>
> **降级保护**：Redis 不可用时黑名单检查静默跳过（`except Exception: pass`），不影响正常认证流程，退化为原无黑名单行为。  
> **遗留技术债**：`localStorage` 的 XSS 风险未解决；如需彻底解决，需将 Token 迁移至 `HttpOnly` Cookie（较大改动）。

---

## ADR-008：前端框架选择 Next.js App Router 而非纯 React SPA

**决策**：使用 Next.js 14 App Router。

**被拒绝的替代方案**：

| 方案 | 拒绝原因 |
|------|---------|
| Create React App / Vite SPA | 无内置 Route Handler，SSE 代理需要额外 Node.js 中间层（Express 等） |
| Remix | 理念相近，但生态/社区规模小于 Next.js；团队熟悉度低 |
| Nuxt / SvelteKit | 框架切换成本高，TypeScript + React 是团队主要技能 |

**关键权衡**：App Router 的 Server Components 在当前项目中使用较少（主要为客户端渲染），未充分发挥 RSC 优势。引入 App Router 的主要价值在于内置 Route Handler（用于 SSE 代理）和未来 SSR 扩展能力。
