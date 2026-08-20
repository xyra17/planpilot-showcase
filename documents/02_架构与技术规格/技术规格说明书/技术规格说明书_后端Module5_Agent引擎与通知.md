# 技术实现与架构说明书
## PlanPilot 后端 — Module 5：Agent 引擎与通知（2026-07-23）

---

## 0. 模块定位

Module 5 是后端的 AI 核心，负责：
1. 基于 LangGraph 构建对话状态机，支持流式 SSE 输出和 Human-in-the-Loop 确认
2. 宏观计划生成、重规划、日程安排等计划管理工具
3. 每日简报生成与缓存（配合 Celery 异步预生成）
4. 掌握度验证（出题 → 评分 → 反馈）
5. 通知中心（基于 `daily_brief_caches` 表）

涉及文件：`src/api/agent.py`（1442行）、`src/api/notifications.py`、`src/core/agent/`。

---

## 1. API 路由总览

### 1.1 `src/api/agent.py`

前缀：`/api/v1/agent`，所有端点需要 JWT 认证。

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/stream` | SSE 流式对话（LangGraph 主入口） |
| POST | `/confirm` | Human-in-the-Loop 确认（同意/拒绝重规划） |
| POST | `/resume/{session_id}` | 确认后继续流式输出 |
| POST | `/replan/{goal_id}` | 手动触发目标重规划 |
| POST | `/replan/{goal_id}/execute` | 执行具体重规划选项 |
| POST | `/macro-plan/{goal_id}` | 生成/重新生成宏观计划（见 § 3 详述） |
| GET | `/plan-context/{goal_id}` | 获取计划生成前置上下文（KB 概览 + AI 初始理解） |
| GET | `/daily-brief` | 获取今日简报（优先读 DB 缓存） |
| GET | `/daily-brief/goal/{goal_id}` | 单目标重新生成复习题 |
| POST | `/verify` | 开始掌握度验证（生成考题） |
| POST | `/verify/answer` | 提交答案并获取评分反馈 |
| POST | `/daily-tasks` | 生成今日任务建议（所有活跃目标） |
| POST | `/reschedule/{goal_id}` | 重新规划目标日程（不换内容，换日期） |

### 1.2 `src/api/notifications.py`

前缀：`/api/v1/notifications`，所有端点需要 JWT 认证。

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `` | 获取通知列表（最近 30 条） |
| PATCH | `/mark-read` | 批量标记所有通知已读 |
| DELETE | `` | 清空所有通知 |

---

## 2. LangGraph 状态机

### 2.1 `AgentState` TypedDict

```python
class AgentState(TypedDict, total=False):
    messages: Annotated[list, add_messages]   # 对话历史（追加式）
    intent: str                                # 路由决策结果
    goal_id: str                               # 当前关联目标 ID
    user_id: str                               # 当前用户 ID
    structured_output: dict[str, Any]          # 计划等结构化输出
    pending_confirmation: dict[str, Any]       # HiL 等待确认数据
    user_confirmed: bool                       # 用户确认结果
    checkin_rate: float                        # 自然语言打卡识别出的完成率
    checkin_text: str                          # 原始打卡文本
    pending_replan: bool                       # 确认后是否执行重规划
    debt_items: list[dict[str, Any]]           # 当前目标学习债务（chat 节点用）
```

### 2.2 图结构

```
START
  └── identify_intent
        ├── goal_setup  → setup_goal → END
        ├── checkin     → checkin    → END
        ├── replan_request → replan_chat → confirm_replan → END
        ├── verification → verify → END
        └── chat        → chat
                            ├── (tools_condition) → chat_tools → chat
                            └── END
