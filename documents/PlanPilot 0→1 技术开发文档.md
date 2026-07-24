PlanPilot 是一款以 Agent 为驱动内核的 To C / To B SaaS 应用（App），用户感知到的是"AI 教练产品"，底层跑的是 LangGraph 驱动的 Agent 引擎。

商业交付形态是app；技术架构是一个 agent-powered app。

# PlanPilot 0→1 技术开发文档

**文档类型：** 技术实施指南
**版本：** v1.0
**适用阶段：** MVP（0→1）

---

## 一、技术栈全景

<div align="center">

| 架构层级 | 核心技术栈 |
| :---: | :--- |
| **🎨 前端应用层** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Next.js 14 · TypeScript · Tailwind · shadcn/ui · Zustand · TanStack Query · SSE streaming |
| **🚦 API 网关层** | FastAPI · Pydantic v2 · JWT Auth · SlowAPI |
| **🤖 Agent 引擎** | LangGraph · LangChain Tools · mem0 |
| **🧠 LLM 核心层** | Claude 3.5 Sonnet / Haiku · text-embedding-3-small |
| **🛠️ 外部工具集成** | Tavily Search · Jina Reader · PyMuPDF |
| **💾 数据存储层** | PostgreSQL 16 + pgvector · Redis 7 · S3 / R2 |
| **⏰ 任务调度** | Celery + Redis Broker · APScheduler |
| **📊 可观测性** | Langfuse · Prometheus · Grafana · structlog |
| **🚀 部署与 CI/CD** | Docker Compose (dev) · Railway (MVP prod) <br> GitHub Actions CI/CD |

</div>

**技术选型依据：**

| 选择 | 理由 |
|------|------|
| FastAPI | 原生异步，Pydantic v2 性能最强，OpenAPI 自动生成 |
| LangGraph | 有状态图，原生支持 human-in-the-loop，PostgreSQL checkpointer |
| pgvector | 知识库向量检索直接在主库，无需维护独立向量数据库 |
| Next.js App Router | Server Components + RSC streaming，SSE 支持最完整 |
| Railway | MVP阶段无需 K8s，$5-20/月，PostgreSQL 一键开通 |

---

## 二、Monorepo 项目结构

```
planpilot/
├── apps/
│   ├── web/                # Next.js 前端
│   │   ├── app/
│   │   │   ├── (auth)/
│   │   │   │   ├── login/page.tsx
│   │   │   │   └── register/page.tsx
│   │   │   ├── (dashboard)/
│   │   │   │   ├── goals/
│   │   │   │   │   ├── [id]/page.tsx    # 目标详情+每日任务
│   │   │   │   │   └── new/page.tsx     # 新建目标（含知识库同步创建 + 计划模式选择）
│   │   │   │   ├── checkin/page.tsx     # 专用打卡页（/dashboard/checkin）
│   │   │   │   ├── knowledge/page.tsx   # 知识库管理
│   │   │   │   └── layout.tsx
│   │   │   └── api/
│   │   │       └── stream/route.ts      # SSE 代理（避免 CORS）
│   │   ├── components/
│   │   │   ├── agent/
│   │   │   │   ├── ChatWindow.tsx       # 流式对话窗口
│   │   │   │   ├── PlanCard.tsx         # 计划渲染卡片
│   │   │   │   ├── CheckinForm.tsx      # 每日打卡表单（daily 逐任务掌握度模式）
│   │   │   │   └── VerificationDialog.tsx
│   │   │   └── ui/                # shadcn/ui 组件
│   │   ├── lib/
│   │   │   ├── api.ts                   # API 请求封装
│   │   │   └── stores/
│   │   │       ├── goalStore.ts         # Zustand 目标状态
│   │   │       └── chatStore.ts         # Zustand 对话状态
│   │   └── package.json
│   │
│   └── api/                             # FastAPI 后端
│       ├── app/
│       │   ├── api/
│       │   │   └── v1/
│       │   │       ├── auth.py          # 注册/登录/刷新 token
│       │   │       ├── goals.py         # 目标 CRUD
│       │   │       ├── plans.py         # 计划查询/确认
│       │   │       ├── checkin.py       # 每日 check-in
│       │   │       ├── knowledge.py     # 知识库上传/查询
│       │   │       └── agent.py         # Agent 对话（SSE）
│       │   ├── core/
│       │   │   ├── agent/
│       │   │   │   ├── graph.py         # LangGraph 状态图定义
│       │   │   │   ├── state.py         # AgentState 定义
│       │   │   │   ├── nodes/
│       │   │   │   │   ├── intent.py    # 意图识别节点
│       │   │   │   │   ├── planner.py   # 计划生成节点
│       │   │   │   │   ├── replan.py    # 重规划节点
│       │   │   │   │   ├── checkin.py   # check-in 处理节点
│       │   │   │   │   ├── verify.py    # 验收节点
│       │   │   │   │   └── chat.py      # 自由对话节点
│       │   │   │   └── tools/
│       │   │   │       ├── search.py    # Tavily 搜索
│       │   │   │       ├── kb_search.py # 知识库RAG 检索
│       │   │   │       ├── kb_write.py  # 知识库写入
│       │   │   │       ├── plan_ops.py  # 计划生成/更新
│       │   │   │       └── debt.py      # 学习债务管理
│       │   │   ├── prompts/
│       │   │   │   ├── planner.py
│       │   │   │   ├── replan.py
│       │   │   │   ├── verify.py
│       │   │   │   └── chat.py
│       │   │   ├── config.py            # Pydantic Settings
│       │   │   ├── database.py          # SQLAlchemy + pgvector
│       │   │   ├── cache.py             # Redis 封装
│       │   │   └── llm.py               # LLM 路由 + 重试
│       │   ├── models/                  # SQLAlchemy ORM
│       │   │   ├── user.py
│       │   │   ├── goal.py
│       │   │   ├── plan.py
│       │   │   ├── task.py
│       │   │   ├── debt.py
│       │   │   └── knowledge.py
│       │   ├── schemas/                # Pydantic 请求/响应
│       │   ├── services/
│       │   │   ├── plan_service.py
│       │   │   ├── checkin_service.py
│       │   │   └── kb_service.py
│       │   └── main.py
│       ├── alembic/                     # 数据库迁移
│├── worker/
│       │   ├── celery_app.py            # Celery 配置
│       │   └── tasks/
│       │       ├── notifications.py     # 推送任务
│       │       ├── kb_process.py        # 异步文件处理
│       │       └── replan_check.py      # 定时偏差检测
│       ├── tests/
│       └── pyproject.toml
│
├── packages/
│   └── shared-types/                    # 前后端共享类型
├── docker-compose.yml
├── docker-compose.prod.yml
└── .github/workflows/
    ├── ci.yml
    └── deploy.yml
```

---

## 三、数据库设计与迁移

### 3.1 初始化 pgvector

```sql
-- alembic/versions/001_init.sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
```

### 3.2 核心表结构

```python
# app/models/base.py
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import func
import uuid
from datetime import datetime

class Base(DeclarativeBase):
    pass

# app/models/user.py
from sqlalchemy import Column, String, DateTime, JSON
from sqlalchemy.dialects.postgresql import UUID
from .base import Base

class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    name = Column(String(100), nullable=False)
    hashed_password = Column(String(255), nullable=False)
    timezone = Column(String(50), default="Asia/Shanghai")
    notification_prefs = Column(JSON, default={
        "daily_reminder": True,
        "reminder_time": "19:00",
        "channels": ["push"]
    })
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

# app/models/goal.py
from sqlalchemy import Column, String, Date, Float, Enum, ForeignKey, JSON, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
import enum

class GoalType(str, enum.Enum):
    exam = "exam"
    certification = "certification"
    skill = "skill"

class GoalStatus(str, enum.Enum):
    active = "active"
    completed = "completed"
    paused = "paused"
    abandoned = "abandoned"

class Goal(Base):
    __tablename__ = "goals"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    type = Column(Enum(GoalType), nullable=False)
    title = Column(String(255), nullable=False)
    deadline = Column(Date, nullable=False)
    daily_hours = Column(Float, nullable=False)
    current_level = Column(String(50))
    status = Column(Enum(GoalStatus), default=GoalStatus.active)
    meta = Column(JSON, default={})  # 考试科目、目标分数等

    plans = relationship("Plan", back_populates="goal")
    tasks = relationship("Task", back_populates="goal")
    debts = relationship("LearningDebt", back_populates="goal")

# app/models/plan.py
class Plan(Base):
    __tablename__ = "plans"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    goal_id = Column(UUID(as_uuid=True), ForeignKey("goals.id"), nullable=False)
    version = Column(Integer, default=1)
    is_current = Column(Boolean, default=True)
    baseline = Column(JSON)# 原始计划快照
    content = Column(JSON)        # 当前计划（含所有任务）
    replan_reason = Column(Text)
    created_at = Column(DateTime, default=func.now())

# app/models/knowledge.py
from pgvector.sqlalchemy import Vector

class KnowledgeItem(Base):
    __tablename__ = "knowledge_items"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    goal_id = Column(UUID(as_uuid=True), ForeignKey("goals.id"), nullable=True)
    title = Column(Text, nullable=False)
    content = Column(Text, nullable=False)
    source_type = Column(Enum("upload", "url", "search", "system", name="source_type_enum"))
    source_url = Column(Text)
    file_path = Column(Text)   # S3 key
    tags = Column(JSON, default=[])
    embedding = Column(Vector(1536))# text-embedding-3-small
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=func.now())
```

### 3.3 向量检索查询

```python
# app/core/database.py
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from pgvector.sqlalchemy import Vector
from sqlalchemy import select, func

engine = create_async_engine(
    settings.database_url,
    pool_size=20,
    max_overflow=10,
    pool_pre_ping=True,
)

AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

async def search_knowledge(
    session: AsyncSession,
    user_id: str,
    query_embedding: list[float],
    top_k: int = 5,
    goal_id: str | None = None,
) -> list[KnowledgeItem]:
    """余弦相似度检索知识库"""
    query = (
        select(KnowledgeItem)
        .where(KnowledgeItem.user_id == user_id)
        .order_by(KnowledgeItem.embedding.cosine_distance(query_embedding))
        .limit(top_k)
    )
    if goal_id:
        query = query.where(
            (KnowledgeItem.goal_id == goal_id) | (KnowledgeItem.goal_id.is_(None))
        )
    result = await session.execute(query)
    return result.scalars().all()
```

---

## 四、LLM 路由层

