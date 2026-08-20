# 技术实现与架构说明书
## PlanPilot v1 — 前端技术规格（2026-07-13）

---

## 0. 研发历程（Vibecoding 演进记录）

### 阶段 1 — 纯 UI + Mock 数据（静态原型）

所有页面以 `/Users/Admin/Desktop/PlanPilot/v1/lib/mock-data.ts` 中的常量驱动，包括 `mockUser`、`mockGoals`、`mockGoalMessages`、`mockWeeklyHours`、`mockHeatmapData` 等。业务逻辑通过三个 React Context 在组件树内流转：

- `/Users/Admin/Desktop/PlanPilot/v1/lib/tasks-context.tsx`：本地任务 CRUD（内存）
- `/Users/Admin/Desktop/PlanPilot/v1/lib/knowledge-context.tsx`：知识库笔记（内存）
- `/Users/Admin/Desktop/PlanPilot/v1/lib/theme-context.tsx`：主题色切换

这一阶段完成了全部页面的视觉骨架：登录、注册、首页仪表盘、目标列表、目标详情、知识库、设置。右侧 AI 对话区为伪交互（`useState` 追加固定回复），进度数据全部硬编码。

### 阶段 2 — 视觉缺陷逐项修正

首页 `DailySchedulePanel`（今日时间规划）暴露出三个系统性问题，依次修复：

**问题 A — CSS variable 与 hex alpha 拼接失效**
时间块颜色来自 `var(--heat-2)` 等 CSS 变量，代码尝试用 `${b.color}44` 附加透明度，但 CSS 变量拼接字符串在 `style` prop 中无法被浏览器解析，导致渲染为白色。  
修复方案：在色块内叠加独立 `div`，以 `rgba(255,255,255, opacity)` 实现进度遮罩，完全绕开格式兼容问题。

**问题 B — 进度方向语义颠倒**
初版遮罩逻辑为：进度 100% → 全透明（颜色最鲜）。用户期望恰好相反：0% 时颜色饱满，100% 时偏淡（表示"已完成/淡出"）。  
修复：遮罩 opacity = `progress / 100 × 0.58`，进度越高白色越多。

**问题 C — 列表视图列对齐随内容变化**
"关联目标"列使用 `max-w-28` 导致不同行宽度不一，视觉错位。  
修复：用 `useMemo` 计算所有行中目标名最大字符数，以 `maxLen × 7px` 为固定 `width` 强制等宽列。

### 阶段 3 — 真实 API 层搭建

脱离 mock，建立与后端通信的基础设施：

- `/Users/Admin/Desktop/PlanPilot/v1/lib/api.ts`：封装 `fetch`，自动附加 `Authorization: Bearer <token>`，token 读写 `localStorage`
- `/Users/Admin/Desktop/PlanPilot/v1/lib/stores/goalStore.ts`：Zustand store，管理目标列表与今日任务，调用 `/api/v1/goals` 和 `/api/v1/plans/:id/today`
- `/Users/Admin/Desktop/PlanPilot/v1/lib/stores/chatStore.ts`：Zustand store，管理 SSE 流式消息队列、工具状态、会话 ID
- `/Users/Admin/Desktop/PlanPilot/v1/app/api/stream/route.ts`：Next.js Route Handler，作为 SSE 代理将请求透传至 Python 后端，同时处理 token 注入与错误降级

### 阶段 4 — AI 功能组件构建

五个独立组件完成 AI 交互闭环：

| 组件 | 路径 | 核心能力 |
|------|------|----------|
| `ChatWindow` | `/Users/Admin/Desktop/PlanPilot/v1/components/agent/ChatWindow.tsx` | SSE 流式对话，工具调用状态显示，人工确认弹窗 |
| `CheckinForm` | `/Users/Admin/Desktop/PlanPilot/v1/components/agent/CheckinForm.tsx` | 三模式打卡（快选/逐项/自然语言），提交后展示 AI 反馈 |
| `VerificationDialog` | `/Users/Admin/Desktop/PlanPilot/v1/components/agent/VerificationDialog.tsx` | 任务完成后 AI 验收问答，多轮对话直至通过 |
| `PlanCard` | `/Users/Admin/Desktop/PlanPilot/v1/components/agent/PlanCard.tsx` | 渲染 AI 生成的结构化学习计划（阶段/周/任务树） |
| `ProgressOverview` | `/Users/Admin/Desktop/PlanPilot/v1/components/goal/ProgressOverview.tsx` | 拉取 `/api/v1/goals/:id/progress`，展示四项核心进度指标 |

### 阶段 5 — 页面集成（当前完成态）

- `layout.tsx` 导航栏新增「每日打卡」入口
- `goals/[id]/page.tsx` 右侧 AI 对话区替换为 `<ChatWindow>`（约删除 200 行 mock 逻辑）
- 四格指标替换为 `<ProgressOverview>`（调用真实 API）
- 今日任务列表：已完成任务 hover 显示「验收」按钮，触发 `<VerificationDialog>`
- 打卡入口跳转至 `/dashboard/checkin?goalId=...`

---

## 1. 项目文件目录树

