"""Run Runtime Safety Gate in an isolated DB and import only its proof.

Usage:
  BETA_VALIDATION_DATABASE_URL=postgresql+asyncpg://.../planpilot_validation \
  DATABASE_URL=postgresql+asyncpg://.../planpilot \
  uv run python scripts/run_beta_runtime_gate.py
"""

from __future__ import annotations

import asyncio
import os
from urllib.parse import urlsplit

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

import src.database as database
from src.config import settings
from src.core.time import utc_now
from src.services.beta_evidence_service import persist_runtime_gate_proof, runtime_gate_status
from src.services.evaluation_v2_service import run_agent_v25_runtime_gate


def _database_name(url: str) -> str:
    return urlsplit(url.replace("+asyncpg", "")).path.rstrip("/")


async def main() -> None:
    validation_url = os.environ.get("BETA_VALIDATION_DATABASE_URL", "")
    control_url = os.environ.get("BETA_CONTROL_DATABASE_URL", settings.database_url)
    if not validation_url:
        raise SystemExit("BETA_VALIDATION_DATABASE_URL is required")
    if _database_name(validation_url) == _database_name(control_url):
        raise SystemExit("Validation and control databases must be different")

    validation_engine = create_async_engine(validation_url, poolclass=NullPool)
    validation_factory = async_sessionmaker(validation_engine, expire_on_commit=False)
    control_engine = create_async_engine(control_url, poolclass=NullPool)
    control_factory = async_sessionmaker(control_engine, expire_on_commit=False)
    original_engine = database.engine
    original_factory = database.AsyncSessionLocal
    started_at = utc_now()
    try:
        database.engine = validation_engine
        database.AsyncSessionLocal = validation_factory
        async with validation_factory() as validation_db:
            isolated = await run_agent_v25_runtime_gate(validation_db, "beta-runtime-gate")
        database.engine = control_engine
        database.AsyncSessionLocal = control_factory
        async with control_factory() as control_db:
            imported = await persist_runtime_gate_proof(
                control_db,
                actor="beta-runtime-gate",
                validation_result=isolated,
                started_at=started_at,
                validation_gate_id=isolated.get("id"),
            )
            status = await runtime_gate_status(control_db)
        print(
            {
                "imported_gate_id": imported["id"],
                "status": status["status"],
                "valid": status["valid"],
                "blockers": status["blockers"],
                "expires_at": status.get("expires_at"),
                "dataset_hash": status.get("dataset_hash"),
            }
        )
        if not status["valid"]:
            raise SystemExit(1)
    finally:
        database.engine = original_engine
        database.AsyncSessionLocal = original_factory
        await validation_engine.dispose()
        await control_engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
