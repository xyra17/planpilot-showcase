# 技术规格说明书 — Part 3
## 核心函数签名、运行指南与验证里程碑

---

## 3. 核心函数与关键 API 逆向审计

### 3.1 `lib/api.ts`

#### `request<T>`
```typescript
async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T>
```
**数据流**：从 `localStorage` 读取 `access_token` → 拼接 `BASE_URL + path` 发起 `fetch` → 若响应非 2xx 则解析错误 body 抛出 `Error` → 返回 `res.json() as Promise<T>`。是所有 `api.get/post/patch/del` 的底层。SSR 环境（`window === undefined`）token 为 `null`，请求不携带 Authorization。

#### `storeToken / clearToken`
```typescript
function storeToken(token: string, name?: string): void
function clearToken(): void
```
**数据流**：`storeToken` 向 `localStorage` 写入 `access_token` 和可选的 `user_name`。`clearToken` 删除两者。登录成功后由认证页调用，登出时清除。

---

### 3.2 `lib/stores/goalStore.ts`

#### `fetchGoals`
```typescript
fetchGoals: () => Promise<void>
```
**数据流**：`set({ isLoading: true })` → `api.get<Goal[]>("/api/v1/goals")` → `set({ goals })` → `finally set({ isLoading: false })`。checkin 页和目标列表页在 `useEffect` 中调用，结果全局共享，避免重复请求。

#### `createGoal`
```typescript
createGoal: (data: Omit<Goal, "id" | "status" | "created_at">) => Promise<Goal>
```
**数据流**：`api.post<Goal>("/api/v1/goals", data)` → 后端返回带 `id`、`status`、`created_at` 的完整 Goal 对象 → `set((s) => ({ goals: [goal, ...s.goals] }))` 乐观前插列表 → 返回 `goal` 供调用方跳转详情页。

#### `fetchTodayTasks`
```typescript
fetchTodayTasks: (goalId: string) => Promise<void>
```
**数据流**：`api.get<TodayTask[]>("/api/v1/plans/${goalId}/today")` → 后端按当天日期返回 AI 生成的任务列表 → `set({ todayTasks })`。checkin 页在 `activeGoalId` 变化时触发。

---

### 3.3 `lib/stores/chatStore.ts`

#### `addUserMessage`
```typescript
addUserMessage: (text: string) => void
```
**数据流**：向 `messages` 数组同时追加两条记录——`{ role: "user", content: text }` 和 `{ role: "assistant", content: "" }`（空占位）。占位消息由后续 `appendToken` 流式填充，保证 UI 不抖动。

#### `appendToken`
```typescript
appendToken: (token: string) => void
```
**数据流**：取 `messages` 末尾元素（总是 assistant 占位）→ 追加 `token` 字符串 → `set({ messages: newMsgs })`。每个 SSE `token` 事件触发一次，实现打字机效果。

#### `setStructuredOutput`
```typescript
setStructuredOutput: (data: Record<string, unknown>) => void
```
**数据流**：将 `data` 挂载到最后一条 assistant 消息的 `structuredOutput` 字段。`ChatWindow` 渲染消息时检测此字段，存在则渲染 `<PlanCard plan={structuredOutput} />`。

---

### 3.4 `app/api/stream/route.ts`

#### `POST`
```typescript
export async function POST(req: NextRequest): Promise<Response>
```
**数据流**：
1. 从 `cookies()` 读取 `access_token`，兼容 `Authorization` header（优先 cookie）
2. 将请求体原样 `JSON.stringify` 转发至 `${API_URL}/api/v1/agent/stream`
3. **连接失败**：捕获 `fetch` 异常，返回格式合规的 SSE 错误响应（`status: 200`，`Content-Type: text/event-stream`），前端 SSE 解析层可统一处理
4. **上游非 2xx**：同上，包装 status code 返回错误事件
5. **成功**：直接 `return new Response(upstream.body, { headers: SSE_HEADERS })`，将 `ReadableStream` 透传，零拷贝

关键响应头：`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`（禁用 Nginx 缓冲，避免流延迟）

---

### 3.5 `components/agent/ChatWindow.tsx`

