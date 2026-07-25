import asyncio
import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest
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

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

# 父级 conftest 已将 src.database.engine 替换为 SQLite，这里重新 patch 为 PostgreSQL
# NullPool 避免 asyncpg 连接池与事件循环的并发冲突
import src.database as _db  # noqa: E402

_PG_ENGINE = create_async_engine(TEST_DB_URL, echo=False, poolclass=NullPool)
_PGSession = async_sessionmaker(_PG_ENGINE, expire_on_commit=False)
_db.engine = _PG_ENGINE
_db.AsyncSessionLocal = _PGSession

from src.database import Base  # noqa: E402
from src.main import app  # noqa: E402

REPORTS_DIR = Path(__file__).parent / "reports"
REPORTS_DIR.mkdir(exist_ok=True)


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session", autouse=True)
def _mock_celery():
    """Prevent Celery broker connection errors during tests."""
    with (
        patch("src.tasks.deviation.check_all_deviations.apply_async", return_value=None),
        patch("src.tasks.knowledge.process_knowledge_item.apply_async", return_value=None),
    ):
        yield


@pytest.fixture(scope="session", autouse=True)
async def setup_db():
    from sqlalchemy import text
    async with _PG_ENGINE.begin() as conn:
        # pgvector 扩展必须在建表前存在
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.create_all)
        # 清空上次运行遗留数据（保留 schema），确保测试幂等
        for table in reversed(Base.metadata.sorted_tables):
            await conn.execute(table.delete())
    yield
    # 不 drop tables，schema 保留


@pytest.fixture(scope="session")
def shared():
    state = {}
    yield state
    snapshot = REPORTS_DIR / "test_data_snapshot.json"
    snapshot.write_text(
        json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8"
    )


@pytest.fixture(scope="session")
async def client(setup_db):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac
    from src.redis_client import close_redis

    await close_redis()


@pytest.fixture(scope="session")
def seed():
    return json.loads(
        (Path(__file__).parent / "fixtures/seed_data.json").read_text()
    )


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
    token = r.json()["access_token"]
    shared["user"] = r.json().get("user", {})
    shared["token"] = token
    return {"Authorization": f"Bearer {token}"}
