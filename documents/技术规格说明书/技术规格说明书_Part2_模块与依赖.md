# 技术规格说明书 — Part 2
## 页面/模块架构与三方依赖

---

## 2. 页面与模块详细说明

### 2.1 根布局与全局配置

**文件**：`/Users/Admin/Desktop/PlanPilot/v1/app/layout.tsx`  
**职责**：挂载 `ThemeProvider`，向 `<html>` 写入 `data-color` 属性，驱动 CSS 变量主题切换；加载字体；包裹 `TasksProvider` 和 `KnowledgeProvider`。  
**第三方依赖**：无（Next.js 内置能力）

**文件**：`/Users/Admin/Desktop/PlanPilot/v1/app/globals.css`  
**职责**：定义全局 CSS 变量 token 系统。8 套内置配色方案（blue/indigo/violet/rose/amber/emerald/teal/rainbow），通过 `[data-color="xxx"]` 选择器切换，核心变量包括：

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `--accent` | `#2563eb` | 主色调，按钮/选中态/图表 |
| `--accent-light` | `#eff6ff` | 浅色背景填充 |
| `--accent-dark` | `#1d4ed8` | hover 加深态 |
| `--heat-0~4` | 蓝色梯度 | 热力图/时间块色阶 |

---

### 2.2 认证模块

**文件**：`/Users/Admin/Desktop/PlanPilot/v1/app/(auth)/login/page.tsx`  
**职责**：用户名/密码登录表单，调用后端 `/api/v1/auth/login`，成功后写入 `localStorage`（`access_token`、`user_name`），跳转 `/dashboard`。  
**状态**：表单为 React `useState` 本地控制，尚未接入 `lib/api.ts`（当前仍为 mock 跳转）。

**文件**：`/Users/Admin/Desktop/PlanPilot/v1/app/(auth)/register/page.tsx`  
**职责**：同上，注册流程。

---

### 2.3 Dashboard 侧边栏布局

**文件**：`/Users/Admin/Desktop/PlanPilot/v1/app/(dashboard)/layout.tsx`  
**职责**：渲染左侧固定宽度（`w-56`）导航侧栏，当前导航项：

| 标签 | 路由 | 图标 |
|------|------|------|
| 首页 | `/dashboard` | `Home` |
| 我的目标 | `/dashboard/goals` | `Target` |
| 知识库 | `/dashboard/knowledge` | `BookOpen` |
| 每日打卡 | `/dashboard/checkin` | `CalendarCheck` |

底部展示当前登录用户（从 `mockUser` 读取）及设置按钮。  
**第三方依赖**：`lucide-react`（图标库，~400 个 SVG 图标按需 tree-shake）

---

### 2.4 首页仪表盘

**文件**：`/Users/Admin/Desktop/PlanPilot/v1/app/(dashboard)/dashboard/page.tsx`  
**职责**：当日学习概览仪表盘，包含以下子模块（均为 inline 组件）：

- **`StudyLineChart`**：纯 SVG 折线图，渲染周/月/年学习时长趋势，贝塞尔平滑曲线 + 渐变面积填充
- **`StudyHeatmap`**：GitHub 风格学习热力图，按周排列，5 级色阶（`--heat-0~4`）
- **`DailyBriefCard`**：今日 AI 简报卡，渐变背景（`--brief-from → --brief-to`）
- **`DailySchedulePanel`**：今日时间规划核心组件

  `DailySchedulePanel` 支持两种模式：
  - **AI 模式**：点击「AI 智能规划」按钮，调用本地生成逻辑，将今日任务按优先级分配至早/午/晚三段
  - **手动模式**：拖拽式时间块编辑（增删改时间/颜色/任务关联）

  视图切换：
  - **时间轴视图**（`timeline`）：横向 `h-24` 轨道，色块宽度 = `durationMinutes / totalMinutes × 100%`，进度遮罩 = `rgba(255,255,255, progress/100 × 0.58)`
  - **列表视图**（`list`）：固定宽度列（时间 `w-28`、进度条 `w-28`、目标列宽由 `useMemo` 动态计算 `maxLen × 7px`）

**第三方依赖**：
- `lucide-react`：所有功能区图标
- `zustand`（间接）：通过 `useTasks` context 访问任务列表

---

### 2.5 目标列表页