```python
# app/core/llm.py
from anthropic import AsyncAnthropic
from openai import AsyncOpenAI
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
import httpx
from enum import Enum

class LLMTask(str, Enum):
    PLANNING = "planning"           # Claude 3.5 Sonnet - 长文本推理
    DIALOGUE = "dialogue"           # Claude 3 Haiku - 低延迟对话
    VERIFICATION = "verification"   # Claude 3.5 Sonnet - 细粒度评估
    EMBEDDING = "embedding"         # OpenAI text-embedding-3-small
    SUMMARY = "summary"             # Claude 3 Haiku - 批量摘要

TASK_MODEL_MAP = {
    LLMTask.PLANNING: ("anthropic", "claude-3-5-sonnet-20241022"),
    LLMTask.DIALOGUE: ("anthropic", "claude-3-haiku-20240307"),
    LLMTask.VERIFICATION: ("anthropic", "claude-3-5-sonnet-20241022"),
    LLMTask.SUMMARY: ("anthropic", "claude-3-haiku-20240307"),
}

class LLMRouter:
    def __init__(self):
        self.anthropic = AsyncAnthropic(api_key=settings.anthropic_api_key)
        self.openai = AsyncOpenAI(api_key=settings.openai_api_key)

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=8),
        retry=retry_if_exception_type((httpx.TimeoutException, Exception)),
        reraise=True,
    )
    async def complete(
        self,
        task: LLMTask,
        messages: list[dict],
        system: str = "",
        stream: bool = False,
        max_tokens: int = 4096,
    ):
        provider, model = TASK_MODEL_MAP[task]
        if provider == "anthropic":
            if stream:
                return self.anthropic.messages.stream(
                    model=model,
                    max_tokens=max_tokens,
                    system=system,
                    messages=messages,
                )
            return await self.anthropic.messages.create(
                model=model,
                max_tokens=max_tokens,
                system=system,
                messages=messages,
            )
        raise ValueError(f"Unknown provider: {provider}")

    async def embed(self, text: str) -> list[float]:
        response = await self.openai.embeddings.create(
            model="text-embedding-3-small",
            input=text,
        )
        return response.data[0].embedding

llm_router = LLMRouter()
```

---

## 五、Agent 引擎（LangGraph）

### 5.1 状态定义

```python
# app/core/agent/state.py
from typing import TypedDict, Annotated, Literal
from langgraph.graph.message import add_messages
import operator

class AgentState(TypedDict):
    # 对话历史（自动追加）
    messages: Annotated[list, add_messages]

    # 当前用户上下文
    user_id: str
    session_id: str

    # 意图路由
    intent: Literal[
        "goal_setup",
        "checkin",
        "verification",
        "replan_request",
        "knowledge_upload",
        "free_chat",
    ] | None

    # 业务数据（节点间传递）
    current_goal_id: str | None
    current_plan: dict | None
    checkin_data: dict | None
    replan_needed: bool
    debt_items: list[dict]

    # 需要人工确认的数据
    pending_confirmation: dict | None
    user_confirmed: bool | None

    # 最终输出
    response: str | None
    structured_output: dict | None   # 计划 JSON、报告等
```

### 5.2 图结构

```python
# app/core/agent/graph.py
from langgraph.graph import StateGraph, END
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from .state import AgentState
from .nodes import intent, planner, replan, checkin, verify, chat

def build_graph(checkpointer) -> StateGraph:
    graph = StateGraph(AgentState)

    # 注册节点
    graph.add_node("identify_intent", intent.node)
    graph.add_node("setup_goal", planner.setup_goal_node)
    graph.add_node("generate_plan", planner.generate_plan_node)
    graph.add_node("process_checkin", checkin.node)
    graph.add_node("detect_deviation", replan.detect_node)
    graph.add_node("replan", replan.replan_node)
    graph.add_node("confirm_replan", replan.confirm_node)   # human-in-the-loop
    graph.add_node("verify", verify.node)
    graph.add_node("chat", chat.node)

    # 入口
    graph.set_entry_point("identify_intent")

    # 意图路由
    graph.add_conditional_edges(
        "identify_intent",
        _route_by_intent,
        {
            "goal_setup": "setup_goal",
            "checkin": "process_checkin",
            "verification": "verify",
            "replan_request": "replan",
            "free_chat": "chat",
        }
    )

    # 目标设定流
    graph.add_edge("setup_goal", "generate_plan")
    graph.add_edge("generate_plan", END)

    # check-in 流：处理完后检测偏差
    graph.add_edge("process_checkin", "detect_deviation")
    graph.add_conditional_edges(
        "detect_deviation",
        lambda s: "replan" if s["replan_needed"] else END,
        {"replan": "confirm_replan", END: END}
    )

    # 重规划需要人工确认
    graph.add_edge("confirm_replan", "replan")   # 等待用户确认后继续
    graph.add_edge("replan", END)

    graph.add_edge("verify", END)
    graph.add_edge("chat", END)

    return graph.compile(
        checkpointer=checkpointer,
        interrupt_before=["confirm_replan"],# 在此节点前暂停，等待用户确认
    )

def _route_by_intent(state: AgentState) -> str:
    return state.get("intent", "free_chat")

# 异步初始化（在 lifespan 中调用）
async def create_agent():
    conn_str = settings.database_url.replace("postgresql+asyncpg", "postgresql")
    checkpointer = AsyncPostgresSaver.from_conn_string(conn_str)
    await checkpointer.setup()
    return build_graph(checkpointer)
```

### 5.3 核心节点实现

```python
# app/core/agent/nodes/planner.py
import json
from ..state import AgentState
from ...llm import llm_router, LLMTask
from ...prompts.planner import PLAN_GENERATION_PROMPT

async def generate_plan_node(state: AgentState) -> dict:
    """核心：生成结构化学习计划"""
    goal_context = state["structured_output"]# 来自 setup_goal 的目标信息

    system_prompt = PLAN_GENERATION_PROMPT.format(
        goal_title=goal_context["title"],
        deadline=goal_context["deadline"],
        daily_hours=goal_context["daily_hours"],
        current_level=goal_context.get("current_level", "未知"),
    )

    response = await llm_router.complete(
        task=LLMTask.PLANNING,
        system=system_prompt,
        messages=[{
            "role": "user",
            "content": "请根据以上信息生成完整的学习计划，以JSON 格式输出。"
        }],
        max_tokens=8192,
    )

    raw = response.content[0].text
    # 提取 JSON（防止 LLM 加前缀文本）
    plan_json = _extract_json(raw)

    return {
        "structured_output": plan_json,
        "response": "计划已生成，请确认后开始执行。",
    }


# app/core/agent/nodes/checkin.py
from datetime import date
from ..state import AgentState
from ...llm import llm_router, LLMTask
from ...tools.debt import record_debt

async def node(state: AgentState) -> dict:
    """处理每日 check-in，分析偏差"""
    checkin = state["checkin_data"]
    plan = state["current_plan"]

    # 计算完成率
    total = len(checkin["tasks"])
    completed = sum(1 for t in checkin["tasks"] if t["status"] == "completed")
    completion_rate = completed / total if total > 0 else 0

    # 记录学习债务
    skipped_tasks = [t for t in checkin["tasks"] if t["status"] == "skipped"]
    debt_items = []
    for task in skipped_tasks:
        debt = await record_debt(
            goal_id=state["current_goal_id"],
            task=task,
            reason=checkin.get("note", ""),
        )
        debt_items.append(debt)

    # 判断是否需要重规划
    replan_needed = completion_rate < 0.6and _is_persistent_deviation(state)

    # 生成鼓励性反馈
    feedback = await _generate_feedback(completion_rate, checkin, plan)

    return {
        "checkin_data": {**checkin, "completion_rate": completion_rate},
        "debt_items": debt_items,
        "replan_needed": replan_needed,
        "response": feedback,
    }

def _is_persistent_deviation(state: AgentState) -> bool:
    """连续4天完成率 < 60% 才触发重规划"""
    # 实际实现中从数据库查历史 check-in
    return False  # MVP 阶段简化


# app/core/agent/nodes/verify.py
async def node(state: AgentState) -> dict:
    """验收对话：区分完成和掌握"""
    last_task = _get_last_completed_task(state)
    if not last_task:
        return {"response": "你最近完成了哪个学习任务？我来帮你验收。"}

    # 基于知识库生成针对性验收题
    from ...tools.kb_search import search_related_content
    context = await search_related_content(
        user_id=state["user_id"],
        query=last_task["title"],
        goal_id=state["current_goal_id"],
    )

    question = await _generate_verification_question(last_task, context)

    return {
        "response": question,
        "structured_output": {"verification_in_progress": True, "task": last_task},
    }
```

### 5.4 工具实现

```python
# app/core/agent/tools/search.py
from tavily import AsyncTavilyClient
from langchain_core.tools import tool

tavily = AsyncTavilyClient(api_key=settings.tavily_api_key)

@tool
async def web_search(query: str, max_results: int = 5) -> str:
    """联网搜索学习资料、考试信息、权威资源"""
    results = await tavily.search(
        query=query,
        max_results=max_results,search_depth="advanced",
        include_answer=True,
    )
    formatted = []
    for r in results.get("results", []):
        formatted.append(f"**{r['title']}**\n{r['content']}\n来源：{r['url']}")
    return "\n\n---\n\n".join(formatted)


# app/core/agent/tools/kb_search.py
from ...database import search_knowledge, AsyncSessionLocal
from ...llm import llm_router

@tool
async def kb_search(user_id: str, query: str, goal_id: str = None) -> str:
    """从个人知识库中检索相关内容（优先于联网搜索）"""
    embedding = await llm_router.embed(query)
    async with AsyncSessionLocal() as session:
        items = await search_knowledge(
            session=session,
            user_id=user_id,
            query_embedding=embedding,
            top_k=5,
            goal_id=goal_id,
        )
    if not items:
        return "知识库中暂无相关内容"
    return "\n\n".join([
        f"**{item.title}**\n{item.content[:500]}..."
        for item in items
    ])
```

---

## 六、API 层

### 6.1 Agent 对话端点（SSE 流式）

```python
# app/api/v1/agent.py
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sse_starlette.sse import EventSourceResponse
import json
import asyncio

router = APIRouter(prefix="/agent", tags=["agent"])

@router.post("/stream")
async def agent_stream(
    request: AgentRequest,
    current_user: User = Depends(get_current_user),
    agent = Depends(get_agent),
):
    """流式 Agent 对话端点"""
    thread_id = f"user_{current_user.id}_session_{request.session_id}"

    config = {
        "configurable": {"thread_id": thread_id},
        "recursion_limit": 25,
    }

    async def generate():
        try:
            async for event in agent.astream_events(
                {
                    "messages": [{"role": "user", "content": request.message}],
                    "user_id": str(current_user.id),
                    "session_id": request.session_id,
                    "current_goal_id": request.goal_id,
                },
                config=config,
                version="v2",
            ):
                event_type = event["event"]

                # LLM token 流式输出
                if event_type == "on_chat_model_stream":
                    chunk = event["data"]["chunk"].content
                    if chunk:
                        yield {
                            "event": "token",
                            "data": json.dumps({"text": chunk})
                        }

                # 工具调用通知（前端显示"正在搜索..."）
                elif event_type == "on_tool_start":
                    yield {
                "event": "tool_start",
                        "data": json.dumps({"tool": event["name"]})
                    }

                # 结构化输出（计划 JSON、报告等）
                elif event_type == "on_chain_end":
                    output = event["data"].get("output", {})
                    if isinstance(output, dict) and output.get("structured_output"):
                        yield {
                            "event": "structured",
                            "data": json.dumps(output["structured_output"])
                        }

                # 需要用户确认（重规划等）
                elif event_type == "on_chain_end" and "__interrupt__" in str(event):
                    pending = event["data"].get("output", {}).get("pending_confirmation")
                    if pending:
                        yield {
                            "event": "confirmation_required",
                            "data": json.dumps(pending)
                        }yield {"event": "done", "data": "{}"}except Exception as e:
            yield {"event": "error", "data": json.dumps({"message": str(e)})}

    return EventSourceResponse(generate())


@router.post("/confirm")
async def confirm_action(
    request: ConfirmRequest,
    current_user: User = Depends(get_current_user),
    agent = Depends(get_agent),
):
    """用户确认重规划等需要审批的操作后继续执行"""
    thread_id = f"user_{current_user.id}_session_{request.session_id}"
    config = {"configurable": {"thread_id": thread_id}}

    # 注入确认结果并恢复图执行
    await agent.aupdate_state(
        config,
        {"user_confirmed": request.confirmed, "pending_confirmation": None},
    )
    # 继续执行被中断的图
    result = await agent.ainvoke(None, config=config)
    return {"status": "resumed", "response": result.get("response")}
```

