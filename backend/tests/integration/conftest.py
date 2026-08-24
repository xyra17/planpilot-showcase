import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).parent.parent.parent / ".env", override=False)
except ImportError:
    pass

TEST_DB_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://planpilot:password@localhost:5432/planpilot_test",
)

# 1. 覆盖 DATABASE_URL 环境变量，在 import src.main 之前
os.environ["DATABASE_URL"] = TEST_DB_URL
os.environ.setdefault("SECRET_KEY", "integration-test-secret-32chars!!")
os.environ.setdefault("SENTRY_DSN", "")
# SMART_API_KEY / OPENAI_API_KEY 从真实 .env 继承

from src.api.auth import limiter as auth_limiter  # noqa: E402
from src.config import settings  # noqa: E402
from src.database import Base, get_db  # noqa: E402
from src.main import app  # noqa: E402
from tests.integration.database import (  # noqa: E402
    IntegrationSessionLocal,
    integration_engine,
)

# The project-wide unit-test conftest installs an in-memory SQLite factory on
# src.database during collection. Integration tests must restore the isolated
# PostgreSQL factory so production services that open their own sessions test
# the same database as the integration fixtures.
import src.database as database  # noqa: E402

database.engine = integration_engine
database.AsyncSessionLocal = IntegrationSessionLocal

app.state.limiter.enabled = False
auth_limiter.enabled = False

REPORTS_DIR = Path(__file__).parent / "reports"
REPORTS_DIR.mkdir(exist_ok=True)


@pytest.fixture(scope="session", autouse=True)
def _mock_celery():
    """Prevent Celery broker connection errors during tests."""
    with (
        patch("src.tasks.deviation.check_all_deviations.apply_async", return_value=None),
        patch("src.tasks.knowledge.process_knowledge_item.apply_async", return_value=None),
        patch("src.tasks.agent_runs.execute_agent_run.apply_async", return_value=None),
    ):
        yield


@pytest_asyncio.fixture(autouse=True, loop_scope="function")
async def _close_redis_after_test():
    yield
    from src.redis_client import close_redis

    await close_redis()


@pytest.fixture(scope="session", autouse=True)
async def setup_db():
    from sqlalchemy import text

    async with integration_engine.begin() as conn:
        # pgvector 扩展必须在建表前存在
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        # 集成测试库的数据本就会在每次运行时清空。重建 schema 可保证 typed ORM
        # 与最新迁移阶段一致，避免 create_all 无法补列造成旧 schema 假失败。
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
        # FetchedValue 让 SQLite 单测可建表；PostgreSQL 的真实 default 由迁移创建，
        # 因此重建集成测试 schema 后补回对应 sequence/default。
        await conn.execute(text("CREATE SEQUENCE IF NOT EXISTS agent_audit_event_sequence"))
        await conn.execute(text("ALTER SEQUENCE agent_audit_event_sequence RESTART WITH 1"))
        await conn.execute(
            text(
                "ALTER TABLE agent_audit_events ALTER COLUMN sequence "
                "SET DEFAULT nextval('agent_audit_event_sequence')"
            )
        )
    yield
    # 不 drop tables，schema 保留


@pytest.fixture(scope="session")
def shared():
    state = {}
    yield state
    snapshot = REPORTS_DIR / "test_data_snapshot.json"
    snapshot.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


@pytest.fixture(scope="session")
async def client(setup_db):
    async def _override_db():
        async with IntegrationSessionLocal() as db:
            yield db

    app.dependency_overrides[get_db] = _override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.pop(get_db, None)
        await integration_engine.dispose()


@pytest.fixture(scope="session")
def seed():
    return json.loads((Path(__file__).parent / "fixtures/seed_data.json").read_text())


@pytest.fixture(scope="session")
async def auth_headers(client, shared, seed):
    r = await client.post("/api/v1/auth/register", json=seed["user"])
    if r.status_code == 400:
        # 用户已存在（上次运行数据保留），直接登录
        r = await client.post(
            "/api/v1/auth/login",
            json={"email": seed["user"]["email"], "password": seed["user"]["password"]},
        )
    assert r.status_code in (200, 201), r.text
    token = r.cookies.get(settings.auth_access_cookie_name)
    assert token
    shared["user"] = r.json().get("user", {})
    shared["token"] = token
    return {"Authorization": f"Bearer {token}"}
