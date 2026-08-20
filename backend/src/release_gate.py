"""Fail-fast deployment gate for configuration, schema and dependencies."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text

from src.config import settings
from src.database import engine
from src.redis_client import close_redis, get_redis


def migration_heads() -> set[str]:
    backend_root = Path(__file__).resolve().parents[1]
    config = Config(str(backend_root / "alembic.ini"))
    config.set_main_option("script_location", str(backend_root / "alembic"))
    return set(ScriptDirectory.from_config(config).get_heads())


async def verify_release_readiness() -> dict[str, object]:
    expected_heads = migration_heads()
    if len(expected_heads) != 1:
        raise RuntimeError(f"Alembic 必须只有一个 head，当前为 {sorted(expected_heads)}")

    async with engine.connect() as connection:
        current_heads = set(
            (await connection.execute(text("SELECT version_num FROM alembic_version"))).scalars()
        )
        vector_extension = await connection.scalar(
            text("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')")
        )

    if current_heads != expected_heads:
        raise RuntimeError(
            f"数据库迁移版本不一致：current={sorted(current_heads)} expected={sorted(expected_heads)}"
        )
    if not vector_extension:
        raise RuntimeError("PostgreSQL vector 扩展未安装")

    redis = get_redis()
    if not await redis.ping():
        raise RuntimeError("Redis PING 失败")

    return {
        "status": "ready",
        "environment": settings.environment,
        "migration_heads": sorted(current_heads),
        "database": "ok",
        "vector_extension": "ok",
        "redis": "ok",
        "secure_auth_cookies": settings.secure_auth_cookies,
    }


async def _main() -> None:
    try:
        print(json.dumps(await verify_release_readiness(), ensure_ascii=False, sort_keys=True))
    finally:
        await close_redis()
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(_main())