### 6.2 Check-in 端点

```python
# app/api/v1/checkin.py
from fastapi import APIRouter, Depends
from app.schemas.checkin import CheckinRequest, CheckinResponse
from app.services.checkin_service import CheckinService

router = APIRouter(prefix="/checkin", tags=["checkin"])

@router.post("/{goal_id}", response_model=CheckinResponse)
async def submit_checkin(
    goal_id: str,
    request: CheckinRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    三种输入方式统一处理：
    - mode="task_list": tasks[]逐项勾选
    - mode="quick":quick_status 快捷选项
    - mode="natural":   text 自然语言（需先过LLM 结构化）
    """
    service = CheckinService(db)
    result = await service.process(
        user_id=str(current_user.id),
        goal_id=goal_id,
        request=request,
    )
    return result


# app/services/checkin_service.py
class CheckinService:
    async def process(self, user_id: str, goal_id: str, request: CheckinRequest):
        # 自然语言模式：先结构化
        if request.mode == "natural":
            tasks = await self._parse_natural_input(request.text, goal_id)
        elif request.mode == "quick":
            tasks = await self._expand_quick_status(request.quick_status, goal_id)
        else:
            tasks = request.tasks

        # 持久化 check-in 记录
        await self._save_tasks(tasks, goal_id)

        # 计算统计数据
        stats = self._compute_stats(tasks)

        # 触发异步偏差检测（不阻塞响应）
        from worker.tasks.replan_check import check_deviation
        check_deviation.delay(user_id, goal_id)

        return CheckinResponse(stats=stats, feedback=await self._gen_feedback(stats))

    async def _parse_natural_input(self, text: str, goal_id: str) -> list[dict]:
        """用LLM 将自然语言 check-in 结构化为任务列表"""
        today_tasks = await self._get_today_tasks(goal_id)
        prompt = f"""
今日计划任务：{json.dumps(today_tasks, ensure_ascii=False)}

用户描述：{text}

请将用户的描述映射到对应任务，返回每个任务的完成状态。
输出 JSON 格式：[{{"task_id": "...", "status": "completed|partial|skipped", "note": "..."}}]
"""
        response = await llm_router.complete(
            task=LLMTask.DIALOGUE,
            messages=[{"role": "user", "content": prompt}],
        )
        return json.loads(_extract_json(response.content[0].text))
```

### 6.3 知识库端点

```python
# app/api/v1/knowledge.py
from fastapi import APIRouter,UploadFile, File, Form, Depends
from app.services.kb_service import KnowledgeService

router = APIRouter(prefix="/knowledge", tags=["knowledge"])

@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    goal_id: str = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """上传文件到知识库（异步处理）"""
    # 1. 先存S3，立即返回任务 ID
    s3_key = f"{current_user.id}/uploads/{uuid4()}_{file.filename}"
    await s3_client.upload_fileobj(file.file, settings.s3_bucket, s3_key)

    # 2. 派发Celery 任务异步处理（分块+向量化）
    from worker.tasks.kb_process import process_knowledge_file
    task = process_knowledge_file.delay(
        user_id=str(current_user.id),
        goal_id=goal_id,
        s3_key=s3_key,
        filename=file.filename,
        content_type=file.content_type,
    )
    return {"task_id": task.id, "status": "processing"}


@router.post("/url")
async def add_url(
    request: AddUrlRequest,
    current_user: User = Depends(get_current_user),
):
    """解析网页 URL 并存入知识库"""
    from worker.tasks.kb_process import process_url
    task = process_url.delay(
        user_id=str(current_user.id),
        goal_id=request.goal_id,
        url=str(request.url),
    )
    return {"task_id": task.id, "status": "processing"}


@router.get("/search")
async def search(
    q: str,
    goal_id: str = None,
    limit: int = 5,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """语义搜索知识库"""
    service = KnowledgeService(db)
    results = await service.search(
        user_id=str(current_user.id),
        query=q,
        goal_id=goal_id,
        top_k=limit,
    )
    return {"results": results}
```

---

## 七、异步任务（Celery Workers）

```python
# worker/celery_app.py
from celery import Celery
from celery.schedules import crontab

celery_app = Celery(
    "planpilot",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["worker.tasks.kb_process", "worker.tasks.notifications", "worker.tasks.replan_check"],
)

celery_app.conf.beat_schedule = {
    # 每天早上 8:30 发送当日任务推送（按用户时区分批）
    "send-daily-reminders": {
        "task": "worker.tasks.notifications.send_daily_reminders",
        "schedule": crontab(hour=0, minute=30),  # UTC 0:30 = 北京时间 8:30
    },
    # 每晚 23:00 检查当天未check-in 的用户
    "check-unchecked-users": {
        "task": "worker.tasks.notifications.remind_checkin",
        "schedule": crontab(hour=15, minute=0),  # UTC 15:00 = 北京时间 23:00
    },
}


# worker/tasks/kb_process.py
from worker.celery_app import celery_app
import fitz  # PyMuPDF
import httpx

@celery_app.task(bind=True, max_retries=3)
def process_knowledge_file(self, user_id: str, goal_id: str, s3_key: str, filename: str, content_type: str):
    """文件处理流水线：解析 → 分块 → 向量化 → 写库"""
    import asyncio
    asyncio.run(_async_process_file(user_id, goal_id, s3_key, filename, content_type))

async def _async_process_file(user_id, goal_id, s3_key, filename, content_type):
    # 1. 从 S3 下载文件
    file_bytes = await s3_client.download(s3_key)

    # 2. 解析文本
    if content_type == "application/pdf":
        text = _parse_pdf(file_bytes)
    elif "word" in content_type:
        text = _parse_docx(file_bytes)
    else:
        text = file_bytes.decode("utf-8", errors="ignore")

    # 3. 语义分块（约 500 tokens，保留段落完整性）
    chunks = _semantic_chunk(text, max_tokens=500, overlap=50)

    # 4. 批量向量化 + 写入知识库
    async with AsyncSessionLocal() as session:
        for i, chunk in enumerate(chunks):
            embedding = await llm_router.embed(chunk)
            item = KnowledgeItem(
                user_id=user_id,
                goal_id=goal_id,
                title=f"{filename} -第{i+1}段",
                content=chunk,
                source_type="upload",
                file_path=s3_key,
                embedding=embedding,
                tags=await _auto_tag(chunk),
            )
            session.add(item)
        await session.commit()


def _parse_pdf(file_bytes: bytes) -> str:
    doc = fitz.open(stream=file_bytes, filetype="pdf")
    return "\n\n".join(page.get_text() for page in doc)

def _semantic_chunk(text: str, max_tokens: int = 500, overlap: int = 50) -> list[str]:
    """按段落边界分块，避免在句子中间截断"""
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks, current, current_len = [], [], 0
    for para in paragraphs:
        para_len = len(para) // 3# 粗略 token 估算
        if current_len + para_len > max_tokens and current:
            chunks.append("\n\n".join(current))
            # overlap: 保留最后一段进入下一块
            current = current[-1:] if overlap > 0 else []
            current_len = len(current[0]) // 3 if current else 0
        current.append(para)
        current_len += para_len
    if current:
        chunks.append("\n\n".join(current))
    return chunks


# worker/tasks/notifications.py
@celery_app.task
def send_daily_reminders():
    """按用户时区分批发送当日任务推送"""
    import asyncio
    asyncio.run(_send_reminders())

async def _send_reminders():
    async with AsyncSessionLocal() as session:
        # 查询所有 active 用户+目标
        users_goals = await session.execute(
            select(User, Goal)
            .join(Goal, Goal.user_id == User.id)
            .where(Goal.status == "active")
        )
        for user, goal in users_goals:
            today_tasks = await _get_today_tasks(session, goal.id)
            if today_tasks:
                await _push_notification(
                    user_id=str(user.id),
                    title=f"📚 今日学习任务 · {goal.title}",
                    body=f"共{len(today_tasks)} 项任务，预计 {sum(t.estimated_mins for t in today_tasks)} 分钟",
                )
```

---

## 八、前端核心实现

### 8.1 流式对话组件

```typescript
// apps/web/components/agent/ChatWindow.tsx
"use client";
import { useState, useRef, useEffect } from "react";
import { useChatStore } from "@/lib/stores/chatStore";

interface Message {
  role: "user" | "assistant";
  content: string;
  structuredOutput?: Record<string, unknown>;
  confirmationRequired?: Record<string, unknown>;
}

export function ChatWindow({ goalId }: { goalId?: string }) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolStatus, setToolStatus] = useState<string>("");
  const [pendingConfirm, setPendingConfirm] = useState<Record<string, unknown> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionId = useRef(crypto.randomUUID());

  const sendMessage = async (text: string) => {
    if (!text.trim() || isStreaming) return;

    setMessages(prev => [...prev, { role: "user", content: text }]);
    setInput("");
    setIsStreaming(true);

    abortRef.current = new AbortController();

    // 添加 assistant 占位消息
    setMessages(prev => [...prev, { role: "assistant", content: "" }]);

    try {
      const response = await fetch("/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          goal_id: goalId,
          session_id: sessionId.current,
        }),
        signal: abortRef.current.signal,
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = decoder.decode(value).split("\n");
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "{}") continue;

          try {
            const payload = JSON.parse(raw);

            // 解析 SSE event type（从 event: 行）
            const eventLine = lines.find(l => l.startsWith("event:"));
            const eventType = eventLine?.slice(6).trim();

            if (eventType === "token") {
              // 流式追加文本
              setMessages(prev => {
                const last = prev[prev.length - 1];
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: last.content + payload.text },
                ];
              });
            } else if (eventType === "tool_start") {
              const toolNames: Record<string, string> = {
                web_search: "🔍 正在搜索资料...",
                kb_search: "📚 正在检索知识库...",
                plan_generate: "📋 正在生成计划...",
              };
              setToolStatus(toolNames[payload.tool] ?? "⚙️ 处理中...");
            } else if (eventType === "structured") {
              setMessages(prev => {
                const last = prev[prev.length - 1];
                return [...prev.slice(0, -1), { ...last, structuredOutput: payload }];
              });
            } else if (eventType === "confirmation_required") {
              setPendingConfirm(payload);
            }
          } catch {
            // 忽略解析失败的行
          }
        }
      }
    } finally {
      setIsStreaming(false);
      setToolStatus("");
    }
  };

  const handleConfirm = async (confirmed: boolean) => {
    await fetch("/api/agent/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed, session_id: sessionId.current }),
    });
    setPendingConfirm(null);
  };

  return (
    <div className="flex flex-col h-full">
      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-2xl px-4 py-3 ${
              msg.role === "user"
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-900"
            }`}>
              <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
              {msg.structuredOutput && (
                <PlanCard plan={msg.structuredOutput} />
              )}
            </div>
          </div>
        ))}

        {/* 工具调用状态 */}
        {toolStatus && (
          <div className="flex justify-start">
            <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 text-sm text-gray-500 animate-pulse">
              {toolStatus}
            </div>
          </div>
        )}
      </div>

      {/* 待确认弹窗 */}
      {pendingConfirm && (
        <div className="mx-4 mb-4 p-4 bg-amber-50 border border-amber-200 rounded-xl">
          <p className="text-sm font-medium text-amber-800 mb-3">
            {(pendingConfirm as any).message}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => handleConfirm(true)}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
            >
              确认执行
            </button>
            <button
              onClick={() => handleConfirm(false)}
              className="px-4 py-2 bg-white border border-gray-300 text-sm rounded-lg hover:bg-gray-50"
            >
              暂不调整
            </button>
          </div>
        </div>
      )}

      {/* 输入框 */}
      <div className="p-4 border-t border-gray-200">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage(input)}
            placeholder="输入消息..."
            disabled={isStreaming}
            className="flex-1 rounded-xl border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={isStreaming || !input.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {isStreaming ? "..." : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

