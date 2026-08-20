from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.config import Settings
from src.release_gate import migration_heads, verify_release_readiness


def production_settings(**overrides) -> Settings:
    values = {
        "secret_key": "production-secret-key-with-more-than-32-characters",
        "environment": "production",
        "frontend_url": "https://planpilot.example.com",
        "cors_origins": "https://planpilot.example.com",
        "auth_cookie_secure": True,
        "storage_backend": "s3",
        "storage_s3_access_key": "test-access",
        "storage_s3_secret_key": "test-secret",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def test_production_configuration_requires_https_origins_and_secure_cookies():
    assert production_settings().secure_auth_cookies is True
    with pytest.raises(ValueError, match="FRONTEND_URL"):
        production_settings(frontend_url="http://planpilot.example.com")
    with pytest.raises(ValueError, match="CORS_ORIGINS"):
        production_settings(cors_origins="https://planpilot.example.com/api")
    with pytest.raises(ValueError, match="CORS_ORIGINS"):
        production_settings(cors_origins="*")
    with pytest.raises(ValueError, match="Cookie"):
        production_settings(auth_cookie_secure=False)
    with pytest.raises(ValueError, match="对象存储"):
        production_settings(storage_backend="local")


def test_repository_has_one_migration_head():
    assert len(migration_heads()) == 1


@pytest.mark.asyncio
async def test_release_gate_rejects_schema_drift(monkeypatch):
    fake_connection = AsyncMock()
    fake_result = MagicMock()
    fake_result.scalars.return_value = ["old-revision"]
    fake_connection.execute.return_value = fake_result
    fake_connection.scalar.return_value = True
    context = AsyncMock()
    context.__aenter__.return_value = fake_connection

    fake_engine = MagicMock()
    fake_engine.connect.return_value = context
    monkeypatch.setattr("src.release_gate.engine", fake_engine)
    with patch("src.release_gate.migration_heads", return_value={"expected-revision"}):
        with pytest.raises(RuntimeError, match="数据库迁移版本不一致"):
            await verify_release_readiness()
