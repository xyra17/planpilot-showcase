import uuid
from contextlib import asynccontextmanager
from datetime import date, timedelta
from unittest.mock import AsyncMock, patch

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

# ── 1. Patch src.database BEFORE importing src.main ──────────────
import src.database as _db

_TEST_ENGINE = create_async_engine(
    "sqlite+aiosqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
_TestSession = async_sessionmaker(_TEST_ENGINE, expire_on_commit=False)
_db.engine = _TEST_ENGINE
_db.AsyncSessionLocal = _TestSession

# ── 2. Import app + override lifespan (prevent engine.dispose) ───
from src.database import Base, get_db  # noqa: E402
from src.main import app  # noqa: E402

app.state.limiter.enabled = False


@asynccontextmanager
async def _noop_lifespan(app):
    yield


app.router.lifespan_context = _noop_lifespan


# ── 3. Create tables once per session ────────────────────────────
@pytest_asyncio.fixture(scope="session", autouse=True)
async def _setup_db():
    async with _TEST_ENGINE.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    await _TEST_ENGINE.dispose()


# ── 4. Per-test DB session ────────────────────────────────────────
@pytest_asyncio.fixture
async def db() -> AsyncSession:
    async with _TestSession() as s:
        yield s


# ── 5. Per-test HTTP client with DB override ──────────────────────
@pytest_asyncio.fixture
async def client(db: AsyncSession) -> AsyncClient:
    async def _override():
        yield db

    app.dependency_overrides[get_db] = _override
    redis_mock = AsyncMock()
    redis_mock.exists.return_value = 0
    with (
        patch("src.tasks.knowledge.process_knowledge_item.apply_async", return_value=None),
        patch("src.tasks.agent_runs.execute_agent_run.apply_async", return_value=None),
        patch("src.redis_client.get_redis", return_value=redis_mock),
    ):
        test_host = f"test-{uuid.uuid4().hex}"
        async with AsyncClient(
            transport=ASGITransport(app=app, client=(test_host, 123)),
            base_url="http://test",
        ) as c:
            yield c
    app.dependency_overrides.clear()


# ── 6. Auth helpers ───────────────────────────────────────────────
def _rand_creds() -> dict:
    uid = uuid.uuid4().hex[:8]
    return {"email": f"{uid}@test.com", "username": uid, "password": "testpass123"}


@pytest_asyncio.fixture
async def user_token(client: AsyncClient) -> str:
    r = await client.post("/api/v1/auth/register", json=_rand_creds())
    assert r.status_code == 201, r.text
    return r.json()["access_token"]


@pytest_asyncio.fixture
async def auth(user_token: str) -> dict:
    return {"Authorization": f"Bearer {user_token}"}


# ── 7. Reusable goal fixture ──────────────────────────────────────
@pytest_asyncio.fixture
async def goal_id(client: AsyncClient, auth: dict) -> str:
    deadline = (date.today() + timedelta(days=365)).isoformat()
    r = await client.post(
        "/api/v1/goals",
        json={"type": "skill", "title": "测试目标", "deadline": deadline, "daily_hours": 2.0},
        headers=auth,
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]