### 8.2 Check-in 表单组件

> **当前实现**：`CheckinForm.tsx` 实现 `daily` 模式（逐任务掌握度评估）。后端 API 支持全部4种模式（daily / task_list / quick / natural），其余模式可按需在前端扩展。`natural` 模式由 Agent Chat 自然语言打卡路径触发，不经过此表单。

```typescript
// frontend/components/agent/CheckinForm.tsx
"use client";

type MasteryLevel = "L1" | "L2" | "L3";

interface TaskEntry {
  id: string;
  title: string;
  estimated_mins: number;
}

export function CheckinForm({ goalId, tasks, onSuccess }: {
  goalId: string;
  tasks: TaskEntry[];
  onSuccess?: () => void;
}) {
  // 每个任务的掌握度：L1 待加强 / L2 基本了解 / L3 完全掌握
  const [masteries, setMasteries] = useState<Record<string, MasteryLevel>>({});
  const [notes, setNotes]= useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<CheckinResult | null>(null);

  // 完成率实时计算：L3×1.0 + L2×0.5，未选视为 0
  const completionRate = tasks.length === 0 ? 0
    : Object.values(masteries).reduce((s, m) => s + (m === "L3" ? 1 : m === "L2" ? 0.5 : 0), 0) / tasks.length;

  const submit = async () => {
    setIsSubmitting(true);
    try {
      const res = await api.post<CheckinResult>(`/api/v1/checkin/${goalId}`, {
        mode: "daily",
        completion_rate: completionRate,
        tasks: tasks.map(t => ({
          task_id: t.id,
          mastery: masteries[t.id] ?? "L1",
          note: notes[t.id] ?? "",
        })),
      });
      setResult(res);
      onSuccess?.();
    } finally {
      setIsSubmitting(false);
    }
  };
  // 提交成功后展示：完成率大字 + 三格统计（完全掌握/基本了解/待加强）+ AI反馈 + 债务/重规划提示
}
```

### 8.3 Next.js SSE 代理

```typescript
// apps/web/app/api/stream/route.ts
// 代理后端 SSE 流，解决前端直连CORS 问题
import { NextRequest } from "next/server";
import { cookies } from "next/headers";

export async function POST(req: NextRequest) {
  const token = cookies().get("access_token")?.value;
  const body = await req.json();

  const upstream = await fetch(`${process.env.API_URL}/api/v1/agent/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  // 直接透传 SSE 流
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

---

## 九、Prompt 工程

```python
# app/core/prompts/planner.py

PLAN_GENERATION_PROMPT = """
你是PlanPilot，一名专业的学习规划教练。
根据用户的目标信息，生成一个可执行的学习计划。

【目标信息】
目标：{goal_title}
截止日期：{deadline}
每日可用学习时间：{daily_hours} 小时
当前基础：{current_level}

【输出要求】
严格按照以下 JSON Schema 输出，不要附加任何解释文字：

{{
  "summary": {{
    "total_days": <整数>,
    "total_hours": <浮点数>,
    "phases": <整数，建议2-4个阶段>
  }},
  "phases": [
    {{
      "phase": <整数>,
      "title": <阶段名称>,
      "start_day": <整数>,
      "end_day": <整数>,
      "goal": <本阶段目标>,
      "weeks": [
        {{
          "week": <整数>,
          "goal": <本周目标>,
          "tasks": [
            {{
              "day_offset": <从计划开始的天数，整数>,
              "title": <任务名称，具体到知识点>,
              "estimated_mins": <整数>,
              "type": "study|review|practice|rest",
              "is_buffer": <布尔值>,
              "kb_tags": [<相关知识库标签>]
            }}
          ],
          "milestone": <本周验收标准，可为null>
        }}
      ]
    }}
  ],
  "difficulty_warnings": [
    {{
      "day_offset": <整数>,
      "topic": <预警知识点>,
      "reason": <为什么困难>,
      "suggestion": <应对建议>
    }}
  ],
  "resource_hints": [<推荐资料关键词，用于后续搜索>]
}}

【规划原则】
1. 每7天保留1个缓冲日（is_buffer=true），不排具体任务
2. 前20%时间建立基础框架，中间60%深化核心，最后20%综合复习
3. 高认知负荷任务（推导、计算）放在精力充沛的时间段
4. 每个任务粒度控制在30-90分钟，不超过用户每日可用时间的60%
5. 在已知的难关前2-3天自动插入预习缓冲


"""
REPLAN_PROMPT = """
你是PlanPilot的重规划引擎。根据当前执行偏差，生成调整方案供用户确认。

【当前状态】
原计划截止日：{deadline}
当前日期：{current_date}
剩余天数：{remaining_days}
累计落后天数：{days_behind}
平均完成率（近7天）：{avg_completion_rate}%

【未完成内容】
{incomplete_tasks}

【学习债务清单】
{debt_items}

【输出要求】
输出 JSON，包含两个方案供用户选择：

{{
  "analysis": "<2-3句话分析落后原因>",
  "options": [
    {{
      "id": "A",
      "title": "<方案A标题>",
      "description": "<方案A 描述>",
      "trade_off": "<代价>",
      "new_daily_hours": <浮点数>,
      "new_deadline": "<日期或null表示不变>",
      "confidence": <0-100 的通过率预估>
    }},
    {{
      "id": "B",
      "title": "<方案B 标题>",
      "description": "<方案B 描述>",
      "trade_off": "<代价>",
      "new_daily_hours": <浮点数>,
      "new_deadline": "<日期或null>",
      "confidence": <0-100>
    }}
  ],
  "recommendation": "A" | "B",
  "recommendation_reason": "<推荐理由，基于数据>"
}}
"""

VERIFICATION_PROMPT = """
你是一名严格但友善的学习验收官。
用户刚完成了以下学习任务，请通过对话验收是否真正理解。

【任务信息】
任务名称：{task_title}
任务类型：{task_type}
相关知识点（来自知识库）：
{knowledge_context}

【验收原则】
- 区分"读完了"和"真懂了"
- 问题应针对核心原理，而非死记硬背细节
- 若用户回答模糊，追问一次，不超过3轮
- 不要给出答案，只给方向性提示

【输出格式】
直接输出验收问题（自然语言），不要 JSON。
问题应简洁，一句话，让用户用自己的话解释。

示例（CPA 长期股权投资）：
"权益法下，被投资方亏损超过投资账面价值时，你会怎么处理？为什么？"
"""

INTENT_CLASSIFICATION_PROMPT = """
根据用户消息，判断意图类型。只输出一个 JSON 对象，不加任何解释。

用户消息：{message}

可选意图：
- goal_setup: 用户想设定新学习目标
- checkin: 用户在汇报今天的学习完成情况
- verification: 用户完成了某个任务，需要验收
- replan_request: 用户主动要求调整计划
- knowledge_upload: 用户上传或分享了资料
- free_chat: 其他对话（提问、闲聊等）

输出：{{"intent": "<意图类型>", "confidence": <0-1>}}
"""
```

---

## 十、可观测性

```python
# app/core/observability.py
import structlog
from langfuse import Langfuse
from prometheus_client import Counter, Histogram, generate_latest
import time

# 结构化日志
structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.stdlib.add_log_level,
        structlog.processors.JSONRenderer(),
    ],
)
logger = structlog.get_logger()

# Prometheus 指标
llm_request_counter = Counter(
    "llm_requests_total",
    "LLM API 调用次数",
    ["task_type", "model", "status"],
)
llm_latency_histogram = Histogram(
    "llm_latency_seconds",
    "LLM 响应延迟",
    ["task_type"],buckets=[0.5, 1, 2, 3, 5, 10, 15, 30],
)
agent_intent_counter = Counter(
    "agent_intents_total",
    "Agent 意图分类计数",
    ["intent"],
)
checkin_completion_histogram = Histogram(
    "checkin_completion_rate",
    "每日 check-in 完成率分布",
    buckets=[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
)

# Langfuse LLM 追踪
langfuse = Langfuse(
    public_key=settings.langfuse_public_key,
    secret_key=settings.langfuse_secret_key,
    host=settings.langfuse_host,
)

class TracedLLMCall:
    """上下文管理器：自动追踪 LLM 调用到Langfuse + Prometheus"""
    def __init__(self, task: str, user_id: str, trace_id: str = None):
        self.task = task
        self.user_id = user_id
        self.start_time = None
        self.trace = langfuse.trace(
            name=f"agent_{task}",
            user_id=user_id,
            id=trace_id,
        )

    def __enter__(self):
        self.start_time = time.time()
        return self.trace

    def __exit__(self, exc_type, exc_val, exc_tb):
        duration = time.time() - self.start_time
        status = "error" if exc_type else "success"
        llm_latency_histogram.labels(task_type=self.task).observe(duration)
        llm_request_counter.labels(
            task_type=self.task,
            model=TASK_MODEL_MAP.get(self.task, ("unknown", "unknown"))[1],
            status=status,
        ).inc()
        self.trace.update(status=status)
        logger.info("llm_call", task=self.task, duration=duration, status=status)
```

---

## 十一、配置管理与环境变量

```python
# app/core/config.py
from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # 应用
    app_name: str = "PlanPilot"
    debug: bool = False
    secret_key: str          # JWT签名密钥，必填
    access_token_expire_minutes: int = 60 * 24 * 7  # 7天

    # 数据库
    database_url: str         # postgresql+asyncpg://...
    redis_url: str            # redis://...

    # 存储
    s3_bucket: str
    s3_endpoint_url: str      # 兼容 R2/MinIO
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_region: str = "auto"

    # LLM
    anthropic_api_key: str
    openai_api_key: str

    # 外部工具
    tavily_api_key: str

    # 可观测性
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""
    langfuse_host: str = "https://cloud.langfuse.com"

    # 限流
    rate_limit_per_minute: int = 60

@lru_cache
def get_settings() -> Settings:
    return Settings()

settings = get_settings()
```

```bash
# .env.example
APP_NAME=PlanPilot
DEBUG=false
SECRET_KEY=your-secret-key-min-32-chars

# 数据库
DATABASE_URL=postgresql+asyncpg://planpilot:password@localhost:5432/planpilot
REDIS_URL=redis://localhost:6379/0

# 存储（本地开发用MinIO，生产用 R2/S3）
S3_BUCKET=planpilot-dev
S3_ENDPOINT_URL=http://localhost:9000
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
AWS_REGION=us-east-1

# LLM
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# 外部工具
TAVILY_API_KEY=tvly-...

# 可观测性（可选）
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

---

## 十二、本地开发环境

### 12.1 docker-compose.yml

```yaml
# docker-compose.yml（开发环境）
version: "3.9"

