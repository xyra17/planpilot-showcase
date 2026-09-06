"""Administrator-only runtime model settings and connection probes."""

from __future__ import annotations

from typing import Literal
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, model_validator

from src.deps import get_current_admin
from src.models import User
from src.services.runtime_model_config import (
    RuntimeModelConfig,
    get_runtime_model_config,
    public_runtime_model_config,
    save_runtime_model_config,
)

router = APIRouter(prefix="/api/v1/admin/model-settings", tags=["admin-model-settings"])


def _validate_endpoint(value: str, field: str) -> str:
    value = value.strip().rstrip("/")
    if not value:
        return ""
    parsed = urlsplit(value)
    if parsed.scheme == "https" and parsed.netloc:
        return value
    if parsed.scheme == "http" and parsed.hostname in {
        "localhost", "127.0.0.1", "host.docker.internal",
    }:
        return value
    raise ValueError(f"{field}：远程地址必须使用 HTTPS，本机地址可使用 HTTP")


class ModelSettingsUpdate(BaseModel):
    local_enabled: bool = True
    local_base_url: str = Field(max_length=500)
    local_model_name: str = Field(max_length=500)
    local_api_key: str = Field(default="", max_length=1000)
    local_max_concurrency: int = Field(default=1, ge=1, le=32)
    clear_local_api_key: bool = False
    cloud_enabled: bool = False
    cloud_provider: Literal["deepseek", "zhipu", "doubao", "custom"] = "deepseek"
    cloud_base_url: str = Field(default="", max_length=500)
    cloud_model_name: str = Field(default="", max_length=300)
    cloud_pro_model_name: str = Field(default="", max_length=300)
    cloud_api_key: str = Field(default="", max_length=1000)
    cloud_routine_max_concurrency: int = Field(default=4, ge=1, le=32)
    cloud_pro_max_concurrency: int = Field(default=1, ge=1, le=32)
    clear_cloud_api_key: bool = False
    embedding_enabled: bool = True
    embedding_base_url: str = Field(max_length=500)
    embedding_model_name: str = Field(max_length=500)
    embedding_api_key: str = Field(default="", max_length=1000)
    clear_embedding_api_key: bool = False
    embedding_dimensions: int = 1024
    embedding_max_concurrency: int = Field(default=1, ge=1, le=32)
    coach_agent_enabled: bool = True

    @model_validator(mode="after")
    def validate_contract(self) -> "ModelSettingsUpdate":
        self.local_base_url = _validate_endpoint(self.local_base_url, "本地模型地址")
        self.cloud_base_url = _validate_endpoint(self.cloud_base_url, "云端模型地址")
        self.embedding_base_url = _validate_endpoint(self.embedding_base_url, "Embedding 地址")
        if self.local_enabled and not (self.local_base_url and self.local_model_name):
            raise ValueError("启用本地模型时必须填写地址和模型名")
        if self.cloud_enabled and not (self.cloud_base_url and self.cloud_model_name):
            raise ValueError("启用云端模型时必须填写地址和模型名")
        if self.embedding_enabled and not (self.embedding_base_url and self.embedding_model_name):
            raise ValueError("启用 Embedding 时必须填写地址和模型名")
        if self.embedding_dimensions != 1024:
            raise ValueError("Embedding 维度必须为 1024，与数据库 vector(1024) 一致")
        return self


class ProbeResult(BaseModel):
    target: str
    configured: bool
    reachable: bool
    model_match: bool
    advertised_models: list[str]
    detail: str


async def _probe(target: str, enabled: bool, base_url: str, api_key: str, model: str) -> ProbeResult:
    if not enabled:
        return ProbeResult(target=target, configured=False, reachable=False, model_match=False, advertised_models=[], detail="未启用")
    if not base_url or not model:
        return ProbeResult(target=target, configured=False, reachable=False, model_match=False, advertised_models=[], detail="配置不完整")
    try:
        headers = {"Authorization": f"Bearer {api_key or 'local'}"}
        async with httpx.AsyncClient(timeout=10.0, trust_env=False) as client:
            response = await client.get(f"{base_url.rstrip('/')}/models", headers=headers)
            response.raise_for_status()
            payload = response.json()
        rows = payload.get("data") or payload.get("models") or []
        advertised = [str(row.get("id") or row.get("model") or row.get("name")) for row in rows if isinstance(row, dict) and (row.get("id") or row.get("model") or row.get("name"))]
        return ProbeResult(target=target, configured=True, reachable=True, model_match=model in advertised, advertised_models=advertised[:20], detail="连接成功")
    except Exception as exc:
        return ProbeResult(target=target, configured=True, reachable=False, model_match=False, advertised_models=[], detail=f"连接失败：{type(exc).__name__}")


@router.get("")
async def get_model_settings(_: User = Depends(get_current_admin)) -> dict:
    return public_runtime_model_config()


@router.put("")
async def update_model_settings(body: ModelSettingsUpdate, admin: User = Depends(get_current_admin)) -> dict:
    return save_runtime_model_config(body.model_dump(), actor=admin.id)


@router.post("/probe", response_model=list[ProbeResult])
async def probe_model_settings(_: User = Depends(get_current_admin)) -> list[ProbeResult]:
    config: RuntimeModelConfig = get_runtime_model_config()
    return [
        await _probe("local", config.local_enabled, config.local_base_url, config.local_api_key, config.local_model_name),
        await _probe("cloud", config.cloud_enabled, config.cloud_base_url, config.cloud_api_key, config.cloud_model_name),
        await _probe("embedding", config.embedding_enabled, config.embedding_base_url, config.embedding_api_key, config.embedding_model_name),
    ]