```

**检查点存储**：`MemorySaver`（进程内存），`thread_id = f"user_{user_id}_{session_id}"`。

**构建函数**（`src/core/agent/graph.py`）：

```python
def _build_structure() -> StateGraph
```
注册所有节点（intent/planner/chat/checkin/verify/replan_chat/confirm_replan）、连接有向边、绑定 `MemorySaver` 检查点，返回编译好的 `StateGraph`。全局只构建一次，结果赋值给 `agent`。

```python
def _route(state: AgentState) -> str
```
读取 `state["intent"]`，映射到对应节点名称（`goal_setup / checkin / replan_request / verification / chat`），未匹配时默认返回 `"chat"`。作为 `identify_intent` 节点之后的条件边函数。

### 2.3 Intent 路由逻辑（`src/core/agent/nodes/intent.py`）

`identify_intent` 节点读取最新用户消息，通过 DeepSeek（`smart_model_name`）判断意图：

| 意图值 | 触发条件示例 |
|--------|------------|
| `goal_setup` | 「帮我制定计划」「CPA备考」「学习目标」 |
| `checkin` | 「今天完成了」「打卡」「学了两小时」 |
| `replan_request` | 「最近进度落后」「调整计划」「重新规划」 |
| `verification` | 「检验一下」「出道题考我」 |
| `chat` | 默认兜底，普通问答 |

**`_keyword_intent(text: str) -> str | None`**（`nodes/intent.py:36`）：  
按关键词优先级顺序匹配意图（replan_request → verification → checkin → goal_setup），命中则直接返回意图字符串，避免 LLM 调用。未命中返回 `None`，触发 DeepSeek 分类。

**命中率估算依据**：PlanPilot 是领域受限的学习助手，用户意图词汇高度可预测（"打卡/完成/学了" → checkin，"调整/重规划/落后" → replan_request 等）。此类专用域关键词匹配在文献中的典型覆盖率为 60–80%，本项目取中位估算值约 70%。

> **注意**：此处"命中率"是**覆盖率**（coverage），即关键词匹配返回非 None 的消息占比，不等于**准确率**（accuracy，返回值正确的占比）。两者独立：高覆盖低准确会引入错误路由。

**如何实测**：  
1. 收集 100–200 条真实用户消息（或人工编写覆盖各意图的样本）  
2. 对每条消息分别运行：`_keyword_intent(text)` 和 DeepSeek 分类（作为 ground truth）  
3. 计算覆盖率 = 非 None 条数 / 总条数；准确率 = 命中且与 ground truth 一致条数 / 命中条数  

**资源估算**：100 条消息 × 约 50 tokens/条 = ~5000 tokens DeepSeek 调用（ground truth 标注），约 <0.01 RMB；人工核查约 20–30 分钟；若全自动与 ground truth 对比则约 5 分钟脚本运行时间。

---

## 3. 七个节点详解

### 3.1 `intent`（`nodes/intent.py`）

- **输入**：`AgentState.messages`（最新用户消息）
- **输出**：`AgentState.intent`（字符串）
- **模型**：`smart_model_name`（DeepSeek）
- **实现**：先做关键词快速匹配，命中率低时调用 LLM 分类

### 3.2 `planner`（`nodes/planner.py`）

- **意图**：`goal_setup`
- **职责**：引导用户完成目标信息收集（类型/截止日/每日时长/当前水平），生成宏观计划框架
- **输出**：`AgentState.structured_output`（phases + tasks 树）
- **模型**：`smart_model_name`（DeepSeek），结构化输出

### 3.3 `chat`（`nodes/chat.py`）

- **意图**：`chat`（兜底）
- **职责**：普通问答，感知当前目标、学习债务、进度上下文
- **债务感知**：
  ```python
  async def _get_open_debts(state: AgentState) -> list[dict]:
      if state.get("debt_items"):            # 优先使用传入的 debt_items
          return state["debt_items"]
      # 否则查 DB：LearningDebt WHERE goal_id=state.goal_id AND status="open" LIMIT 5
  ```
- **动态 System Prompt**：若存在未解决债务，在基础提示词后追加：
  ```
  【当前学习债务】
  - [high] 数据结构树形结构（预计 2.0 小时）
  - [medium] 贪心算法练习（预计 1.5 小时）
  ```
- **工具**：绑定 `chat_tools`（Tavily 搜索等），支持 `tools_condition` 条件跳转

### 3.4 `checkin`（`nodes/checkin.py`）

- **意图**：`checkin`
- **职责**：从自然语言中提取打卡完成率，生成鼓励反馈
- **输出**：`AgentState.checkin_rate`（0.0–1.0）、`AgentState.checkin_text`

**`_estimate_rate(text: str) -> float`**（`nodes/checkin.py:27`）：  
按关键词逆序优先级（barely_done < half_done < mostly_done < all_done）匹配文本，返回对应完成率（0.1 / 0.5 / 0.8 / 1.0）。作为 LLM 提取前的快速路径；若无关键词命中，由 LLM 从语义中判断比例。

### 3.5 `verify`（`nodes/verify.py`）

- **意图**：`verification`
- **职责**：在对话流中出题验证，生成问题并评估回答
- **注意**：简单验证走节点；复杂的独立验证（含掌握度写入）走 `/verify` + `/verify/answer` 端点

### 3.6 `replan_chat`（`nodes/replan_chat.py`）

- **意图**：`replan_request`
- **职责**：分析偏差原因，生成 option_a（延期）/ option_b（压缩） 两套重规划方案
- **输出**：`AgentState.pending_confirmation`

### 3.7 `confirm_replan`（`nodes/confirm_replan.py`）

- **前置**：`replan_chat` 节点
- **职责**：检查 `user_confirmed` 状态，若为 True 则设置 `pending_replan=True`，告知用户即将执行
- **HiL 机制**：图在此节点前通过 `aupdate_state` 注入确认结果（见 `/confirm` 端点）

---

## 4. SSE 流式协议

`POST /stream` 返回 `text/event-stream`，每个消息遵循 SSE 标准格式（`event:` + `data:` 分行）。

| 事件名 | data 字段 | 触发时机 |
|--------|-----------|---------|
| `token` | `{"text": "..."}` | LLM 逐 token 流式输出 |
| `tool_start` | `{"tool": "工具名"}` | chat 节点调用 tool 开始 |
| `tool_end` | `{}` | tool 调用结束 |
| `structured` | `{"phases": [...], "total_tasks": N}` | planner 节点生成完整计划 |
| `confirmation_needed` | `{"type": "replan", "goal_id": "...", "session_id": "..."}` | 重规划需用户确认 |
| `plan_saved` | `{"goal_id": "..."}` | 新目标计划自动保存到 DB |
| `checkin_saved` | `{"goal_id": "...", "completion_rate": 0.8}` | 自然语言打卡记录写入 DB |
| `replan_options` | `{"goal_id": "...", "option_a": {...}, "option_b": {...}}` | 重规划两套方案生成完毕 |
| `replan_done` | `{"tasks": [...]}` | 重规划任务重新创建完毕 |
| `done` | `{}` | 流结束 |
| `error` | `{"message": "..."}` | 异常（HTTP 状态码仍为 200） |

**前端解析关键**：需维护 `currentEvent` 变量，`event:` 行更新它，`data:` 行按 `currentEvent` 分发。

---

## 5. 关键路由实现说明

### 5.1 `POST /stream`

```python
class StreamRequest(BaseModel):
    message: str
    goal_id: str | None = None
    session_id: str          # 用于 thread_id 隔离
