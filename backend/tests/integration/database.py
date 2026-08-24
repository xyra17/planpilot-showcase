"""PostgreSQL session factory isolated from the unit-test SQLite database."""

from __future__ import annotations

import os

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

TEST_DB_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://planpilot:password@localhost:5432/planpilot_test",
)

integration_engine = create_async_engine(TEST_DB_URL, echo=False, poolclass=NullPool)
IntegrationSessionLocal = async_sessionmaker(integration_engine, expire_on_commit=False)
