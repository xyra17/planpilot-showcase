import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import sentry_sdk
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute, request_response
from fastapi.staticfiles import StaticFiles
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy.orm.exc import StaleDataError

import src.api.agent as agent
import src.api.agent_control as agent_control
import src.api.agent_v2 as agent_v2
import src.api.auth as auth
import src.api.checkin as checkin
import src.api.coach_archive as coach_archive
import src.api.debt as debt
import src.api.goals as goals
import src.api.intelligence as intelligence
import src.api.knowledge as knowledge
import src.api.learner as learner
import src.api.model_settings as model_settings
import src.api.notifications as notifications
import src.api.plans as plans
import src.api.privacy as privacy
import src.api.product_evidence as product_evidence
import src.api.schedule as schedule
import src.api.storage_admin as storage_admin
import src.api.tasks as tasks
from src.config import settings
from src.core.llm_router import get_llm_runtime_status
from src.database import engine
from src.domain.errors import DomainVersionConflict
from src.observability import RequestContextMiddleware, configure_logging, configure_telemetry

configure_logging(settings.log_level)
logger = logging.getLogger(__name__)

if settings.sentry_dsn:
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.environment,
        traces_sample_rate=settings.sentry_traces_sample_rate,
    )

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
    from src.services.runtime_model_config import get_runtime_model_config

    runtime_models = get_runtime_model_config()
    if runtime_models.local_enabled and runtime_models.local_base_url:
        from openai import AsyncOpenAI

        from src.core.agent.nodes.chat import _SYSTEM_BASE

        try:
            local_client = AsyncOpenAI(
                api_key=runtime_models.local_api_key or "local",
                base_url=runtime_models.local_base_url,
            )
            await asyncio.wait_for(
                local_client.chat.completions.create(
                    model=runtime_models.local_model_name,
                    messages=[
                        {"role": "system", "content": _SYSTEM_BASE},
                        {"role": "user", "content": "回复好"},
                    ],
                    max_tokens=1,
                    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
                ),
                timeout=15.0,
            )
            logger.info("本地模型热身完成 (base_url=%s)", runtime_models.local_base_url)
        except Exception as e:
            logger.warning("本地模型热身失败，将在首次请求时加载: %s", e)

    yield

    from src.core.agent.graph import close_pool

    await close_pool()
    from src.redis_client import close_redis

    await close_redis()
    await engine.dispose()


app = FastAPI(title="PlanPilot API", version="1.0.0", lifespan=lifespan)
configure_telemetry(app, engine)
avatar_upload_dir = Path(settings.avatar_upload_dir).resolve()
avatar_upload_dir.mkdir(parents=True, exist_ok=True)
app.mount("/media/avatars", StaticFiles(directory=avatar_upload_dir), name="avatars")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


@app.exception_handler(DomainVersionConflict)
async def domain_version_conflict_handler(
    _request: Request, exc: DomainVersionConflict
) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={
            "detail": str(exc),
            "entity": exc.entity,
            "entity_id": exc.entity_id,
            "expected_version": exc.expected,
            "actual_version": exc.actual,
        },
    )


@app.exception_handler(StaleDataError)
async def stale_domain_write_handler(_request: Request, _exc: StaleDataError) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={"detail": "数据已被其他操作更新，请刷新后重试"},
    )


def cors_headers_for_error_response(request: Request) -> dict[str, str]:
    origin = request.headers.get("origin")
    if origin and origin in settings.cors_origin_list:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Vary": "Origin",
        }
    return {}


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("未处理的服务端异常: %s %s", request.method, request.url.path, exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"detail": "服务暂时不可用，请稍后重试"},
        headers=cors_headers_for_error_response(request),
    )