```

**完整数据流**：
1. 构建 `state_input = { messages: [HumanMessage(message)], user_id, goal_id }`
2. `agent.astream_events(state_input, config, version="v2")` 订阅事件流
3. 按事件类型分发：`on_chat_model_stream` → `token`；`on_tool_start/end` → 对应事件；`on_chain_end("setup_goal")` → `structured`
4. 流结束后检查 `final_state.next`：若含 `confirm_replan` 则发送 `confirmation_needed` 并 return
5. 自动处理副作用：保存计划、写入打卡、触发重规划选项

### 5.2 `POST /confirm`

```python
class ConfirmRequest(BaseModel):
    session_id: str
    confirmed: bool
```

调用 `agent.aupdate_state(config, {"user_confirmed": confirmed, "pending_confirmation": None})`，将确认结果注入到暂停的 LangGraph 线程，之后前端调用 `/resume/{session_id}` 继续执行。

### 5.3 `POST /macro-plan/{goal_id}`（2026-07-23 更新）

**请求体**（全部可选）：
```json
{
  "kb_mode": "kb_only" | "kb_reference" | "no_kb",
  "user_intent_supplement": "我已经学过基础语法，希望重点练习项目实战，跳过基础理论部分",
  "pacing_mode": "fixed" | "auto"
}
```

**参数说明**：

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `kb_mode` | str | `"no_kb"` | 知识库引用策略，见下 |
| `user_intent_supplement` | str | `""` | 用户补充意图，直接注入 prompt |
| `pacing_mode` | str | `"fixed"` | 节奏模式，`"auto"` 时按 KB 字数估算 |

**kb_mode 三种策略**：
- `kb_only`：严格基于知识库内容生成，Prompt 中加"禁止引入库外知识"约束
- `kb_reference`：知识库作为补充参考，AI 可结合外部知识扩充
- `no_kb`：完全不引用知识库内容，仅依赖目标描述和通用知识

**按目标类型的 KB 注入策略差异（2026-07-23 更新，扩展至全 6 类）**：

```python
is_exam_type = goal_type in ("exam", "certification")