```
/Users/Admin/Desktop/PlanPilot/v1/                  ← 前端根目录
├── app/
│   ├── layout.tsx                                   ← 根布局（字体、主题 Provider）
│   ├── page.tsx                                     ← 根路由（重定向至 /dashboard）
│   ├── globals.css                                  ← CSS 变量 token 系统（8 套主题色）
│   ├── (auth)/
│   │   ├── login/page.tsx                           ← 登录页
│   │   └── register/page.tsx                        ← 注册页
│   ├── (dashboard)/
│   │   ├── layout.tsx                               ← Dashboard 侧边栏布局
│   │   └── dashboard/
│   │       ├── page.tsx                             ← 首页（仪表盘）
│   │       ├── checkin/page.tsx                     ← 每日打卡页
│   │       ├── goals/
│   │       │   ├── page.tsx                         ← 目标列表页
│   │       │   ├── new/page.tsx                     ← 创建目标（AI 引导对话）
│   │       │   └── [id]/page.tsx                    ← 目标详情页
│   │       ├── knowledge/page.tsx                   ← 知识库页
│   │       └── settings/page.tsx                    ← 设置页（主题色/账户）
│   └── api/
│       └── stream/route.ts                          ← SSE 代理 Route Handler
│
├── components/
│   ├── agent/
│   │   ├── ChatWindow.tsx                           ← SSE 流式对话窗口
│   │   ├── CheckinForm.tsx                          ← 每日打卡表单（3 模式：快速/详细/自由）
│   │   ├── PlanCard.tsx                             ← 结构化计划渲染卡片
│   │   ├── VerificationDialog.tsx                   ← 任务验收对话框
│   │   ├── DailyPlanModal.tsx                       ← 今日任务 AI 推荐弹窗
│   │   ├── DebtCard.tsx                             ← 学习债务展示卡片
│   │   └── ReplanOptionsCard.tsx                    ← 重规划方案 A/B 选择卡片
│   └── goal/
│       └── ProgressOverview.tsx                     ← 目标进度四格指标卡
│
├── lib/
│   ├── api.ts                                       ← HTTP 客户端（Bearer Token）
│   ├── utils.ts                                     ← cn() 工具函数（clsx + tailwind-merge）
│   ├── mock-data.ts                                 ← 全量 mock 数据（阶段1遗留，部分仍在用）
│   ├── tasks-context.tsx                            ← 本地任务 Context（目标详情页仍用）
│   ├── knowledge-context.tsx                        ← 知识库笔记 Context
│   ├── theme-context.tsx                            ← 主题色 Context（data-color attribute）
│   └── stores/
│       ├── goalStore.ts                             ← Zustand：目标列表 + 今日任务
│       └── chatStore.ts                             ← Zustand：SSE 消息队列 + 流控
│
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── postcss.config.js

── 后端目录 ──────────────────────────────────────────────────
/Users/Admin/Desktop/PlanPilot/backend/
├── src/
│   ├── main.py                                      ← FastAPI 入口（slowapi限流 + structlog + Sentry）
│   ├── config.py                                    ← Pydantic Settings（.env 加载）
│   ├── database.py                                  ← AsyncSession + AsyncSessionLocal
│   ├── deps.py                                      ← JWT 鉴权依赖（get_current_user）
│   ├── models.py                                    ← SQLAlchemy ORM（9 张表）
│   ├── celery_app.py                                ← Celery + Beat 定时任务配置
│   ├── api/
│   │   ├── auth.py                                  ← /api/v1/auth/* （含 slowapi 限流）
│   │   ├── goals.py                                 ← /api/v1/goals/*
│   │   ├── plans.py                                 ← /api/v1/plans/*
│   │   ├── tasks.py                                 ← /api/v1/tasks/*
│   │   ├── checkin.py                               ← /api/v1/checkin/*
│   │   ├── debt.py                                  ← /api/v1/debts/*
│   │   ├── knowledge.py                             ← /api/v1/knowledge/*
│   │   ├── notifications.py                         ← /api/v1/notifications/*
│   │   ├── schedule.py                              ← /api/v1/schedule/*
│   │   └── agent.py                                 ← /api/v1/agent/* （SSE + LangGraph）
│   ├── schemas/
│   │   └── auth.py                                  ← Pydantic 认证 Schema
│   ├── core/
│   │   └── agent/
│   │       ├── graph.py                             ← LangGraph 图构建（get_agent）
│   │       ├── state.py                             ← AgentState TypedDict
│   │       ├── tools.py                             ← chat_tools 工具列表
│   │       └── nodes/
│   │           ├── intent.py                        ← 意图识别节点
│   │           ├── planner.py                       ← 计划生成节点
│   │           ├── chat.py                          ← 普通对话节点（含债务感知）
│   │           ├── checkin.py                       ← 打卡节点
│   │           ├── verify.py                        ← 验收节点
│   │           ├── replan_chat.py                   ← 重规划对话节点
│   │           └── confirm_replan.py                ← 重规划确认节点
│   └── tasks/
│       ├── daily_brief.py                           ← Celery 任务：7:30 生成每日简报
│       ├── deviation.py                             ← Celery 任务：偏差检测
│       └── reminder.py                              ← Celery 任务：23:00 打卡提醒
├── alembic/                                         ← 数据库迁移
│   └── versions/
│       ├── f2c8d1e04a7b_*.py                        ← 基础表（users/goals/tasks/checkins）
│       ├── a1b2c3d4e5f6_add_daily_brief_cache.py
│       ├── b4c5d6e7f8a9_add_pgvector_extension.py
│       ├── c1d2e3f4a5b6_add_learning_debts.py
│       └── d2e3f4g5h6i7_add_daily_schedules.py
├── requirements.txt                                 ← 33 个依赖（含 celery/redis/slowapi/sentry）
├── Dockerfile
├── docker-compose.yml
└── .env