#### `sendMessage`
```typescript
const sendMessage = useCallback(async (text: string): Promise<void> => {}, [deps])
```
**数据流**：
1. `addUserMessage(text)` 写入 store（同时创建 assistant 占位）
2. `new AbortController()` 挂载至 `abortRef`（支持中途停止）
3. `fetch("/api/stream", { method: "POST", body: JSON.stringify({ message, goal_id, session_id }), signal })`
4. 逐行解析 SSE 响应体：
   - 维护 `currentEvent` 变量，`event:` 行更新它
   - `data:` 行解析 JSON，按 `currentEvent` 分发到对应 store action
   - 忽略空行和 `{}`
5. `finally: setStreaming(false)`、`setToolStatus("")`

#### SSE buffer 解析逻辑（关键细节）
```typescript
buffer += decoder.decode(value, { stream: true });
const lines = buffer.split("\n");
buffer = lines.pop() ?? "";  // 保留不完整行供下次拼接
let currentEvent = "";
for (const line of lines) {
  if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
  else if (line.startsWith("data:")) {
    const payload = JSON.parse(line.slice(5).trim());
    // dispatch by currentEvent ...
  }
}
```
此逻辑正确处理了 SSE 标准格式中 `event:` 与 `data:` 分离的情况，避免了将 event 类型硬编码进 data 字段的反模式。

---

### 3.6 `components/agent/CheckinForm.tsx`

#### `submit`
```typescript
const submit = async (overrideQuick?: QuickStatus): Promise<void>
```
**数据流**：根据当前 `mode` 构造不同 `payload` → `api.post<CheckinResult>("/api/v1/checkin/${goalId}", payload)` → `setResult(res)` 切换为结果视图 → 调用 `onSuccess?.(res)`。`overrideQuick` 允许快选按钮点击时直接传入状态，无需等待 `setQuickStatus` 异步生效。

---

### 3.7 `components/agent/VerificationDialog.tsx`

#### `startVerification`（useEffect 内部函数）
```typescript
const startVerification = async (): Promise<void>
```
**数据流**：`api.post<{ question: string }>("/api/v1/agent/verify", { goal_id, task_id })` → 成功则 `setMessages([{ role: "ai", content: question }])` → 失败则使用 fallback 默认问题（`你刚完成了「${taskTitle}」...`），确保弹窗不因 API 不可用而卡死。

#### `sendAnswer`
```typescript
const sendAnswer = async (): Promise<void>
```
**数据流**：追加用户消息 → `api.post<{ feedback, passed, follow_up? }>("/api/v1/agent/verify/answer", { goal_id, task_id, answer })` → 追加 AI feedback → 若 `passed = true` 则 `setPassed(true)` + `onPassed?.()` → 若有 `follow_up` 则继续追加追问 → catch 时降级为自动通过。

---

### 3.8 `components/goal/ProgressOverview.tsx`

#### `useEffect`（数据拉取）
```typescript
useEffect(() => {
  api.get<ProgressData>(`/api/v1/goals/${goalId}/progress`)
    .then(setData)
    .catch(() => null)
    .finally(() => setLoading(false));
}, [goalId]);
```
**数据流**：组件 mount 时发起一次 GET 请求 → 成功则渲染4张指标卡 → 失败静默（返回 `null`）。`days_ahead_or_behind` 的正负决定趋势图标（`TrendingUp/TrendingDown/Minus`）和颜色。

---

## 4. 环境配置与本地运行指南

### 4.1 前提条件

| 工具 | 版本要求 | 验证命令 |
|------|----------|---------|
| Node.js | ≥ 18.17 | `node --version` |
| npm | ≥ 9.x | `npm --version` |
| Python（后端） | ≥ 3.11 | `python3 --version` |

### 4.2 前端启动步骤

```bash
# 1. 进入前端目录
cd /Users/Admin/Desktop/PlanPilot/v1

# 2. 安装依赖
npm install

# 3. 配置环境变量
cat > .env.local << 'EOF'
NEXT_PUBLIC_API_URL=http://localhost:8000
API_URL=http://localhost:8000
EOF

# 4. 启动开发服务器
npm run dev
# 输出: ▲ Next.js 14.2.5
#       - Local: http://localhost:3000
```

### 4.3 前端 `.env.local` 完整模板

```env
# /Users/Admin/Desktop/PlanPilot/v1/.env.local

# 后端 API 地址（浏览器侧可见，用于 lib/api.ts 的 fetch 调用）
NEXT_PUBLIC_API_URL=http://localhost:8000

# 服务端 API 地址（Next.js Route Handler 使用，不暴露给浏览器）
API_URL=http://localhost:8000
```

### 4.4 后端启动步骤（后端完成后参考）