**文件**：`/Users/Admin/Desktop/PlanPilot/v1/app/(dashboard)/dashboard/goals/page.tsx`  
**职责**：展示所有目标卡片，按状态分组（进行中/已完成）。目前数据来自 `mockGoals`，待接入 `useGoalStore.fetchGoals()`。

---

### 2.6 创建目标页

**文件**：`/Users/Admin/Desktop/PlanPilot/v1/app/(dashboard)/dashboard/goals/new/page.tsx`  
**职责**：AI 引导式目标创建，当前为 mock 多轮对话（固定回复），待替换为 `<ChatWindow>` + 后端 `/api/v1/goals` POST。

---

### 2.7 目标详情页（核心页面）

**文件**：`/Users/Admin/Desktop/PlanPilot/v1/app/(dashboard)/dashboard/goals/[id]/page.tsx`  
**职责**：两栏布局，左侧为目标信息 + 进度 + 任务管理，右侧为 AI 对话。

**左侧面板组成**：
1. 目标标题/截止日/整体进度条（来自 `mockGoals`）
2. `<ProgressOverview goalId>` — 四项实时指标（接 API）
3. Tab 切换：今日任务 / 任务日历
4. 今日任务列表 — 已完成任务 hover 显示「验收」按钮，点击触发 `VerificationDialog`
5. 「去打卡」按钮 → 跳转 `/dashboard/checkin?goalId=xxx`
6. `MiniCalendar` 月历 + `DayTaskList` 任务管理（增/删/改/完成）

**右侧面板**：`<ChatWindow goalId>` — 完整 SSE 流式 AI 对话

**底部弹窗**：`<VerificationDialog>` — 条件渲染，`verifyTask !== null` 时出现

**第三方依赖**：
- `lucide-react`
- `zustand`（通过 `useTasks` context）

---

### 2.8 每日打卡页

**文件**：`/Users/Admin/Desktop/PlanPilot/v1/app/(dashboard)/dashboard/checkin/page.tsx`  
**职责**：独立打卡页面，支持多目标切换（`?goalId=` URL 参数优先），预览今日计划，嵌入 `<CheckinForm>`。

**数据流**：
1. `useSearchParams` 读取 URL `goalId` 参数
2. `useGoalStore.fetchGoals()` 拉取目标列表（GET `/api/v1/goals`）
3. `useGoalStore.fetchTodayTasks(goalId)` 拉取今日任务（GET `/api/v1/plans/:id/today`）
4. 若有多个进行中目标，渲染目标切换下拉框
5. 展示今日前 4 条任务预览（带完成状态颜色）
6. `<CheckinForm goalId tasks>` 处理实际打卡提交

**第三方依赖**：`zustand`（goalStore）

---

### 2.9 SSE 代理路由

**文件**：`/Users/Admin/Desktop/PlanPilot/v1/app/api/stream/route.ts`  
**职责**：Next.js Route Handler，作为 SSE 中转层。解决两个问题：① 浏览器 CORS 限制，前端无法直连 Python 后端；② token 来源统一（优先 cookie，兼容 Authorization header）。

**数据流**：
```
Browser → POST /api/stream
         ↓ (读取 cookie/header token)
Next.js Handler → POST http://localhost:8000/api/v1/agent/stream
                  ↓ (失败: 返回 SSE 格式错误事件)
                  ↓ (成功: 透传 upstream.body ReadableStream)
Browser ← SSE 流 (Content-Type: text/event-stream)
```

---

### 2.10 AI 组件库

#### ChatWindow
**文件**：`/Users/Admin/Desktop/PlanPilot/v1/components/agent/ChatWindow.tsx`  
**职责**：完整 SSE 流式对话 UI。

SSE 事件协议（与后端约定）：

| event 类型 | data 结构 | 前端处理 |
|-----------|-----------|---------|
| `token` | `{ text: string }` | `appendToken(text)` 追加到最后一条 assistant 消息 |
| `tool_start` | `{ tool: string }` | 显示工具调用状态（"正在搜索资料..." 等） |
| `tool_end` | `{}` | 清除状态提示 |
| `structured` | `{ ...planData }` | `setStructuredOutput()` → 渲染 `<PlanCard>` |
| `confirmation_required` | `{ message: string }` | 内嵌确认/拒绝按钮 |
| `done` | `{}` | 清除状态提示 |
| `error` | `{ message: string }` | 追加错误文本至消息 |

工具标签映射：
```ts
const TOOL_LABELS: Record<string, string> = {
  web_search:    "正在搜索资料...",
  kb_search:     "正在检索知识库...",
  plan_generate: "正在生成计划...",
};
```