if kb_mode == "kb_reference" and has_kb_content:
    if is_exam_type:
        kb_instruction = "严格按KB文档章节结构划分阶段，覆盖率为首要指标..."
    elif goal_type == "skill":
        kb_instruction = "KB作为主要教材，结合实战练习，以项目驱动为主..."
    elif goal_type == "reading":
        kb_instruction = "按章节逐步精读，每章做笔记/摘要，关注理解深度而非速度..."
    elif goal_type == "language":
        kb_instruction = "大量输入（听力+阅读）为主，词汇积累+语法系统打底..."
    elif goal_type == "habit":
        kb_instruction = "从最小行为开始逐步递增，固定时间地点形成条件反射..."
elif not has_kb_content and not is_exam_type:
    # 无 KB 时按类型提供基础指导（skill/reading/language/habit 各有专属文字）
    kb_instruction = _type_specific_no_kb_guidance(goal_type)
```

各类型策略重点：`exam/certification` → 覆盖率；`skill` → 项目驱动；`reading` → 逐章精读+笔记；`language` → 大量输入；`habit` → 最小行为起步。

**pacing_mode auto 逻辑（2026-07-23 新增）**：

```python
if pacing_mode == "auto" and total_kb_chars > 0:
    kb_read_hours = round(total_kb_chars / 20000, 1)  # 中文约 20000 字/小时
    pacing_note = f"知识库总计约{total_kb_chars}字，按正常阅读速度约需{kb_read_hours}小时..."
    # 注入 prompt，让 AI 在分配任务时参考实际内容量