services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: planpilot
      POSTGRES_PASSWORD: password
      POSTGRES_DB: planpilot
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U planpilot"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio_data:/data

  api:
    build:
      context: ./apps/api
      dockerfile: Dockerfile.dev
    volumes:
      - ./apps/api:/app        # 热重载ports:
      - "8000:8000"
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    command: uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

  worker:
    build:
      context: ./apps/api
      dockerfile: Dockerfile.dev
    volumes:
      - ./apps/api:/app
    env_file: .env
    depends_on:
      - redis
      - postgres
    command: celery -A worker.celery_app worker --loglevel=info -Q default,kb_processbeat:
    build:
      context: ./apps/api
      dockerfile: Dockerfile.dev
    volumes:
      - ./apps/api:/app
    env_file: .env
    depends_on:
      - redis
    command: celery -A worker.celery_app beat --loglevel=infoweb:
    build:
      context: ./apps/web
      dockerfile: Dockerfile.dev
    volumes:
      - ./apps/web:/app
      - /app/node_modules- /app/.next
    ports:
      - "3000:3000"
    environment:
      API_URL: http://api:8000
    command: npm run dev

volumes:
  postgres_data:
  minio_data:
```

### 12.2 FastAPI 入口

```python
# app/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from app.core.config import settings
from app.core.database import engine
from app.models.base import Base
from app.core.agent.graph import create_agent
from app.api.v1 import auth, goals, plans, checkin, knowledge, agent

_agent_instance = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _agent_instance
    # 启动时初始化 Agent（含LangGraph checkpointer）
    _agent_instance = await create_agent()
    app.state.agent = _agent_instance
    yield
    # 关闭时清理连接
    await engine.dispose()

