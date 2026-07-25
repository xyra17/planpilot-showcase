import logging
from contextlib import asynccontextmanager

import sentry_sdk
import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

import src.api.agent as agent
import src.api.auth as auth
import src.api.checkin as checkin
import src.api.debt as debt
import src.api.goals as goals
import src.api.knowledge as knowledge
import src.api.notifications as notifications
import src.api.plans as plans
import src.api.schedule as schedule
import src.api.tasks as tasks
from src.config import settings
from src.database import engine

logger = logging.getLogger(__name__)

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.processors.JSONRenderer(),
    ]
)

if settings.sentry_dsn:
    sentry_sdk.init(dsn=settings.sentry_dsn, traces_sample_rate=0.1)

limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=settings.redis_url,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 数据库结构由 alembic upgrade head 管理，此处不自动建表
    from src.core.agent.graph import get_agent
    await get_agent()

    # 本地模型热身：若配置了本地推理端点，提前触发模型加载以消除首次请求的冷启动延迟
    if settings.openai_base_url:
        from openai import AsyncOpenAI
        try:
            local_client = AsyncOpenAI(
                api_key=settings.openai_api_key or "local",
                base_url=settings.openai_base_url,
            )
            await local_client.chat.completions.create(
                model=settings.model_name,
                messages=[{"role": "user", "content": "hi"}],
                max_tokens=1,
            )
            logger.info("本地模型热身完成 (base_url=%s)", settings.openai_base_url)
        except Exception as e:
            logger.warning("本地模型热身失败，将在首次请求时加载: %s", e)

    yield

    from src.core.agent.graph import close_pool
    await close_pool()
    from src.redis_client import close_redis
    await close_redis()
    await engine.dispose()


app = FastAPI(title="PlanPilot API", version="1.0.0", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(agent.router)
app.include_router(auth.router)
app.include_router(goals.router)
app.include_router(checkin.router)
app.include_router(debt.router)
app.include_router(tasks.router)
app.include_router(plans.router)
app.include_router(knowledge.router)
app.include_router(notifications.router)
app.include_router(schedule.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
