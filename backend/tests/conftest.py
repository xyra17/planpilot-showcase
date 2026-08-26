import uuid
from contextlib import asynccontextmanager
from datetime import date, timedelta
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

# ── 1. Patch src.database BEFORE importing src.main ──────────────
import src.database as _db
from src.config import settings as _settings

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


@pytest.fixture(autouse=True)
def _deterministic_agent_planner():
    with (
        patch(
            "src.core.agent_v2.planner.create_json_llm",
            side_effect=RuntimeError("model planner disabled in unit tests"),
        ),
        patch.object(_settings, "coach_agent_enabled", False),
        patch(
            "src.services.evaluation_v2_service.run_agent_v25_runtime_gate",
            new_callable=AsyncMock,
            return_value={
                "status": "passed",
                "metrics": {
                    "critical_safety_pass_rate": 1.0,
                    "unconfirmed_write_violations": 0,
                    "cross_user_write_violations": 0,
                    "duplicate_write_violations": 0,
                },
                "failures": [],
                "dataset_hash": "unit-runtime-gate-stub",
            },
        ),
    ):
        yield


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


@pytest_asyncio.fixture(autouse=True)
async def _stable_beta_control_between_tests(db: AsyncSession):
    """A safety-stop test must not disable unrelated tests in the shared SQLite DB."""
    from src.models import AgentBetaControl

    async def reset() -> None:
        row = await db.get(AgentBetaControl, "action-beta")
        if row is not None:
            row.beta_enabled = False
            row.new_action_runs_enabled = True
            row.cohort_mode = "allowlist"
            row.traffic_percent = 0
            row.allowlisted_user_ids = []
            row.paused_reason = None
            row.safety_snapshot = {}
            await db.commit()

    await reset()
    yield
    await reset()


# ── 5. Per-test HTTP client with DB override ──────────────────────
@pytest_asyncio.fixture
async def client(db: AsyncSession) -> AsyncClient:
    async def _override():
        yield db

    previous_db_override = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override
    redis_mock = AsyncMock()
    redis_mock.exists.return_value = 0
    with (
        patch("src.tasks.knowledge.process_knowledge_item.apply_async", return_value=None),
        patch("src.tasks.media_preview.process_media_preview.apply_async", return_value=None),
        patch("src.tasks.agent_runs.execute_agent_run.apply_async", return_value=None),
        patch("src.services.checkin_service._dispatch_deviation_check", return_value=None),
        patch(
            "src.tasks.email_verification.send_email_verification.apply_async", return_value=None
        ),
        patch("src.tasks.password_recovery.send_password_reset.apply_async", return_value=None),
        patch("src.redis_client.get_redis", return_value=redis_mock),
    ):
        test_host = f"test-{uuid.uuid4().hex}"
        async with AsyncClient(
            transport=ASGITransport(app=app, client=(test_host, 123)),
            base_url="http://test",
        ) as c:
            yield c
    if previous_db_override is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous_db_override


# ── 6. Auth helpers ───────────────────────────────────────────────
def _rand_creds() -> dict:
    uid = uuid.uuid4().hex[:8]
    return {"email": f"{uid}@test.com", "username": uid, "password": "testpass123"}


@pytest_asyncio.fixture
async def user_token(client: AsyncClient) -> str:
    r = await client.post("/api/v1/auth/register", json=_rand_creds())
    assert r.status_code == 201, r.text
    token = client.cookies.get(_settings.auth_access_cookie_name)
    assert token
    return token


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
