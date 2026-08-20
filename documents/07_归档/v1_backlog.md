# PlanPilot v1 Backlog

**整理日期**：2026-07-20
**说明**：以下功能均在 v1 技术开发文档中有明确规划，但在当前代码库中尚未实现，作为 v1.1 及后续迭代的工作项。

---

## 优先级说明

- **P0**：阻塞核心用户路径或已有前端但后端缺失
- **P1**：完整 v1 体验所需，影响用户留存
- **P2**：工程质量与可观测性，不影响功能但影响稳定性

---

## 一、账号管理（P0）

### 1.1 账号注销
- **接口**：`DELETE /api/v1/auth/me`
- **要求**：级联删除该用户的所有目标、计划、任务、打卡记录、知识库条目
- **状态**：前端已实现注销按钮和 `window.location.replace` 跳转，后端端点未上线

### 1.2 修改邮箱
- **接口**：`PATCH /api/v1/auth/me`（body: `{ email: string }`）
- **要求**：验证邮箱格式、检查唯一性，返回更新后的用户信息
- **状态**：前端已实现表单，后端端点未上线

---

## 二、学习债务系统（P0）

v1 文档定义了完整的 LearningDebt 子系统，当前代码库中完全缺失。

### 2.1 数据模型
新增 `LearningDebt` 表：
```
id, goal_id, task_id, content, estimated_hours,
skip_reason, impact, status(open/resolved)
```
需配套 Alembic 迁移文件。

### 2.2 后端端点
- `GET /api/v1/debts/{goal_id}` — 获取目标下所有未还债务
- `PATCH /api/v1/debts/{debt_id}/resolve` — 标记债务已解决

### 2.3 Agent 集成
- check-in 节点处理跳过任务时自动创建债务记录
- `debt` Tool（plan_ops 同级）：债务管理工具
- AgentState 中 `debt_items` 字段已在文档中定义，需在实际 state 中补充

### 2.4 前端展示
- 目标进度页面展示 `debt_count`（`GET /goals/{id}/progress` 已返回该字段）
- 债务列表组件（可折叠卡片）
- 解决债务的交互按钮

---

## 三、知识库增强（P1）

### 3.1 文件上传与向量化
- **接口**：`POST /api/v1/knowledge/upload`（multipart/form-data）
- **流程**：上传文件 → 存 S3/R2 → 派发 Celery 任务 `process_knowledge_file`
- **Celery 任务**：下载 → PyMuPDF 解析文本 → 语义分块（500 token/50 overlap）→ 批量调用 `text-embedding-3-small` → 写入 `knowledge_items` 表
- **支持格式**：PDF、DOCX、TXT（含中文）
- **依赖**：需先完成 3.3（embedding 字段迁移）

### 3.2 URL 导入
- **接口**：`POST /api/v1/knowledge/url`（body: `{ url: string, goal_id: string }`）
- **流程**：Jina Reader 解析网页正文 → 派发 Celery 任务 `process_url` → 分块向量化写库
- **依赖**：需先完成 3.3

### 3.3 KnowledgeItem 向量字段迁移
- `knowledge_items` 表新增 `embedding vector(1536)` 字段
- 新增 IVFFlat 索引：`CREATE INDEX ON knowledge_items USING ivfflat (embedding vector_cosine_ops) WITH (lists=100)`
- 需新建 Alembic 迁移文件

### 3.4 语义检索端点
- **接口**：`GET /api/v1/knowledge/search?q={query}&goal_id={id}&top_k=5`
- **实现**：将 query 向量化，按余弦相似度检索，过滤 goal_id，返回 top_k 结果
- **依赖**：需先完成 3.3

---

## 四、Check-in 三模式端点（P1）

当前 check-in 仅通过 `/stream` Agent 处理自然语言，缺少结构化端点。

### 4.1 接口
`POST /api/v1/checkin/{goal_id}`

### 4.2 三种模式
- **task_list**：逐项勾选，body 含 `tasks: [{task_id, status(completed/partial/skipped), actual_mins, note}]`
- **quick**：快捷选项，body 含 `quick_status: all_done|mostly_done|half_done|barely_done|explain`
- **natural**：自然语言，body 含 `text`，LLM 结构化后处理

### 4.3 响应格式（CheckinResponse）
```json
{
  "stats": {
    "total": N, "completed": N, "partial": N, "skipped": N,
    "completion_rate": 0.0~1.0,
    "estimated_mins": N, "actual_mins": N
  },
  "feedback": "鼓励性文字",
  "debt_added": N,
  "replan_triggered": false
}
```