app = FastAPI(
    title="PlanPilot API",
    version="1.0.0",
    lifespan=lifespan,docs_url="/docs" if settings.debug else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(auth.router,prefix="/api/v1")
app.include_router(goals.router,     prefix="/api/v1")
app.include_router(plans.router,     prefix="/api/v1")
app.include_router(checkin.router,prefix="/api/v1")
app.include_router(knowledge.router, prefix="/api/v1")
app.include_router(agent.router,     prefix="/api/v1")

@app.get("/health")
async def health():
    return {"status": "ok"}
```

---

## 十三、CI/CD

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test-api:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: planpilot
          POSTGRES_PASSWORD: password
          POSTGRES_DB: planpilot_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-retries 5
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]

    steps:
      - uses: actions/checkout@v4- uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip

      - name: Install dependencies
        working-directory: apps/api
        run: pip install -e ".[test]"

      - name: Run migrations
        working-directory: apps/api
        env:
          DATABASE_URL: postgresql+asyncpg://planpilot:password@localhost:5432/planpilot_testrun: alembic upgrade head

      - name: Run tests
        working-directory: apps/api
        env:
          DATABASE_URL: postgresql+asyncpg://planpilot:password@localhost:5432/planpilot_test
          REDIS_URL: redis://localhost:6379/1ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          TAVILY_API_KEY: ${{ secrets.TAVILY_API_KEY }}
          SECRET_KEY: test-secret-key-for-ci-only
        run: pytest tests/ -v --cov=app --cov-report=xmltest-web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npmcache-dependency-path: apps/web/package-lock.json
      - run: npm ciworking-directory: apps/web
      - run: npm run type-check
        working-directory: apps/web
      - run: npm run lint
        working-directory: apps/web
      - run: npm run build
        working-directory: apps/web

# .github/workflows/deploy.yml
name: Deploy to Railway

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    needs: [test-api, test-web]# 必须 CI 通过
    steps:
      - uses: actions/checkout@v4
      - name: Deploy API
        uses: bervProject/railway-deploy@main
        with:
          railway_token: ${{ secrets.RAILWAY_TOKEN }}
          service: planpilot-api
      - name: Deploy Web
        uses: bervProject/railway-deploy@main
        with:
          railway_token: ${{ secrets.RAILWAY_TOKEN }}
          service: planpilot-web
```

---

## 十四、前端实现要点（MVP v1）

本章记录实际开发中非显而易见的决策，供后续维护参考。

### 14.1 Zustand Store 的重置问题

Zustand store 是模块级单例，Next.js App Router 的 `router.replace()` 只更换路由，**不会重置 store 状态**。
因此，登出和注销账号必须用 `window.location.replace("/login")` 触发完整页面刷新，确保 `authStore`、`goalStore`、`chatStore` 全部清空。

```typescript
// settings/page.tsx
async function handleDeleteAccount() {
  await api.del("/api/v1/auth/me");
  logout();
  window.location.replace("/login"); // router.replace 不够，必须 full reload
}

function handleLogout() {
  logout();
  router.replace("/login"); // 退出登录不需要清其它 store，router.replace 即可
}
```

> 注意：`handleLogout` 使用 `router.replace` 是有意为之——退出登录时只清 authStore，其他 store 下次页面挂载会自行从 API 加载最新数据。注销账号才需要 full reload。

---

### 14.2 主题隔离（按 userId）

每个用户的主题偏好存储在各自隔离的 localStorage key 下，避免多账号共用一台设备时互相覆盖。

```typescript
// lib/theme-context.tsx
const userId = useAuthStore((s) => s.user?.id ?? "guest");
const modeKey  = `theme-mode-${userId}`;
const colorKey = `theme-color-${userId}`;
```

- 未登录用户使用 `guest` 作为 key
- `useEffect` 依赖 `[modeKey, colorKey]`，登录/登出/切换账号时自动重新加载对应主题
- 新用户默认色彩方案为 `indigo`（`localStorage` 无记录时的回退值）

---

### 14.3 Daily Brief 的三分支逻辑

`GET /api/v1/agent/daily-brief` 尚未上线时（或新用户无数据时），返回 `null`。前端按以下逻辑分支处理：

```typescript
// dashboard/page.tsx
api.get<DailyBrief | null>("/api/v1/agent/daily-brief")
  .then((d) => {
    if (d) {
      setDailyBrief(d);
    } else if (user?.username === "admin") {
      setDailyBrief(DEMO_BRIEF); // admin 账号展示内置示例数据
    } else {
      setDailyBrief(null);       // 普通新用户显示占位提示卡
    }
  })
  .catch(() => {
    if (user?.username === "admin") setDailyBrief(DEMO_BRIEF);
  })
  .finally(() => setBriefLoaded(true));
```

| 情况 | 展示 |
|---|---|
| API 返回真实数据 | 正常渲染 brief 卡片 |
| API 返回 null + 用户名为 `admin` | 展示内置 `DEMO_BRIEF`（示例数据账号） |
| API 返回 null + 普通用户 | 展示占位卡："暂无简报，完成首次 Check-in 后生成" |

---

### 14.4 SSE 代理路由的 Token 优先级

`app/api/stream/route.ts` 同时支持 Cookie Token 和 Header Token，优先取 Cookie：

```typescript
const cookieToken  = cookieStore.get("access_token")?.value;
const headerToken  = req.headers.get("authorization")?.replace("Bearer ", "");
const token = cookieToken ?? headerToken;
```

转发时加入 `X-Accel-Buffering: no` 响应头，防止 Nginx 缓冲 SSE 流导致客户端延迟收到事件。

---

### 14.5 待接入的后端接口

以下接口前端调用已实现，后端尚未上线：

| 接口 | 用途 | 前端调用位置 |
|---|---|---|
| `GET /api/v1/agent/daily-brief` | 获取每日 AI 简报 | `dashboard/page.tsx` |
| `DELETE /api/v1/auth/me` | 注销账号（级联删除所有数据） | `settings/page.tsx` |
| `PATCH /api/v1/auth/me`（email 字段） | 修改邮箱 | `settings/page.tsx` |

## 十四、MVP 启动检查清单

```
基础设施☐ Railway 项目创建，PostgreSQL + Redis 服务开通
  ☐ pgvector 扩展启用（CREATE EXTENSION vector;）
  ☐ Cloudflare R2 bucket 创建并配置 CORS
  ☐ 环境变量全部配置完成（参照 .env.example）

LLM 接入
  ☐ Anthropic API Key 获取并验证
  ☐ OpenAI API Key（用于 Embedding）获取并验证
  ☐ Tavily API Key 获取并验证
  ☐ 限流和重试逻辑测试通过

Agent 核心流
  ☐ 意图识别准确率 > 90%（10条测试用例）
  ☐ CPA 备考计划生成测试通过（输出合法JSON）
  ☐ check-in 三种模式均测试通过
  ☐ 重规划 human-in-the-loop 中断/恢复测试通过
  ☐ 验收对话生成测试通过

知识库
  ☐ PDF 上传解析测试通过（含中文 PDF）
  ☐ URL 解析测试通过
  ☐ 向量检索返回相关结果（余弦相似度 > 0.7）

前端
  ☐ SSE 流式对话稳定（不出现乱序/重复）
  ☐ check-in 三种模式 UI 测试通过
  ☐ 计划卡片正确渲染（含每日任务）
  ☐ 移动端布局适配（min-width: 375px）

可观测性
  ☐ Langfuse 接收到 LLM 调用追踪
  ☐ 结构化日志正常输出
  ☐ /health 端点返回 200

上线前
  ☐ 幻觉率抽查（20条LLM 输出，不存在资料< 1条）
  ☐ 核心流 E2E 测试通过（注册→设目标→生成计划→check-in→验收）
  ☐ HTTPS 证书配置
  ☐ 敏感环境变量未出现在日志/响应中
```

---

## 十五、关键技术决策速查

| 决策点 | 选择 | 不选的替代方案 | 原因 |
|--------|------|--------------|------|
| Agent 框架 | LangGraph | LangChain LCEL | 有状态图 + human-in-the-loop 是核心需求 |
| 向量库 | pgvector | Pinecone / Qdrant | MVP阶段避免引入额外服务，PostgreSQL 已满足 |
| 流式协议 | SSE | WebSocket | 单向流更简单，无需双向实时通信 |
| 任务队列 | Celery + Redis | 纯 asyncio | 文件处理和定时推送需要进程级隔离 |
| LLM 主力 | Claude3.5 Sonnet | GPT-4o | 长文本规划输出更结构化，中文理解更稳定 |
| 部署平台 | Railway | Vercel + AWS | MVP 阶段一站式，PostgreSQL 托管，省运维 |
| 对象存储 | Cloudflare R2 | AWS S3 | 免出流量费，与 S3 API兼容 |
| ORM | SQLAlchemy 2.x async | Tortoise / Prisma | 成熟度最高，pgvector 支持完整 |
---
还有几个重要模块没输出完，继续：

---

## 十六、认证系统

```python
# app/api/v1/auth.py
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm, OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timedelta
from jose import JWTError, jwt
from passlib.context import CryptContext
from app.core.config import settings
from app.models.user import User
from app.schemas.auth import TokenResponse, RegisterRequest

router = APIRouter(prefix="/auth", tags=["auth"])
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")

# ── Token 生成 ──────────────────────────────────────────────
def create_access_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "exp": datetime.utcnow() + timedelta(minutes=settings.access_token_expire_minutes),"type": "access",
    }
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")

# ── 当前用户依赖 ─────────────────────────────────────────────
async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        user_id: str = payload.get("sub")
        if not user_id:
            raise credentials_exc
    except JWTError:
        raise credentials_excuser = await db.get(User, user_id)
    if not user:
        raise credentials_exc
    return user

# ── 注册 ────────────────────────────────────────────────────
@router.post("/register", response_model=TokenResponse, status_code=201)
async def register(request: RegisterRequest, db: AsyncSession = Depends(get_db)):
    # 检查邮箱是否已注册
    existing = await db.execute(select(User).where(User.email == request.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already registered")

    user = User(
        email=request.email,
        name=request.name,
        hashed_password=pwd_context.hash(request.password),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    return TokenResponse(
        access_token=create_access_token(str(user.id)),
        token_type="bearer",
        user_id=str(user.id),
        name=user.name,
    )

# ── 登录 ────────────────────────────────────────────────────
@router.post("/login", response_model=TokenResponse)
async def login(
    form: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.email == form.username))
    user = result.scalar_one_or_none()
    if not user or not pwd_context.verify(form.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
        )
    return TokenResponse(
        access_token=create_access_token(str(user.id)),
        token_type="bearer",
        user_id=str(user.id),
        name=user.name,
    )
```

---

## 十七、Pydantic Schemas

```python
# app/schemas/auth.py
from pydantic import BaseModel, EmailStr, field_validator

class RegisterRequest(BaseModel):
    email: EmailStr
    name: str
    password: str@field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("密码不少于8位")
        return v

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("姓名不能为空")
        return v.strip()

class TokenResponse(BaseModel):
    access_token: str
    token_type: str
    user_id: str
    name: str


# app/schemas/goal.py
from pydantic import BaseModel, field_validator
from datetime import date
from typing import Any
from app.models.goal import GoalType

class GoalCreateRequest(BaseModel):
    type: GoalType
    title: str
    deadline: date
    daily_hours: float
    current_level: str = "初学者"
    meta: dict[str, Any] = {}

    @field_validator("deadline")
    @classmethod
    def deadline_in_future(cls, v: date) -> date:
        if v <= date.today():
            raise ValueError("截止日期必须在今天之后")
        return v@field_validator("daily_hours")
    @classmethod
    def hours_valid(cls, v: float) -> float:
        if not0.5 <= v <= 12:
            raise ValueError("每日学习时间应在 0.5-12 小时之间")
        return v

class GoalResponse(BaseModel):
    id: str
    type: GoalType
    title: str
    deadline: date
    daily_hours: float
    current_level: str
    status: str
    meta: dict[str, Any]created_at: str

    model_config = {"from_attributes": True}


# app/schemas/checkin.py
from pydantic import BaseModel
from typing import Literal

class TaskCheckin(BaseModel):
    task_id: str
    status: Literal["completed", "partial", "skipped"]
    actual_mins: int | None = None
    note: str = ""

class CheckinRequest(BaseModel):
    mode: Literal["task_list", "quick", "natural"]
    # task_list 模式
    tasks: list[TaskCheckin] = []
    # quick 模式
    quick_status: Literal["all_done", "mostly_done", "half_done", "barely_done", "explain"] | None = None
    # natural 模式
    text: str = ""

class CheckinStats(BaseModel):
    total: int
    completed: int
    partial: int
    skipped: int
    completion_rate: float
    estimated_mins: int
    actual_mins: int

class CheckinResponse(BaseModel):
    stats: CheckinStats
    feedback: str
    debt_added: int = 0         # 新增债务条目数
    replan_triggered: bool = False


# app/schemas/agent.py
from pydantic import BaseModel

class AgentRequest(BaseModel):
    message: str
    session_id: str
    goal_id: str | None = None

class ConfirmRequest(BaseModel):
    session_id: str
    confirmed: bool
    option_id: str | None = None   # 重规划方案选择（"A" 或 "B"）
```

---

## 十八、统一错误处理

```python
# app/core/exceptions.py
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
import structlog

logger = structlog.get_logger()

class PlanPilotError(Exception):
    """业务异常基类"""
    def __init__(self, message: str, code: str, status_code: int = 400):
        self.message = message
        self.code = code
        self.status_code = status_code
        super().__init__(message)

class GoalNotFoundError(PlanPilotError):
    def __init__(self, goal_id: str):
        super().__init__(f"目标不存在: {goal_id}", "GOAL_NOT_FOUND", 404)

class PlanGenerationError(PlanPilotError):
    def __init__(self, reason: str):
        super().__init__(f"计划生成失败: {reason}", "PLAN_GENERATION_FAILED", 500)

class KnowledgeProcessingError(PlanPilotError):
    def __init__(self, filename: str):
        super().__init__(f"文件处理失败: {filename}", "KB_PROCESSING_FAILED", 422)


def register_exception_handlers(app: FastAPI):
    @app.exception_handler(PlanPilotError)
    async def business_error_handler(request: Request, exc: PlanPilotError):
        logger.warning("business_error", code=exc.code, message=exc.message, path=request.url.path)
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.code, "message": exc.message},
        )

    @app.exception_handler(ValidationError)
    async def validation_error_handler(request: Request, exc: ValidationError):
        return JSONResponse(
            status_code=422,
            content={
                "error": "VALIDATION_ERROR",
                "message": "请求参数无效",
                "details": exc.errors(),
            },
        )

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, exc: Exception):
        logger.error("unhandled_error", error=str(exc), path=request.url.path, exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"error": "INTERNAL_ERROR", "message": "服务器内部错误，请稍后重试"},
        )
```

---

## 十九、限流中间件

```python
# app/core/rate_limit.py
from fastapi import Request, HTTPException, status
from app.core.cache import redis_client
import time

async def rate_limit_middleware(request: Request, call_next):
    """
    基于 Redis 的滑动窗口限流
    - /api/v1/agent/stream: 10次/分钟（LLM 调用成本高）
    - 其他接口: 60次/分钟
    """
    # 跳过健康检查
    if request.url.path in ("/health", "/metrics"):
        return await call_next(request)

    # 获取用户标识（已认证用用户ID，否则用IP）
    user_id = getattr(request.state, "user_id", None)
    identifier = user_id or request.client.host

    # 针对Agent流式接口单独限流
    is_agent_stream = "/agent/stream" in request.url.path
    limit = 10 if is_agent_stream else 60
    window = 60  # 秒

    key = f"rate_limit:{identifier}:{request.url.path if is_agent_stream else 'general'}"

    now = time.time()
    pipe = redis_client.pipeline()
    pipe.zremrangebyscore(key, 0, now - window)   # 移除窗口外的请求
    pipe.zadd(key, {str(now): now})               # 添加当前请求
    pipe.zcard(key)                               # 统计窗口内请求数
    pipe.expire(key, window)
    results = await pipe.execute()

    request_count = results[2]
    if request_count > limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"请求过于频繁，请{window}秒后重试",
            headers={"Retry-After": str(window)},
        )

    response = await call_next(request)
    response.headers["X-RateLimit-Limit"] = str(limit)
    response.headers["X-RateLimit-Remaining"] = str(max(0, limit - request_count))
    return response
```

---

## 二十、数据库迁移（Alembic）

```python
# alembic/env.py
from logging.config import fileConfig
from sqlalchemy import engine_from_config, pool
from alembic import context
from app.models.base import Base
from app.models import user, goal, plan, task, debt, knowledge# 触发模型注册
import asyncio
from sqlalchemy.ext.asyncio import async_engine_from_config

config = context.config
fileConfig(config.config_file_name)
target_metadata = Base.metadata

def run_migrations_online():
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async def do_migrations(connection):
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )
        async with context.begin_transaction():
            await context.run_migrations()

    async def run():
        async with connectable.connect() as connection:
            await connection.run_sync(
                lambda sync_conn: asyncio.get_event_loop().run_until_complete(
                    do_migrations(sync_conn)
                )
            )

    asyncio.run(run())

run_migrations_online()
```

```python
# alembic/versions/001_init_schema.py
"""init schema

Revision ID: 001
Create Date: 2026-07-13
"""
from alembic import op
import sqlalchemy as sa
from pgvector.sqlalchemy import Vector

def upgrade():
    # pgvector 扩展
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')

    op.create_table("users",
        sa.Column("id", sa.UUID(), server_default=sa.text("uuid_generate_v4()"), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("timezone", sa.String(50), server_default="Asia/Shanghai"),
        sa.Column("notification_prefs", sa.JSON(), server_default="{}"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("NOW()")),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("NOW()")),
    )
    op.create_index("ix_users_email", "users", ["email"])

    op.create_table("goals",
        sa.Column("id", sa.UUID(), server_default=sa.text("uuid_generate_v4()"), primary_key=True),
        sa.Column("user_id", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("type", sa.String(50), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("deadline", sa.Date(), nullable=False),
        sa.Column("daily_hours", sa.Float(), nullable=False),
        sa.Column("current_level", sa.String(50)),
        sa.Column("status", sa.String(20), server_default="active"),
        sa.Column("meta", sa.JSON(), server_default="{}"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("NOW()")),
    )
    op.create_index("ix_goals_user_id", "goals", ["user_id"])

    op.create_table("plans",
        sa.Column("id", sa.UUID(), server_default=sa.text("uuid_generate_v4()"), primary_key=True),
        sa.Column("goal_id", sa.UUID(), sa.ForeignKey("goals.id"), nullable=False),
        sa.Column("version", sa.Integer(), server_default="1"),
        sa.Column("is_current", sa.Boolean(), server_default="true"),
        sa.Column("baseline", sa.JSON()),
        sa.Column("content", sa.JSON()),
        sa.Column("replan_reason", sa.Text()),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("NOW()")),
    )

    op.create_table("tasks",
        sa.Column("id", sa.UUID(), server_default=sa.text("uuid_generate_v4()"), primary_key=True),
        sa.Column("plan_id", sa.UUID(), sa.ForeignKey("plans.id"), nullable=False),
        sa.Column("goal_id", sa.UUID(), sa.ForeignKey("goals.id"), nullable=False),
        sa.Column("scheduled_date", sa.Date(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("estimated_mins", sa.Integer()),
        sa.Column("actual_mins", sa.Integer()),
        sa.Column("status", sa.String(20), server_default="pending"),
        sa.Column("mastery_level", sa.String(20), server_default="unchecked"),
        sa.Column("checkin_note", sa.Text()),
        sa.Column("kb_refs", sa.JSON(), server_default="[]"),
        sa.Column("completed_at", sa.DateTime()),)
    op.create_index("ix_tasks_goal_date", "tasks", ["goal_id", "scheduled_date"])

    op.create_table("learning_debts",
        sa.Column("id", sa.UUID(), server_default=sa.text("uuid_generate_v4()"), primary_key=True),
        sa.Column("goal_id", sa.UUID(), sa.ForeignKey("goals.id"), nullable=False),
        sa.Column("task_id", sa.UUID(), sa.ForeignKey("tasks.id")),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("estimated_hours", sa.Float()),
        sa.Column("skip_reason", sa.Text()),
        sa.Column("impact", sa.Text()),
        sa.Column("status", sa.String(20), server_default="open"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("NOW()")),
        sa.Column("resolved_at", sa.DateTime()),
    )

    op.create_table("knowledge_items",
        sa.Column("id", sa.UUID(), server_default=sa.text("uuid_generate_v4()"), primary_key=True),
        sa.Column("user_id", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("goal_id", sa.UUID(), sa.ForeignKey("goals.id")),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("source_type", sa.String(20)),
        sa.Column("source_url", sa.Text()),
        sa.Column("file_path", sa.Text()),
        sa.Column("tags", sa.JSON(), server_default="[]"),
        sa.Column("embedding", Vector(1536)),
        sa.Column("expires_at", sa.DateTime()),sa.Column("created_at", sa.DateTime(), server_default=sa.text("NOW()")),
    )
    #向量索引（IVFFlat，适合百万级以下）
    op.execute("""
        CREATE INDEX ix_knowledge_embedding
        ON knowledge_items
        USING ivfflat (embedding vector_cosine_ops)WITH (lists = 100)
    """)op.create_index("ix_knowledge_user_id", "knowledge_items", ["user_id"])

def downgrade():
    op.drop_table("knowledge_items")
    op.drop_table("learning_debts")
    op.drop_table("tasks")
    op.drop_table("plans")
    op.drop_table("goals")
    op.drop_table("users")
```

---

## 二十一、测试策略

```python
# apps/api/tests/conftest.py
import pytest
import asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from app.main import app
from app.models.base import Base
from app.core.database import get_db
from app.core.config import settings

TEST_DB_URL = settings.database_url.replace("/planpilot", "/planpilot_test")

@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()

@pytest.fixture(scope="session")
async def test_engine():
    engine = create_async_engine(TEST_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()

@pytest.fixture
async def db_session(test_engine):
    async_session = sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with async_session() as session:
        yield session
        await session.rollback()  # 每个测试后回滚，保证隔离

@pytest.fixture
async def client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()

@pytest.fixture
async def auth_headers(client):
    """注册并登录，返回认证头"""
    await client.post("/api/v1/auth/register", json={
        "email": "test@planpilot.app",
        "name": "测试用户",
        "password": "testpass123",
    })
    resp = await client.post("/api/v1/auth/login", data={
        "username": "test@planpilot.app",
        "password": "testpass123",
    })
    token = resp.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


# apps/api/tests/test_goals.py
import pytest
from datetime import date, timedelta

@pytest.mark.asyncio
async def test_create_goal(client, auth_headers):
    resp = await client.post("/api/v1/goals", json={
        "type": "certification",
        "title": "CPA会计",
        "deadline": str(date.today() + timedelta(days=300)),
        "daily_hours": 2.0,
        "current_level": "初学者",
    }, headers=auth_headers)
    assert resp.status_code == 201
    data = resp.json()
    assert data["title"] == "CPA 会计"
    assert data["status"] == "active"

@pytest.mark.asyncio
async def test_deadline_in_past_rejected(client, auth_headers):
    resp = await client.post("/api/v1/goals", json={
        "type": "certification",
        "title": "过期目标",
        "deadline": "2020-01-01",
        "daily_hours": 2.0,
    }, headers=auth_headers)
    assert resp.status_code == 422


# apps/api/tests/test_agent.py
import pytest
from unittest.mock import AsyncMock, patch

@pytest.mark.asyncio
async def test_intent_classification_goal_setup(client, auth_headers):
    """测试意图识别：目标设定"""
    with patch("app.core.agent.nodes.intent.llm_router") as mock_llm:
        mock_llm.complete = AsyncMock(return_value=AsyncMock(
            content=[AsyncMock(text='{"intent": "goal_setup", "confidence": 0.95}')]
        ))
        resp = await client.post("/api/v1/agent/stream",
            json={"message": "我想备考CPA，明年5月考试", "session_id": "test-session"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")

@pytest.mark.asyncio
async def test_checkin_quick_mode(client, auth_headers, db_session):
    """测试快速 check-in"""
    # 先创建目标
    goal_resp = await client.post("/api/v1/goals", json={
        "type": "certification",
        "title": "CPA 测试",
        "deadline": "2027-05-01",
        "daily_hours": 2.0,
    }, headers=auth_headers)
    goal_id = goal_resp.json()["id"]

    resp = await client.post(f"/api/v1/checkin/{goal_id}", json={
        "mode": "quick",
        "quick_status": "mostly_done",
    }, headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "stats" in data
    assert "feedback" in data


# apps/api/tests/test_knowledge.py
@pytest.mark.asyncio
async def test_kb_search_empty(client, auth_headers):
    """空知识库搜索不报错"""
    resp = await client.get("/api/v1/knowledge/search?q=权益法", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["results"] == []

@pytest.mark.asyncio
async def test_url_ingest(client, auth_headers):
    """URL 导入任务派发成功"""
    with patch("worker.tasks.kb_process.process_url") as mock_task:
        mock_task.delay.return_value = AsyncMock(id="task-123")
        resp = await client.post("/api/v1/knowledge/url", json={
            "url": "https://example.com/cpa-notes",
            "goal_id": None,
        }, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["status"] == "processing"
```

---

## 二十二、Railway 部署配置

```toml
# railway.toml
[build]
builder = "dockerfile"
dockerfilePath = "apps/api/Dockerfile"

[deploy]
startCommand = "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port $PORT"
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
```

```dockerfile
# apps/api/Dockerfile
FROM python:3.12-slim

WORKDIR /app

# 系统依赖（PyMuPDF 需要）
RUN apt-get update && apt-get install -y \
    libmupdf-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
RUN pip install --no-cache-dir -e .

COPY . .

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

```toml
# apps/api/pyproject.toml
[project]
name = "planpilot-api"
version = "1.0.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi==0.115.0",
    "uvicorn[standard]==0.30.6",
    "pydantic==2.8.2",
    "pydantic-settings==2.4.0",
    "sqlalchemy==2.0.35",
    "asyncpg==0.29.0",
    "alembic==1.13.3",
    "pgvector==0.3.2",
    "redis==5.1.1",
    "celery==5.4.0",
    "langgraph==0.2.28",
    "langchain-anthropic==0.2.4",
    "langchain-openai==0.2.3",
    "anthropic==0.34.2",
    "openai==1.51.0",
    "tavily-python==0.5.0",
    "PyMuPDF==1.24.11",
    "python-docx==1.1.2",
    "python-jose[cryptography]==3.3.0",
    "passlib[bcrypt]==1.7.4",
    "python-multipart==0.0.12",
    "sse-starlette==2.1.3",
    "boto3==1.35.32",
    "structlog==24.4.0",
    "langfuse==2.53.0",
    "prometheus-client==0.21.0",
    "tenacity==9.0.0",
    "httpx==0.27.2",
    "slowapi==0.1.9",
]