**第三方依赖**：`zustand`（chatStore）、`lucide-react`

---

#### CheckinForm
**文件**：`/Users/Admin/Desktop/PlanPilot/v1/components/agent/CheckinForm.tsx`  
**职责**：三模式打卡表单，POST `/api/v1/checkin/:goalId`。

| 模式 | 标识符 | 提交 payload |
|------|--------|-------------|
| 快速选择 | `quick` | `{ mode, quick_status: "all_done" \| "mostly_done" \| "half_done" \| "barely_done" }` |
| 逐项确认 | `task_list` | `{ mode, tasks: [{ task_id, status: "completed"\|"partial"\|"skipped" }] }` |
| 自然语言 | `natural` | `{ mode, text: string }` |

快速选项 `explain` 不提交，直接切换至 `natural` 模式。  
提交成功后渲染结果视图：完成率大字展示 + 三项统计（完成/部分/跳过）+ AI 文字反馈 + 重规划提示（`replan_triggered`）。

**第三方依赖**：`lucide-react`

---

#### VerificationDialog
**文件**：`/Users/Admin/Desktop/PlanPilot/v1/components/agent/VerificationDialog.tsx`  
**职责**：任务完成后的 AI 验收对话框（全屏模态，`backdrop-blur`）。

**对话流程**：
1. Mount → POST `/api/v1/agent/verify` `{ goal_id, task_id }` → 获取首个问题
2. 用户回答 → POST `/api/v1/agent/verify/answer` `{ goal_id, task_id, answer }` → 获取 `{ feedback, passed, follow_up? }`
3. `passed = true` → 显示绿色通过提示，输入区消失，「完成」按钮关闭弹窗
4. `passed = false` + `follow_up` → 追加追问，继续对话
5. API 不可用时自动降级（catch → 设 `passed = true`，不阻断用户流程）

**第三方依赖**：`lucide-react`

---

#### PlanCard
**文件**：`/Users/Admin/Desktop/PlanPilot/v1/components/agent/PlanCard.tsx`  
**职责**：渲染 AI 生成的结构化学习计划。

期望接收的 `plan` 数据结构：
```ts
interface Plan {
  summary?: { total_days: number; total_hours: number; phases: number };
  phases?: Array<{
    phase: number; title: string; start_day: number; end_day: number; goal: string;
    weeks: Array<{
      week: number; goal: string; milestone?: string;
      tasks: Array<{
        day_offset: number; title: string; estimated_mins: number;
        type: "study" | "review" | "practice" | "rest"; is_buffer?: boolean;
      }>;
    }>;
  }>;
  resource_hints?: string[];
}
```

渲染规则：过滤 `is_buffer = true` 的任务；每周最多显示 5 条，超出显示 `+N`；阶段可展开/折叠（`expandedPhase` state）。

---

#### ProgressOverview
**文件**：`/Users/Admin/Desktop/PlanPilot/v1/components/goal/ProgressOverview.tsx`  
**职责**：GET `/api/v1/goals/:goalId/progress`，渲染四张指标卡。

期望后端返回结构：
```ts
interface ProgressData {
  goal_id: string;
  title: string;
  deadline: string;
  total_tasks: number;
  completed_tasks: number;
  avg_completion_rate: number;   // 近7日平均，0~1 浮点
  streak_days: number;
  debt_count: number;
  days_ahead_or_behind: number;  // 正=超前，负=落后，0=正常
}
```

加载态：4 个 `animate-pulse` 占位骨架。API 失败时静默（`catch(() => null)`），返回 `null` 不渲染。

---

### 2.11 状态管理层

#### goalStore
**文件**：`/Users/Admin/Desktop/PlanPilot/v1/lib/stores/goalStore.ts`  
**库**：`zustand ^5.0.14`  
**职责**：全局目标列表与今日任务，跨 checkin 页和目标详情页共享。

#### authStore
**文件**：`/Users/Admin/Desktop/PlanPilot/v1/lib/stores/authStore.ts`  
**库**：`zustand ^5.0.14`  
**职责**：管理当前登录用户的会话状态，提供认证相关的所有异步动作。

**State**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `user` | `UserInfo \| null` | 当前用户对象（id/email/username/created_at） |
| `isLoading` | `boolean` | 登录/注册请求进行中 |
| `error` | `string \| null` | 最近一次认证错误消息 |

