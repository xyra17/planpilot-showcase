"""Encrypted, hot-reloadable model runtime configuration shared by API and workers."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from src.config import settings

_lock = RLock()
_cached_signature: tuple[int, int] | None = None
_cached_config: "RuntimeModelConfig | None" = None


@dataclass(frozen=True)
class RuntimeModelConfig:
    local_enabled: bool
    local_base_url: str
    local_model_name: str
    local_api_key: str
    cloud_enabled: bool
    cloud_provider: str
    cloud_base_url: str
    cloud_model_name: str
    cloud_pro_model_name: str
    cloud_api_key: str
    embedding_enabled: bool
    embedding_base_url: str
    embedding_model_name: str
    embedding_api_key: str
    embedding_dimensions: int
    coach_agent_enabled: bool
    updated_at: str | None = None
    updated_by: str | None = None


def _fallback() -> RuntimeModelConfig:
    return RuntimeModelConfig(
        local_enabled=settings.local_model_enabled,
        local_base_url=settings.openai_base_url,
        local_model_name=settings.model_name,
        local_api_key=settings.openai_api_key or "local",
        cloud_enabled=bool(settings.smart_api_key and settings.smart_model_name),
        cloud_provider="custom",
        cloud_base_url=settings.smart_base_url,
        cloud_model_name=settings.smart_model_name,
        cloud_pro_model_name=settings.smart_pro_model_name,
        cloud_api_key=settings.smart_api_key,
        embedding_enabled=bool(settings.embedding_base_url),
        embedding_base_url=settings.embedding_base_url,
        embedding_model_name=settings.embedding_model_name,
        embedding_api_key=settings.embedding_api_key or "local",
        embedding_dimensions=settings.embedding_dimensions,
        coach_agent_enabled=settings.coach_agent_enabled,
    )


def config_path() -> Path:
    return Path(settings.runtime_model_config_path).expanduser().resolve()


def _fernet() -> Fernet:
    digest = hashlib.sha256(settings.secret_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii") if value else ""


def _decrypt(value: str) -> str:
    if not value:
        return ""
    try:
        return _fernet().decrypt(value.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return ""


def _read_document() -> dict[str, Any] | None:
    target = config_path()
    try:
        return json.loads(target.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def _from_document(document: dict[str, Any]) -> RuntimeModelConfig:
    local = document.get("local") or {}
    cloud = document.get("cloud") or {}
    embedding = document.get("embedding") or {}
    fallback = _fallback()
    return RuntimeModelConfig(
        local_enabled=bool(local.get("enabled", fallback.local_enabled)),
        local_base_url=str(local.get("base_url", fallback.local_base_url)).strip(),
        local_model_name=str(local.get("model_name", fallback.local_model_name)).strip(),
        local_api_key=_decrypt(str(local.get("api_key", ""))) or "local",
        cloud_enabled=bool(cloud.get("enabled", False)),
        cloud_provider=str(cloud.get("provider", "custom")).strip() or "custom",
        cloud_base_url=str(cloud.get("base_url", "")).strip(),
        cloud_model_name=str(cloud.get("model_name", "")).strip(),
        cloud_pro_model_name=str(cloud.get("pro_model_name", "")).strip(),
        cloud_api_key=_decrypt(str(cloud.get("api_key", ""))),
        embedding_enabled=bool(embedding.get("enabled", fallback.embedding_enabled)),
        embedding_base_url=str(embedding.get("base_url", fallback.embedding_base_url)).strip(),
        embedding_model_name=str(embedding.get("model_name", fallback.embedding_model_name)).strip(),
        embedding_api_key=_decrypt(str(embedding.get("api_key", ""))) or "local",
        embedding_dimensions=int(embedding.get("dimensions", 1024)),
        coach_agent_enabled=bool(document.get("coach_agent_enabled", fallback.coach_agent_enabled)),
        updated_at=document.get("updated_at"),
        updated_by=document.get("updated_by"),
    )


def get_runtime_model_config() -> RuntimeModelConfig:
    global _cached_config, _cached_signature
    target = config_path()
    try:
        stat = target.stat()
        signature = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        return _fallback()
    with _lock:
        if _cached_config is not None and _cached_signature == signature:
            return _cached_config
        document = _read_document()
        _cached_config = _from_document(document) if document else _fallback()
        _cached_signature = signature
        return _cached_config


def public_runtime_model_config() -> dict[str, Any]:
    config = get_runtime_model_config()
    payload = asdict(config)
    payload.pop("local_api_key")
    payload.pop("cloud_api_key")
    payload.pop("embedding_api_key")
    payload["local_api_key_configured"] = bool(config.local_api_key)
    payload["cloud_api_key_configured"] = bool(config.cloud_api_key)
    payload["embedding_api_key_configured"] = bool(config.embedding_api_key)
    return payload


def save_runtime_model_config(payload: dict[str, Any], *, actor: str) -> dict[str, Any]:
    global _cached_config, _cached_signature
    current_document = _read_document() or {}
    current = get_runtime_model_config()

    def secret(section: str, field: str, clear_field: str, fallback: str) -> str:
        if payload.get(clear_field):
            return ""
        provided = str(payload.get(field) or "").strip()
        if provided:
            return _encrypt(provided)
        existing = str((current_document.get(section) or {}).get("api_key") or "")
        return existing or _encrypt(fallback)

    document = {
        "version": 1,
        "coach_agent_enabled": bool(payload["coach_agent_enabled"]),
        "local": {
            "enabled": bool(payload["local_enabled"]),
            "base_url": str(payload["local_base_url"]).strip(),
            "model_name": str(payload["local_model_name"]).strip(),
            "api_key": secret("local", "local_api_key", "clear_local_api_key", current.local_api_key),
        },
        "cloud": {
            "enabled": bool(payload["cloud_enabled"]),
            "provider": str(payload["cloud_provider"]).strip(),
            "base_url": str(payload["cloud_base_url"]).strip(),
            "model_name": str(payload["cloud_model_name"]).strip(),
            "pro_model_name": str(payload["cloud_pro_model_name"]).strip(),
            "api_key": secret("cloud", "cloud_api_key", "clear_cloud_api_key", current.cloud_api_key),
        },
        "embedding": {
            "enabled": bool(payload["embedding_enabled"]),
            "base_url": str(payload["embedding_base_url"]).strip(),
            "model_name": str(payload["embedding_model_name"]).strip(),
            "dimensions": int(payload["embedding_dimensions"]),
            "api_key": secret("embedding", "embedding_api_key", "clear_embedding_api_key", current.embedding_api_key),
        },
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "updated_by": actor,
    }
    target = config_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(f"{target.suffix}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)
    with _lock:
        _cached_config = None
        _cached_signature = None
    return public_runtime_model_config()