[project.optional-dependencies]
test = [
    "pytest==8.3.3",
    "pytest-asyncio==0.24.0",
    "pytest-cov==5.0.0",
    "httpx==0.27.2",
]
继续：

```bash
echo "  API Docs：http://localhost:8000/docs"
echo "  MinIO 控制台：http://localhost:9001(minioadmin/minioadmin)"
echo "  Langfuse（可选）：http://localhost:3001"
```

---

## 二十九、API 路由汇总

```
GET    /health健康检查

# 认证
POST   /api/v1/auth/register注册
POST   /api/v1/auth/login                登录（返回 JWT）
POST   /api/v1/auth/refresh刷新 token

# 目标管理
GET    /api/v1/goals                     获取当前用户所有目标
POST   /api/v1/goals                     创建目标
GET    /api/v1/goals/{id}                目标详情
PATCH  /api/v1/goals/{id}                更新目标（暂停/恢复/放弃）
GET    /api/v1/goals/{id}/progress       目标进度数据（进度总览组件用）

# 计划
GET    /api/v1/plans/{goal_id}/current   获取当前计划
GET    /api/v1/plans/{goal_id}/today今日任务列表
POST   /api/v1/plans/{goal_id}/confirm确认 AI 生成的计划
GET    /api/v1/plans/{goal_id}/history   历史计划版本

# Check-in
POST   /api/v1/checkin/{goal_id}         提交今日check-in
GET    /api/v1/checkin/{goal_id}/history 历史 check-in 记录（最近30条）

# 学习债务
GET    /api/v1/debts/{goal_id}           获取债务列表
PATCH  /api/v1/debts/{debt_id}/resolve   标记债务已还清

# 知识库
POST   /api/v1/knowledge/upload          上传文件（返回任务 ID）
POST   /api/v1/knowledge/url             添加网页URL
GET    /api/v1/knowledge/search          语义搜索（?q=...&goal_id=...）
GET    /api/v1/knowledge                 列出所有条目（分页）
DELETE /api/v1/knowledge/{id}            删除条目

# Agent
POST   /api/v1/agent/stream              流式对话（SSE）
POST   /api/v1/agent/confirm             确认重规划等操作

# 任务状态轮询（文件处理等异步任务）
GET    /api/v1/tasks/{task_id}           查询Celery 任务状态
```

---

## 三十、Goals API 实现

```python
# app/api/v1/goals.py
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from datetime import date, timedelta
from app.models.goal import Goal, GoalStatus
from app.models.task import Task
from app.models.debt import LearningDebt
from app.schemas.goal import GoalCreateRequest, GoalResponse, GoalProgressResponse
from app.core.database import get_db
from app.api.v1.auth import get_current_user
from app.models.user import User

router = APIRouter(prefix="/goals", tags=["goals"])


@router.get("", response_model=list[GoalResponse])
async def list_goals(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Goal)
        .where(Goal.user_id == current_user.id)
        .order_by(Goal.created_at.desc())
    )
    return result.scalars().all()


@router.post("", response_model=GoalResponse, status_code=201)
async def create_goal(
    request: GoalCreateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    goal = Goal(
        user_id=current_user.id,
        type=request.type,
        title=request.title,
        deadline=request.deadline,
        daily_hours=request.daily_hours,
        current_level=request.current_level,
        meta=request.meta,
    )
    db.add(goal)
    await db.commit()
    await db.refresh(goal)
    return goal


@router.get("/{goal_id}/progress", response_model=GoalProgressResponse)
async def get_progress(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 验证目标归属
    goal = await db.get(Goal, goal_id)
    if not goal or str(goal.user_id) != str(current_user.id):
        raise HTTPException(status_code=404, detail="目标不存在")

    # 总任务数 / 已完成数
    total_q = await db.execute(
        select(func.count()).where(Task.goal_id == goal_id)
    )
    completed_q = await db.execute(
        select(func.count()).where(
            Task.goal_id == goal_id,
            Task.status == "completed",
        )
    )
    total = total_q.scalar_one()
    completed = completed_q.scalar_one()

    # 近7天平均完成率
    seven_days_ago = date.today() - timedelta(days=7)
    recent_tasks_q = await db.execute(
        select(Task.status).where(
            Task.goal_id == goal_id,
            Task.scheduled_date >= seven_days_ago,
        )
    )
    recent_tasks = recent_tasks_q.scalars().all()
    avg_rate = (
        sum(1 for t in recent_tasks if t == "completed") / len(recent_tasks)
        if recent_tasks else 0.0
    )

    # 连续打卡天数（从今天往回数连续有check-in 的天数）
    streak = await _calc_streak(db, goal_id)

    # 未还债务数
    debt_q = await db.execute(
        select(func.count()).where(
            LearningDebt.goal_id == goal_id,
            LearningDebt.status == "open",
        )
    )
    debt_count = debt_q.scalar_one()

    # 进度超前/落后天数（简化：按完成率推算）
    days_total = (goal.deadline - goal.created_at.date()).days
    expected_pct = min(1.0, (date.today() - goal.created_at.date()).days / days_total)
    actual_pct = completed / total if total > 0 else 0
    days_delta = round((actual_pct - expected_pct) * days_total)

    return GoalProgressResponse(
        goal_id=goal_id,
        title=goal.title,
        deadline=str(goal.deadline),
        total_tasks=total,
        completed_tasks=completed,
        avg_completion_rate=avg_rate,
        streak_days=streak,
        debt_count=debt_count,
        days_ahead_or_behind=days_delta,
    )


async def _calc_streak(db: AsyncSession, goal_id: str) -> int:
    """计算从今天往前连续打卡天数"""
    streak = 0
    check_date = date.today()
    while True:
        result = await db.execute(
            select(func.count()).where(
                Task.goal_id == goal_id,
                Task.scheduled_date == check_date,
                Task.status.in_(["completed", "partial"]),
            )
        )
        if result.scalar_one() == 0:
            break
        streak += 1
        check_date -= timedelta(days=1)
    return streak


# app/schemas/goal.py（补充 GoalProgressResponse）
class GoalProgressResponse(BaseModel):
    goal_id: str
    title: str
    deadline: str
    total_tasks: int
    completed_tasks: int
    avg_completion_rate: float
    streak_days: int
    debt_count: int
    days_ahead_or_behind: int
```