```

**user_intent_supplement 注入位置**：

```python
if user_intent_supplement:
    intent_section = f"""
【用户补充意图（高优先级约束）】
{user_intent_supplement}
请严格遵循以上意图进行规划，必要时可调整标准学习节奏。
"""
```

**KB 信息获取策略升级（2026-07-23）**：

旧版：取前 10 条知识条目，每条截断 300 字 content 注入 prompt。
新版：取全部 items，每条只注入 `title + char_count`（不注入 content），让 AI 获取全局视野：

```python
kb_overview_text = "\n".join([
    f"- 《{item.title}》 约{len(item.content or '')}字"
    for item in kb_items
])
```

**完整处理流程**：
1. 将旧 `is_current=True` 计划标记为 False
2. 读取 goal 的 `work_schedule`、`kb_id`、`type` 元数据
3. 若 `kb_mode != "no_kb"` 且目标有关联 KB，取全部 items 的 title + char_count
4. 调用 `_get_available_dates(today, deadline, work_schedule)` 计算可学日期列表
5. 构建 Prompt（依次注入：目标信息 → KB 概览 → 用户意图 → 节奏说明 → 类型策略）
6. 调用 DeepSeek，解析 JSON → 创建 `Plan` 记录 + 批量创建 `Task`
7. 返回含 `plan_id / start_date / estimated_completion_date / phases` 的结构化响应

**核心辅助函数**：

| 函数 | 作用 |
|------|------|
| `_get_available_dates(start, deadline, work_schedule)` | 生成可用日期列表（weekday=排周末，weekend=排工作日） |
| `_distribute_tasks_by_day(tasks, dates, daily_hours)` | 按每日时长上限将任务分配到具体日期 |
| `_match_kb_refs(kb_items, task_title)` | 通过余弦相似度匹配相关知识条目 |

---

### 5.3b `GET /plan-context/{goal_id}`（2026-07-23 新增）

**用途**：在计划生成弹窗的步骤一（选择 KB 模式）→ 步骤二（收集意图）的过渡时调用，加载 KB 文档概览和 AI 初步理解。

**返回格式**：
```json
{
  "kb_overview": [
    {
      "title": "Python从入门到实践",
      "char_count": 120000,
      "estimated_pages": 200
    }
  ],
  "initial_understanding": "你正在备考考研英语，知识库中包含真题集和词汇书，建议按模块分阶段复习…"
}
```

**实现细节**：
- `estimated_pages = max(1, char_count // 600)`（约 600 字/页）
- `initial_understanding` 通过 LLM 轻量调用生成（max_tokens=200），prompt 为：
  ```
  用户的{type_label}目标是「{goal.title}」，截止日期 {deadline}，每天投入 {daily_hours} 小时。
  知识库包含：{kb_titles}。请用1-2句话说明你对该目标的初步理解。
  ```
- KB 为空时 `kb_overview` 返回空列表，`initial_understanding` 基于目标信息生成
- 前端据此在步骤二中展示"AI 的初步理解"蓝色卡片和"知识库文档"灰色卡片

### 5.4 `GET /daily-brief`

```
参数：?refresh=false&count=3
```

**缓存优先策略**：
1. `refresh=False`（默认）：查 `daily_brief_caches WHERE user_id=... AND date=今天`，命中则直接返回
2. 未命中或 `refresh=True`：调用 `_build_daily_brief_for_user()` 生成 → UPSERT 到 DB（`is_read` 不重置）
3. 返回 `DailyBriefOut`（或 `null`，若用户无活跃目标或近期打卡）

**`DailyBriefOut` Schema**：

```python
class DailyBriefOut(BaseModel):
    date: str                        # YYYY-MM-DD
    summary: str                     # LLM 生成的今日摘要
    goalReviews: list[GoalReview]    # 各目标复习题列表
    insight: str                     # 跨目标洞察
    recommendedAction: str           # 今日行动建议
```

**`GoalReview` Schema**：

```python
class GoalReview(BaseModel):
    goalId: str
    goalTitle: str
    questions: list[ReviewQuestion]  # 3–10 道复习题

class ReviewQuestion(BaseModel):
    id: str
    question: str    # ≤30 字
    hint: str        # 答题关键点，≤60 字
```

### 5.5 `POST /verify` + `POST /verify/answer`

**两阶段验证流程**：

```
/verify                          /verify/answer
  ↓                                  ↓
生成考题（DeepSeek）              评分（DeepSeek）
返回 question + answer_hint      返回 passed/score/feedback
写入 _verify_cache[uid:task_id]  若 passed → task.mastery_level="L3"或"L4"
```

**评分规则**：
- score ≥ 90 → `mastery_level="L4"`，`passed=true`
- score 60–89 → `mastery_level="L3"`，`passed=true`，score < 80 时返回 `follow_up` 追问
- score < 60 → `passed=false`，返回 `suggestion` 复习建议（3条）

**注意**：`_verify_cache` 为进程级内存 dict，重启后失效；前端 `VerificationDialog` 在 `startVerification` 失败时使用 fallback 默认问题。

### 5.6 `POST /replan/{goal_id}/execute`

```python
class ReplanExecuteBody(BaseModel):
    option: str   # "option_a" | "option_b"
```

调用 `_execute_replan_option(db, user_id, goal_id, option)` 修改现有任务的 `scheduled_date`，而非重新生成任务内容。

---

## 6. 通知路由详解

### 6.1 `NotificationItem` Schema

```python
class NotificationItem(BaseModel):
    id: str               # daily_brief_cache.id
    date: str             # YYYY-MM-DD
    summary: str          # content["summary"] 字段（DailyBriefOut.summary）
    is_read: bool
    generated_at: str     # ISO 8601
    generated_by: str     # "celery" | "on_demand"
```

### 6.2 `GET /api/v1/notifications`

查询当前用户最近 30 条 `DailyBriefCache` 记录（按日期倒序），返回：

```python
class NotificationsResponse(BaseModel):
    unread_count: int            # sum(not is_read)
    items: list[NotificationItem]
```

### 6.3 `PATCH /api/v1/notifications/mark-read`

查询所有 `is_read=False` 的记录，批量设置 `is_read=True`，commit 后返回 `{"status": "ok"}`。

### 6.4 `DELETE /api/v1/notifications`

执行 `DELETE FROM daily_brief_caches WHERE user_id=...`，清空当前用户全部简报缓存和通知。

---

## 7. 内部辅助函数

| 函数 | 位置 | 说明 |
|------|------|------|
| `_build_structure()` | graph.py | 构建 LangGraph 状态图并编译，全局单例 |
| `_route(state)` | graph.py | 条件边函数，读取 `intent` 字段路由到对应节点 |
| `_keyword_intent(text)` | nodes/intent.py | 关键词快速意图识别，命中率～70%，未命中返回 None |
| `_estimate_rate(text)` | nodes/checkin.py | 关键词快速完成率提取（0.1/0.5/0.8/1.0） |
| `_ddg_search(query)` | core/agent/tools.py | DuckDuckGo 搜索，返回最多5条文本结果 |
| `_find_active_goal(db, user_id)` | agent.py | 查最近创建的 active Goal |
| `_save_checkin(db, user_id, goal_id, text, rate)` | agent.py | UPSERT 打卡记录 |
| `_generate_replan_options(goal, tasks, checkins)` | agent.py | DeepSeek 生成双轨重规划方案 |
| `_execute_replan_option(db, user_id, goal_id, option)` | agent.py | 更新任务日期执行方案 |
| `_do_replan(db, user_id, goal_id)` | agent.py | 无选项时直接重规划（重新排期）|
| `_cosine_sim(a, b)` | agent.py | 纯 Python 余弦相似度 |
| `_get_embedding(text)` | agent.py | 调用 OpenAI text-embedding-3-small |
| `_match_kb_refs(kb_items, task_title)` | agent.py | 匹配任务相关知识条目（embedding 优先，fallback 关键词）|
| `_save_plan(db, user_id, message, structured)` | agent.py | 从会话自动提取并保存计划 |
| `_build_daily_brief_for_user(user_id, db, count)` | agent.py | 生成完整简报 dict（Celery 和端点共用）|
| `_upsert_brief_cache(user_id, db, brief_dict, generated_by)` | agent.py | PostgreSQL INSERT … ON CONFLICT DO UPDATE |
| `_generate_review_questions(goal_title, tasks, kb_items, count)` | agent.py | DeepSeek 生成复习题，失败时 `_fallback_questions` 兜底 |