```bash
# 1. 创建虚拟环境
cd /Users/Admin/Desktop/PlanPilot/backend
python3 -m venv .venv
source .venv/bin/activate          # macOS/Linux
# .venv\Scripts\activate           # Windows

# 2. 安装依赖
pip install -r requirements.txt

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 OPENAI_API_KEY / 数据库路径等

# 4. 启动服务（默认 port 8000）
uvicorn src.main:app --reload --host 0.0.0.0 --port 8000
```

### 4.5 后端 `requirements.txt` 实际清单

```text
# Web 框架
fastapi==0.139.0
uvicorn[standard]==0.51.0

# 数据库
sqlalchemy==2.0.30
alembic==1.18.5
asyncpg==0.31.0
pgvector==0.5.0
psycopg[binary]>=3.1.0
psycopg-pool>=3.2.0
greenlet==3.5.3

# 配置与校验
pydantic[email]>=2.7.1
pydantic-settings>=2.3.1
python-dotenv>=1.0.1

# 认证
python-jose[cryptography]==3.5.0
passlib[bcrypt]==1.7.4
bcrypt==3.2.2

# 上传
python-multipart==0.0.32

# HTTP 客户端
httpx>=0.27.0

# LLM / Agent
openai==2.45.0
langgraph==1.2.9
langgraph-checkpoint-postgres>=2.0.0
langchain-openai==1.3.5

# SSE 流式
sse-starlette==3.4.5

# 弹性重试
tenacity==9.1.4

# 本地模型推理（macOS Apple Silicon）
mlx-lm>=0.31.3

# 文档解析
pypdf>=4.0.0
python-docx>=1.1.0
openpyxl>=3.1.0

# 任务队列
celery[redis]==5.4.0
redis==5.0.3

# 邮件
aiosmtplib==3.0.1

# 限流
slowapi==0.1.10

# 可观测性
structlog==24.4.0
sentry-sdk[fastapi]==2.19.2
```

---

### 4.6 使用 pm2 让进程常驻（推荐）

#### 工作原理

`pm2` 是 Node.js 生态中的生产级进程管理器。它独立于终端运行，核心机制如下：

- **守护进程（Daemon）**：pm2 启动时会在后台启动一个 daemon 进程，所有被托管的应用都由 daemon 监控和重启，关闭终端窗口不影响运行。
- **自动重启**：进程崩溃时 pm2 自动重启，可配置最大重启次数。
- **开机自启（startup hook）**：`pm2 startup` 向系统注册一个开机脚本（launchd/systemd），系统重启后 daemon 自动恢复。
- **日志管理**：stdout/stderr 输出持久化到 `~/.pm2/logs/` 目录，可随时查看。

#### 安装

```bash
npm install -g pm2
```

#### 接管前端开发服务器

```bash
cd /Users/Admin/Desktop/PlanPilot/frontend
pm2 start npm --name "planpilot-frontend" -- run dev
pm2 save   # 将当前进程列表持久化到 ~/.pm2/dump.pm2
```

#### 设置开机自启

```bash
pm2 startup          # 输出一条 sudo 命令，复制粘贴执行
pm2 save             # 保存当前进程快照，开机后自动恢复
```

#### 常用命令速查

| 命令 | 说明 |
|------|------|
| `pm2 list` | 查看所有托管进程及状态 |
| `pm2 logs planpilot-frontend` | 实时查看前端日志 |
| `pm2 restart planpilot-frontend` | 手动重启 |
| `pm2 stop planpilot-frontend` | 暂停（不删除进程记录） |
| `pm2 delete planpilot-frontend` | 删除进程（停止并移除记录） |
| `pm2 monit` | 交互式资源监控面板 |

#### 让其他类型的进程常驻

pm2 不限于 Node.js，任何命令行程序都可以托管：

```bash
# Python 后端（uvicorn）
pm2 start "uvicorn src.main:app --reload --host 0.0.0.0 --port 8000" \
  --name "planpilot-backend" \
  --cwd /Users/Admin/Desktop/PlanPilot/backend

# 指定解释器
pm2 start app.py --name "my-python-app" --interpreter python3

# 带环境变量
pm2 start npm --name "planpilot-frontend" -- run dev \
  --env production
```

#### 当前 PlanPilot 进程状态

| 进程名 | 目录 | 启动命令 |
|--------|------|---------|
| `planpilot-frontend` | `frontend/` | `npm run dev` |

---

## 5. 阶段性验证硬性指标