---

## 三十一、Plans API 实现

```python
# app/api/v1/plans.py
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from datetime import date
from app.models.plan import Plan
from app.models.task import Task, TaskStatus
from app.core.database import get_db
from app.api.v1.auth import get_current_user

router = APIRouter(prefix="/plans", tags=["plans"])


@router.get("/{goal_id}/current")
async def get_current_plan(
    goal_id: str,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Plan).where(
            Plan.goal_id == goal_id,
            Plan.is_current == True,
        ).order_by(Plan.version.desc()).limit(1)
    )
    plan = result.scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail="尚未生成计划，请先通过 AI 对话创建")
    return {"id": str(plan.id), "version": plan.version, "content": plan.content}


@router.get("/{goal_id}/today")
async def get_today_tasks(
    goal_id: str,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """返回今日任务，并标记当前完成状态"""
    today = date.today()

    # 先查当前有效计划
    plan_q = await db.execute(
        select(Plan).where(Plan.goal_id == goal_id, Plan.is_current == True).limit(1)
    )
    plan = plan_q.scalar_one_or_none()
    if not plan:
        return []

    # 查今日任务
    tasks_q = await db.execute(
        select(Task).where(
            Task.goal_id == goal_id,
            Task.scheduled_date == today,
        ).order_by(Task.id)
    )
    tasks = tasks_q.scalars().all()

    return [
        {
            "id": str(t.id),
            "title": t.title,
            "estimated_mins": t.estimated_mins,
            "status": t.status,
            "type": t.type if hasattr(t, "type") else "study",
            "kb_refs": t.kb_refs or [],
            "mastery_level": t.mastery_level,}
        for t in tasks
    ]


@router.post("/{goal_id}/confirm")
async def confirm_plan(
    goal_id: str,
    body: dict,   # {"plan_json": {...}}
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    用户确认 AI 生成的计划后，持久化为 Plan + 展开为Task 记录
    """
    plan_json = body.get("plan_json")
    if not plan_json:
        raise HTTPException(status_code=422, detail="缺少 plan_json")

    # 废弃旧计划
    old_q = await db.execute(
        select(Plan).where(Plan.goal_id == goal_id, Plan.is_current == True)
    )
    for old in old_q.scalars().all():
        old.is_current = False

    # 新计划版本号
    version_q = await db.execute(
        select(func.max(Plan.version)).where(Plan.goal_id == goal_id)
    )
    new_version = (version_q.scalar_one() or 0) + 1

    plan = Plan(
        goal_id=goal_id,
        version=new_version,
        is_current=True,
        baseline=plan_json,    # 原始快照
        content=plan_json,)
    db.add(plan)
    await db.flush()  # 获取 plan.id

    # 展开计划为每日Task 记录
    goal_q = await db.get(Goal, goal_id)
    start_date = date.today()

    tasks_to_add = []
    for phase in plan_json.get("phases", []):
        for week in phase.get("weeks", []):
            for task_data in week.get("tasks", []):
                scheduled = start_date + timedelta(days=task_data["day_offset"])
                tasks_to_add.append(Task(
                    plan_id=plan.id,
                    goal_id=goal_id,
                    scheduled_date=scheduled,
                    title=task_data["title"],
                    estimated_mins=task_data["estimated_mins"],
                    status=TaskStatus.pending,
                    kb_refs=task_data.get("kb_tags", []),
                ))

    db.add_all(tasks_to_add)
    await db.commit()

    return {
        "plan_id": str(plan.id),
        "version": new_version,
        "tasks_created": len(tasks_to_add),
    }
```

---

## 三十二、文档完结：完整文件清单

```
planpilot/
├── .env.example                    ✅ 第十一节
├── .github/
│   ├── workflows/ci.yml            ✅ 第十三节
│   └── workflows/deploy.yml        ✅ 第十三节
├── docker-compose.yml              ✅ 第十二节
├── scripts/
│   └── dev-setup.sh                ✅ 第二十八节
│
├── apps/
│   ├── api/
│   │   ├── pyproject.toml          ✅ 第二十二节
│   │   ├── Dockerfile              ✅ 第二十二节
│   │   ├── railway.toml            ✅ 第二十二节
│   │├── alembic/
│   │   │   ├── env.py              ✅ 第二十节
│   │   │   └── versions/001_init_schema.py ✅ 第二十节
│   │   └── app/
│   │       ├── main.py             ✅ 第十二节
│   │       ├── core/
│   │       │   ├── config.py       ✅ 第十一节
│   │       │   ├── database.py     ✅ 第三节
│   │       │   ├── cache.py        （Redis 封装，参照 rate_limit中的用法）
│   │       │   ├── llm.py          ✅ 第四节
│   │       │   ├── exceptions.py   ✅ 第十八节
│   │       │   ├── rate_limit.py   ✅ 第十九节
│   │       │   ├── observability.py ✅ 第十节
│   │       │   └── agent/
│   │       │       ├── graph.py    ✅ 第五节
│   │       │       ├── state.py    ✅ 第五节
│   │       │       ├── nodes/
│   │       │       │   ├── intent.py   （基于INTENT_CLASSIFICATION_PROMPT）
│   │       │       │   ├── planner.py  ✅ 第五节
│   │       │       │   ├── replan.py   （基于 REPLAN_PROMPT）
│   │       │       │   ├── checkin.py  ✅ 第五节
│   │       │       │   ├── verify.py   ✅ 第五节
│   │       │       │   └── chat.py     （RAG + 自由对话）
│   │       │       └── tools/
│   │       │           ├── search.py   ✅ 第五节
│   │       │           └── kb_search.py ✅ 第五节
│   │       ├── prompts/
│   │       │   ├── planner.py      ✅ 第九节
│   │       │   ├── replan.py       ✅ 第九节
│   │       │   ├── verify.py       ✅ 第九节
│   │       │   └── intent.py       ✅ 第九节
│   │       ├── models/
│   │       │   ├── base.py         ✅ 第三节
│   │       │   ├── user.py         ✅ 第三节
│   │       │   ├── goal.py         ✅ 第三节
│   │       │   ├── plan.py✅ 第三节
│   │       │   ├── task.py         （参照 tasks表结构）
│   │       │   ├── debt.py         （参照 learning_debts 表结构）
│   │       │   └── knowledge.py    ✅ 第三节
│   │       ├── schemas/
│   │       │   ├── auth.py         ✅ 第十七节
│   │       │   ├── goal.py         ✅ 第十七节+ 第三十节
│   │       │   ├── checkin.py      ✅ 第十七节
│   │       │   └── agent.py        ✅ 第十七节
│   │       ├── api/v1/
│   │       │   ├── auth.py         ✅ 第十六节
│   │       │   ├── goals.py        ✅ 第三十节
│   │       │   ├── plans.py        ✅ 第三十一节
│   │       │   ├── checkin.py      ✅ 第六节
│   │       │   ├── knowledge.py    ✅ 第六节
│   │       │   └── agent.py        ✅ 第六节
│   │       └── services/
│   │           ├── checkin_service.py ✅ 第六节
│   │           └── kb_service.py   （封装 kb_search + kb_write）
│   │
│   ├── web/
│   │   ├── package.json            ✅ 第二十三节
│   │   ├── app/
│   │   │   ├── (auth)/login/page.tsx        （标准登录表单）
│   │   │   ├── (dashboard)/layout.tsx       ✅ 第二十六节
│   │   │   ├── (dashboard)/goals/[id]/page.tsx ✅ 第二十六节
│   │   │   ├── (dashboard)/goals/new/page.tsx  ✅ 第二十六节
│   │   │   └── api/stream/route.ts          ✅ 第八节
│   │   ├── components/
│   │   │   ├── agent/
│   │   │   │   ├── ChatWindow.tsx   ✅ 第八节
│   │   │   │   ├── PlanCard.tsx     ✅ 第二十五节
│   │   │   │   ├── CheckinForm.tsx  ✅ 第八节
│   │   │   │   └── （CheckinPanel 已整合至首页 TodayTasksPanel Tab，无独立文件）
│   │   │   ├── goal/
│   │   │   │   └── ProgressOverview.tsx ✅ 第二十七节
│   │   │   └── layout/
│   │   │       └── Sidebar.tsx      （目标列表导航）
│   │   └── lib/
│   │       ├── api.ts               ✅ 第二十三节
│   │       └── stores/
│   │           ├── goalStore.ts     ✅ 第二十四节
│   │           └── chatStore.ts     ✅ 第二十四节
│   │
│   └── worker/
│       ├── celery_app.py            ✅ 第七节
│       └── tasks/
│           ├── kb_process.py        ✅ 第七节
│           ├── notifications.py     ✅ 第七节
│           └── replan_check.py      （定时偏差检测，触发重规划）
│
└── tests/
    ├── conftest.py                  ✅ 第二十一节
    ├── test_goals.py                ✅ 第二十一节
    ├── test_agent.py                ✅ 第二十一节
    └── test_knowledge.py            ✅ 第二十一节
```

---

## 文档总结

至此，PlanPilot 0→1 技术文档全部输出完毕，完整覆盖：

**后端（32个模块）**
- FastAPI 应用结构、认证、限流、异常处理
- LangGraph Agent 引擎：状态图、节点、工具、Prompt
- PostgreSQL + pgvector 数据模型与迁移
- Celery 异步任务：文件处理、定时推送、偏差检测
- 全量API 实现：Goals、Plans、Check-in、Knowledge、Agent

**前端（10个模块）**
- Next.js App Router 布局与路由
- SSE 流式对话组件（含 token 追加、工具状态、确认弹窗）
- Check-in 三模式表单
- 计划卡片渲染
- 进度总览组件
- Zustand 状态管理

**工程化**
- Docker Compose 本地开发环境
- GitHub Actions CI/CD
- Railway 生产部署配置
- 一键初始化脚本

---
该文档覆盖了从数据库设计到 CI/CD 的完整 0→1 实施路径。建议执行顺序：

1. **第1周**：搭环境（docker-compose），跑通数据库迁移，完成 LLM 路由层
2. **第2周**：实现 LangGraph 核心图（意图识别 + 计划生成两条链路）
3. **第3周**：前端 ChatWindow + SSE 联调，check-in 流程端到端
4. **第4周**：知识库模块（上传 + 向量检索），Celery 定时推送
5. **第5-6周**：验收对话、重规划确认、Langfuse 接入，准备内测

按照第十四节的6周执行时间表推进，预计 **第6周末** 可完成内测版本上线。