**Actions**：

| 方法 | 签名 | 说明 |
|------|------|------|
| `login` | `(email, password) => Promise<void>` | POST `/auth/login` → `storeToken` → 写 `localStorage.user_info` → 更新 `user` |
| `register` | `(email, username, password) => Promise<void>` | POST `/auth/register` → 同上 |
| `logout` | `() => void` | `clearToken` + 清除 `localStorage.user_info` + 重置 `user = null` |
| `initFromStorage` | `() => void` | 页面刷新时从 `localStorage.user_info` 恢复 `user` 对象，避免刷新后丢失登录态 |
| `updateUser` | `(data: Partial<UserInfo>) => Promise<void>` | PATCH `/auth/me` → 同步更新 `localStorage` 和 store |
| `changePassword` | `(currentPassword, newPassword) => Promise<void>` | POST `/auth/change-password`，成功则无副作用，失败则抛出 |

#### chatStore
**文件**：`/Users/Admin/Desktop/PlanPilot/v1/lib/stores/chatStore.ts`  
**库**：`zustand ^5.0.14`  
**职责**：SSE 消息队列管理。`addUserMessage` 同时追加用户消息和空占位 assistant 消息；`appendToken` 追加 token 至最后一条消息；`sessionId` 为 `crypto.randomUUID()` 生成的会话标识，传至后端维护上下文。

#### lib/api.ts
**文件**：`/Users/Admin/Desktop/PlanPilot/v1/lib/api.ts`  
**职责**：统一 HTTP 客户端。`BASE_URL` 由 `NEXT_PUBLIC_API_URL` 环境变量控制，默认 `http://localhost:8000`。Token 仅在 `typeof window !== "undefined"` 时读取（防止 SSR 报错）。

---

### 2.12 全局 Context 层

#### ThemeProvider / useTheme
**文件**：`/Users/Admin/Desktop/PlanPilot/v1/lib/theme-context.tsx`  
**挂载位置**：`app/layout.tsx` 根布局  
**职责**：管理应用主题（显示模式 + 配色方案），实现多账号主题隔离（按 `user.id` 存 localStorage）。

**ThemeMode（显示模式）**：

| 值 | 说明 |
|----|------|
| `"default"` | 标准浅色 |
| `"dark"` | 深色模式 |
| `"eye-care"` | 护眼模式（自动切换为 morandi-terracotta 配色） |
| `"sketch"` | 草稿模式 |

**ColorScheme（配色方案）**：支持 19 种方案，含标准色（blue/indigo/violet/rose/amber/emerald/teal/rainbow）和莫兰迪系列（morandi-rose/sage/stone/terracotta/lavender 等）。

**数据流**：
- `setMode(m)` → `document.documentElement.setAttribute("data-theme", m)` + `localStorage[modeKey]`
- `setColorScheme(c)` → `document.documentElement.setAttribute("data-color", c)` + `localStorage[colorKey]`
- `userId` 变化时（登录/登出/切换账号）从该用户专属 localStorage key 重新加载主题

**多账号隔离**：存储 key 为 `theme-mode-${userId}` / `theme-color-${userId}`，不同用户切换账号后各自的主题独立恢复。

#### KnowledgeProvider / useKnowledge
**文件**：`/Users/Admin/Desktop/PlanPilot/v1/lib/knowledge-context.tsx`  
**挂载位置**：`app/layout.tsx` 根布局  
**职责**：全局笔记列表的 CRUD 状态，供知识页和目标详情页共享。

**Context 类型**：
```ts
interface KnowledgeCtx {
  notes: KnowledgeNote[];
  addNote: (n: Omit<KnowledgeNote, "id" | "date" | "savedAt">) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  updateNote: (id: string, content: string) => Promise<void>;
}
```

**数据流**：
- 组件 mount → GET `/api/v1/knowledge/notes` 初始化列表
- `addNote` → POST `/notes` → 乐观前插列表
- `deleteNote` → 乐观删除（先更新 UI）→ DELETE `/knowledge/{id}` → 失败时重新拉取恢复
- `updateNote` → 乐观更新 → PATCH `/notes/{id}` → 失败时重新拉取恢复

---

### 2.13 DailyPlanModal（今日计划推荐弹窗）

**文件**：`/Users/Admin/Desktop/PlanPilot/v1/components/agent/DailyPlanModal.tsx`  
**触发方式**：首页仪表盘中「今日计划」按钮点击  
**第三方依赖**：`zustand`（useTasks）、`lucide-react`