### 里程碑 1 — 前端基础启动验证

**目标**：确认 Next.js 正常编译，所有页面可访问，无 TypeScript 报错。

```bash
cd /Users/Admin/Desktop/PlanPilot/v1

# 检查 TypeScript 编译
npx tsc --noEmit
# 预期输出：（无任何报错，进程退出码 0）

# 启动开发服务器
npm run dev
```

**预期终端输出**：
```
▲ Next.js 14.2.5
  - Local:        http://localhost:3000
  - Environments: .env.local
 ✓ Ready in 2.1s
```

**浏览器验证**：访问 `http://localhost:3000/dashboard`，页面正常渲染，侧边栏显示「首页 / 我的目标 / 知识库 / 每日打卡」四项导航。

---

### 里程碑 2 — API 层与状态管理验证

**目标**：确认 `lib/api.ts` 正确附加 token，`goalStore` 能正常发起请求（即使后端未启动也要验证请求格式正确）。

在浏览器 DevTools Console 执行：
```javascript
// 写入测试 token
localStorage.setItem("access_token", "test-token-123");

// 访问 http://localhost:3000/dashboard/checkin
// 在 Network 面板查看 /api/v1/goals 请求
// 预期：Request Headers 中包含 Authorization: Bearer test-token-123
```

**预期 Network 请求头**：
```
Authorization: Bearer test-token-123
Content-Type: application/json
```

若后端未启动，`ProgressOverview` 组件静默不渲染（不崩溃），checkin 页显示空目标列表——这是预期行为。

---

### 里程碑 3 — SSE 代理路由验证

**目标**：确认 `/api/stream` Route Handler 正确处理后端不可用的降级场景，返回合规 SSE 错误事件。

```bash
# 后端未启动的情况下，向 Next.js SSE 代理发送请求
curl -N -X POST http://localhost:3000/api/stream \
  -H "Content-Type: application/json" \
  -d '{"message":"测试","goal_id":"g1","session_id":"s1"}'
```

**预期输出**：
```
event: error
data: {"message":"无法连接到 AI 服务，请确认后端已启动"}

```

（`-N` 禁用 curl 缓冲，可看到流式输出；响应 HTTP 状态码为 200）

---

### 里程碑 4 — 完整 AI 对话链路验证（后端就绪后）

**目标**：验证 ChatWindow → SSE 代理 → 后端 Agent → SSE 流返回 → 前端渲染完整链路。

```bash
# 直接测试后端 SSE 端点
curl -N -X POST http://localhost:8000/api/v1/agent/stream \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <有效JWT>" \
  -d '{"message":"帮我制定一个CPA备考计划","goal_id":"g1","session_id":"test-session"}'
```

**预期流式输出格式**：
```
event: tool_start
data: {"tool":"plan_generate"}

event: token
data: {"text":"根据"}

event: token
data: {"text":"你的目标"}

event: structured
data: {"summary":{"total_days":90,"total_hours":180,"phases":3},"phases":[...]}

event: done
data: {}

```

**前端验证**：在目标详情页输入相同消息，ChatWindow 中应出现打字机效果文字 + `<PlanCard>` 展开可折叠的阶段/周/任务树。

---

## 附录：当前 Mock 数据残留说明

以下模块在集成完成后仍依赖 `mockGoals` 的字段（`goal.progress`、`goal.targetDate`、`goal.daysLeft`、`goal.progressStatus`），待后端就绪后需替换为 API 数据：

| 文件 | 使用的 mock 字段 | 计划替换接口 |
|------|----------------|-------------|
| `/Users/Admin/Desktop/PlanPilot/v1/app/(dashboard)/dashboard/goals/[id]/page.tsx` | `goal.progress`、`goal.targetDate`、`goal.daysLeft`、`goal.progressStatus` | GET `/api/v1/goals/:id` |
| `/Users/Admin/Desktop/PlanPilot/v1/app/(dashboard)/dashboard/goals/page.tsx` | `mockGoals` 列表全量 | GET `/api/v1/goals` via `useGoalStore` |
| `/Users/Admin/Desktop/PlanPilot/v1/app/(dashboard)/dashboard/page.tsx` | `mockUser`、`mockWeeklyHours`、`mockHeatmapData`、`mockDailyBrief` | 多个独立端点 |

`tasks-context.tsx` 和 `knowledge-context.tsx` 的内存状态在后端就绪后同样需要替换为 API 调用，但不影响当前前端功能演示。
