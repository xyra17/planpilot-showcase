# PlanPilot v3 变更记录

> **基准版本**：v2（`/Users/Admin/Desktop/PlanPilot/v2/`）  
> **当前路径**：`/Users/Admin/Desktop/PlanPilot/`  
> **记录起始**：2026-07-24

---

## 一、计划生成「补充说明」placeholder 改为 LLM 实时生成（2026-07-24）

### 背景与动机

v2 的 `PlanModeSelector.tsx` 中，"补充说明"输入框的 placeholder 按目标类型（exam / skill / reading 等）静态预设。例如 exam 类型固定显示"数学基础较弱，重点攻大题…"，但当目标是「备考专利代理师考试」时，这句话明显不符（专利代理不考数学），容易误导用户填错方向。

改为根据目标的**实际标题**由后端 LLM 实时生成，针对性强、不会出现领域不匹配的问题。LLM 失败时自动降级到原有静态文案，不影响可用性。

### 改动文件

| 文件 | 类型 | 改动说明 |
|------|------|---------|
| `backend/src/api/agent.py` | 新增端点 | `GET /api/v1/agent/intent-placeholder/{goal_id}` |
| `frontend/components/goal/PlanModeSelector.tsx` | 修改 | 并发请求 plan-context + intent-placeholder，动态展示 |

### 后端：新增 `GET /api/v1/agent/intent-placeholder/{goal_id}`

- 查询目标标题和类型，构造针对该具体目标的 prompt
- 调用 Smart LLM（DeepSeek），生成以"例如："开头的 30-50 字 placeholder
- LLM 失败时返回 `{"placeholder": ""}` — 前端自动降级到原有静态文案

### 前端：`handleNextStep` 改为并发请求

v2 只请求 `plan-context`；v3 改为 `Promise.allSettled` 同时请求两个接口，不增加用户等待时间：

```typescript
const [contextResult, placeholderResult] = await Promise.allSettled([
  api.get<PlanContextData>(`/api/v1/agent/plan-context/${goalId}`),
  api.get<{ placeholder: string }>(`/api/v1/agent/intent-placeholder/${goalId}`),
]);
```

`displayPlaceholder` 优先使用 LLM 生成结果，静态文案作为降级兜底：

```typescript
const displayPlaceholder = intentPlaceholder || (INTENT_PLACEHOLDER[goalType] ?? INTENT_PLACEHOLDER.skill);
```

新增状态 `intentPlaceholder`，`open` 变为 `false` 时随其他状态一同重置。

---

## 二、本地模型更换：Qwen3.5-9B-MLX-4bit（2026-07-24）

### 变更内容

将本地 LLM 从 `Qwen2.5-14B-Instruct-4bit` 更换为 `Qwen3.5-9B-MLX-4bit`。

| 项目 | 旧值 | 新值 |
|------|------|------|
| 模型 | Qwen2.5-14B-Instruct-4bit | Qwen3.5-9B-MLX-4bit |
| 模型路径 | `/Users/Admin/Downloads/models/Qwen2.5-14B-Instruct-4bit` | `/Users/Admin/Downloads/models/lmstudio-community/Qwen3.5-9B-MLX-4bit` |
| 磁盘占用 | ~8 GB | ~5 GB |

### 受影响文件

| 文件 | 改动 |
|------|------|
| `backend/.env` | `MODEL_NAME` 更新为新路径 |
| `documents/PlanPilot_环境搭建与启动指南.md` | 模型对照表更新 |

### 变更原因

Qwen3.5-9B 是 Qwen 新一代模型，中文能力优于 2.5-14B，体积更小（节省约 3 GB），速度与质量平衡更好。

---

## 三、MLX 本地模型服务运维文档（2026-07-24）

新增桌面文档 `MLX-Server-LaunchAgent说明.md`，记录两种运行本地模型服务的方案：

- **方案一（nohup）**：后台运行，关闭终端后服务继续，重启电脑后需重新执行
- **方案二（LaunchAgent）**：macOS 开机自启，崩溃自动重启，无需手动干预

文档包含：服务信息速查、创建/加载/停止/删除命令、日志查看、模型/端口修改方式。