### 4.4 前端组件（CheckinForm.tsx）
- 三模式 tab 切换
- quick 模式5个快捷选项按钮
- natural 模式 textarea
- 提交后展示 CheckinResponse feedback

---

## 五、Celery 异步任务补全（P1）

### 5.1 偏差检测任务（check_deviation）
- 触发时机：check-in 提交后异步派发
- 逻辑：连续4天完成率 < 60% → 设置 `replan_needed = True` → 下次对话时触发重规划提示
- 当前状态：stream 端点内有内联判断逻辑，但未提取为独立 Celery 任务

### 5.2 每日提醒任务（send_daily_reminders）
- 调度：UTC 15:00（北京 23:00），Beat 定时触发
- 逻辑：查询当日有任务但未打卡的用户，推送次日任务摘要
- 依赖：推送渠道（邮件/站内通知）需确定

---

## 六、限流中间件（P2）

- **工具**：SlowAPI（已在 PRD 中指定）
- **规则**：
  - `POST /api/v1/agent/stream`：10次/分钟
  - 其余接口：60次/分钟
- **实现**：Redis 滑动窗口计数
- **响应头**：`X-RateLimit-Limit`、`X-RateLimit-Remaining`、`Retry-After`（429 时）

---

## 七、可观测性（P2）

### 7.1 结构化日志
- 引入 `structlog`，替换现有 `logging.getLogger`
- 统一日志格式为 JSON，含 `user_id`、`goal_id`、`intent`、`latency_ms` 等字段

### 7.2 Langfuse LLM 追踪
- 封装 `TracedLLMCall` 上下文管理器
- 对所有 LLM 调用（agent 节点、daily-brief、macro-plan、verify、daily-tasks）添加追踪
- 需配置 `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` 环境变量

### 7.3 Prometheus 指标
- `llm_requests_total`（按 task_type/model/status 分标签）
- `llm_latency_seconds`（直方图）
- `agent_intents_total`（按 intent 分标签）
- `checkin_completion_rate`（直方图）
- 暴露 `/metrics` 端点

---

## 八、部署与工程化（P2）

### 8.1 docker-compose 完整化
当前已补充 redis、worker、beat 三个服务。待补充：
- `minio` 服务（本地 S3 替代，控制台端口 9001）——知识库文件上传功能就绪后添加
- `api` 服务（FastAPI，热重载）
- `web` 服务（Next.js，端口 3000）

### 8.2 GitHub Actions CI/CD
- `ci.yml`：push main/develop 触发，启动 postgres+redis 服务，运行 `alembic upgrade head + pytest`；前端 type-check + lint + build
- `deploy.yml`：push main + CI 通过后，Railway 自动部署 api 和 web 两个服务

### 8.3 Next.js SSE 代理路由
- 文件：`v1/app/api/stream/route.ts`
- 功能：解决 CORS，透传后端 SSE 流，添加 `X-Accel-Buffering: no`
- Token 优先级：Cookie Token → Header Token

---

## 九、前端缺失功能（P1）

| 功能 | 说明 |
|---|---|
| 账号注销（前端） | 按钮已有，需接通 `DELETE /api/v1/auth/me` 后端接口 |
| 修改邮箱（前端） | 表单已有，需接通 `PATCH /api/v1/auth/me` 后端接口 |
| Check-in 三模式 UI | CheckinForm.tsx 三 tab 组件（task_list/quick/natural）|
| 学习债务展示 | 目标页面债务卡片列表 + 解决按钮 |
| 知识库文件上传 UI | 文件拖拽上传 + 进度展示 |
| 知识库 URL 导入 UI | URL 输入框 + 解析状态 |

---

## 汇总表

| # | 模块 | 优先级 | 预估工作量 |
|---|---|---|---|
| 1 | 账号注销 + 修改邮箱 | P0 | 0.5天 |
| 2 | 学习债务系统（后端+前端） | P0 | 3天 |
| 3 | 知识库文件上传 + 向量化 | P1 | 3天 |
| 4 | 知识库 URL 导入 + 语义检索 | P1 | 1.5天 |
| 5 | Check-in 三模式端点 + 前端 | P1 | 2天 |
| 6 | Celery 偏差检测 + 提醒任务 | P1 | 1天 |
| 7 | 限流中间件 | P2 | 0.5天 |
| 8 | 可观测性（Langfuse + Prometheus） | P2 | 2天 |
| 9 | docker-compose 完整化 + CI/CD | P2 | 1天 |
| 10 | 前端缺失功能 | P1 | 2天 |
| **合计** | | | **约 16.5 天** |