**职责**：
- 打开时立即调用 `POST /api/v1/agent/daily-tasks`，获取 AI 推荐的今日任务列表
- 按目标分组展示任务建议（`GoalDailyPlan[]`），类型标签：学习（蓝）/ 复习（琥珀）/ 练习（绿）
- 默认全选，用户可单独取消勾选
- 「开始学习」：批量调用 `useTasks().addTask()` 将选中任务写入本地，关闭弹窗

**数据结构**：
```ts
type DailyTaskSuggestion = {
  title: string;
  estimated_mins: number;
  type: "study" | "review" | "practice";
  source_task_id: string | null;
  reason: string;
};

type GoalDailyPlan = {
  goal_id: string;
  goal_title: string;
  daily_hours: number;
  tasks: DailyTaskSuggestion[];
};
```

---

### 2.13 DebtCard（学习债务卡片）

**文件**：`/Users/Admin/Desktop/PlanPilot/v1/components/agent/DebtCard.tsx`  
**使用位置**：`checkin/page.tsx`（打卡表单上方）、`goals/[id]/page.tsx`（进度统计区）  
**第三方依赖**：`lucide-react`

**职责**：
- 挂载时调用 `GET /api/v1/debts/{goalId}` 获取当前目标未解决的学习债务
- 无债务 / 加载中：组件不渲染（`return null`）
- 列表展示：影响度徽章（high=红/medium=琥珀/low=蓝）、内容、跳过原因、欠账小时数
- 「已补」按钮：调用 `PATCH /api/v1/debts/{id}/resolve`，成功后从列表中移除

**Props**：
```ts
interface Props { goalId: string }
```

---

### 2.14 ReplanOptionsCard（重规划方案选择卡片）

**文件**：`/Users/Admin/Desktop/PlanPilot/v1/components/agent/ReplanOptionsCard.tsx`  
**使用位置**：`ChatWindow.tsx` 内，检测到 `tool_call: replan_options` 事件时渲染  
**第三方依赖**：`chatStore`（ReplanOptions/ReplanOption 类型）

**职责**：
- 展示 AI 生成的两个重规划方案（A=降低难度，B=延长截止）
- 每个方案卡片显示：方案标题、描述、权衡点、新每日学习时长（方案A）或新截止日期（方案B）
- 用户点击「选择此方案」→ 调用 `POST /api/agent/replan/{goal_id}/execute` 应用方案
- 方案应用成功后渲染绿色确认条，不再显示选项

**类型引用**：
```ts
// 来自 lib/stores/chatStore.ts
interface ReplanOption {
  label: string;
  description: string;
  trade_off: string;
  new_daily_hours?: number;
  new_deadline?: string;
  tasks: { title: string; estimated_mins: number; type: string }[];
}
interface ReplanOptions {
  goal_id: string;
  option_a: ReplanOption;
  option_b: ReplanOption;
}
```

## 3. 完整第三方依赖清单

### 生产依赖（`dependencies`）

| 包名 | 版本 | 用途 |
|------|------|------|
| `next` | `14.2.5` | App Router、Route Handler、SSR/RSC |
| `react` | `^18` | UI 框架 |
| `react-dom` | `^18` | DOM 渲染 |
| `zustand` | `^5.0.14` | 轻量全局状态管理（goalStore、chatStore） |
| `lucide-react` | `^0.400.0` | SVG 图标库，按需 tree-shake |
| `clsx` | `^2.1.1` | 条件 className 拼接 |
| `tailwind-merge` | `^2.4.0` | Tailwind 类名冲突去重 |
| `class-variance-authority` | `^0.7.0` | 组件变体 API（当前 `cn()` 工具基础） |

### 开发依赖（`devDependencies`）

| 包名 | 版本 | 用途 |
|------|------|------|
| `typescript` | `^5` | 类型系统 |
| `tailwindcss` | `^3.4.1` | 原子化 CSS 框架 |
| `@types/react` | `^18` | React 类型声明 |
| `@types/node` | `^20` | Node.js 类型声明 |
| `eslint` | `^8` | 代码规范 |
| `eslint-config-next` | `14.2.5` | Next.js ESLint 规则集 |
| `autoprefixer` | `^10` | CSS 自动前缀 |
| `postcss` | `^8` | CSS 处理管道 |