app.add_middleware(RequestContextMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# FastAPI 0.139 defers ``include_router`` into ``_IncludedRouter`` branches.
# With Uvicorn's reload worker those branches currently dispatch to the child
# router's 404 fallback instead of its matched route.  Our domain routers
# already contain their full prefixes, dependencies and response metadata, so
# mounting their concrete routes keeps reload and production workers aligned.
for domain_router in (
    agent.router,
    agent_v2.router,
    agent_control.router,
    auth.router,
    goals.router,
    checkin.router,
    coach_archive.router,
    debt.router,
    tasks.router,
    plans.router,
    privacy.router,
    product_evidence.router,
    knowledge.router,
    intelligence.router,
    learner.router,
    notifications.router,
    model_settings.router,
    schedule.router,
    storage_admin.router,
):
    for route in domain_router.routes:
        # ``routes.extend`` bypasses FastAPI.include_router(), which normally
        # binds the application's dependency override provider to each route.
        # Preserve that binding so test/app-scoped dependency injection cannot
        # silently fall back to a different database session factory.
        if isinstance(route, APIRoute):
            route.dependency_overrides_provider = app
            # APIRoute builds its ASGI handler in __init__; refreshing the
            # provider attribute alone leaves that closure bound to None.
            route.app = request_response(route.get_route_handler())
    app.router.routes.extend(domain_router.routes)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
async def readiness() -> dict[str, str]:
    from sqlalchemy import text

    from src.database import AsyncSessionLocal
    from src.redis_client import get_redis
    from src.services.object_storage import get_object_storage

    async with AsyncSessionLocal() as db:
        await db.execute(text("SELECT 1"))
    redis = get_redis()
    await redis.ping()
    await get_object_storage().healthcheck()
    return {"status": "ready", "database": "ok", "redis": "ok", "storage": "ok"}


@app.get("/health/ai")
async def ai_health() -> dict:
    from src.services.runtime_model_config import get_runtime_model_config

    runtime_models = get_runtime_model_config()
    local_reachable = False
    local_error: str | None = None
    local_models: list[str] = []
    if runtime_models.local_enabled and runtime_models.local_base_url:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{runtime_models.local_base_url.rstrip('/')}/models")
                response.raise_for_status()
                payload = response.json()
                local_models = [
                    row.get("id", "")
                    for row in payload.get("data", [])
                    if isinstance(row, dict) and row.get("id")
                ]
            local_reachable = True
        except Exception as exc:
            local_error = type(exc).__name__

    embedding_reachable = False
    embedding_error: str | None = None
    embedding_models: list[str] = []
    if runtime_models.embedding_enabled and runtime_models.embedding_base_url:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{runtime_models.embedding_base_url.rstrip('/')}/models")
                response.raise_for_status()
                payload = response.json()
                embedding_models = [
                    row.get("id", "")
                    for row in payload.get("data", [])
                    if isinstance(row, dict) and row.get("id")
                ]
            embedding_reachable = True
        except Exception as exc:
            embedding_error = type(exc).__name__

    return {
        **get_llm_runtime_status(),
        "local_reachable": local_reachable,
        "local_error_type": local_error,
        "local_configured_model": runtime_models.local_model_name,
        "local_advertised_models": local_models,
        "local_model_id_exact_match": runtime_models.local_model_name in local_models,
        "embedding_configured": bool(runtime_models.embedding_enabled and runtime_models.embedding_base_url),
        "embedding_reachable": embedding_reachable,
        "embedding_error_type": embedding_error,
        "embedding_configured_model": runtime_models.embedding_model_name,
        "embedding_advertised_models": embedding_models,
        "flash_configured": bool(runtime_models.cloud_enabled and runtime_models.cloud_api_key and runtime_models.cloud_model_name),
        "pro_configured": bool(runtime_models.cloud_enabled and runtime_models.cloud_api_key and runtime_models.cloud_pro_model_name),
        "cloud_routine_configured": bool(runtime_models.cloud_enabled and runtime_models.cloud_api_key and runtime_models.cloud_model_name),
        "cloud_pro_configured": bool(runtime_models.cloud_enabled and runtime_models.cloud_api_key and runtime_models.cloud_pro_model_name),
    }
