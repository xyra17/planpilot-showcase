#!/usr/bin/env python3
"""安全地切换 PlanPilot 的生成模型与 Embedding 配置。

交互使用：
    python scripts/configure_models.py

非交互示例（Key 从环境变量读取，避免进入 shell 历史）：
    PLANPILOT_CLOUD_API_KEY=... python scripts/configure_models.py \
      --provider compatible \
      --base-url https://example.com/v1 \
      --routine-model model-fast \
      --pro-model model-pro \
      --yes
"""

from __future__ import annotations

import argparse
import getpass
import os
import shutil
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

BACKEND_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = BACKEND_DIR / ".env"

MANAGED_KEYS = (
    "LOCAL_MODEL_ENABLED",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "MODEL_NAME",
    "SMART_API_KEY",
    "SMART_BASE_URL",
    "SMART_MODEL_NAME",
    "SMART_PRO_MODEL_NAME",
    "EMBEDDING_API_KEY",
    "EMBEDDING_BASE_URL",
    "EMBEDDING_MODEL_NAME",
    "EMBEDDING_DIMENSIONS",
)


def read_env(path: Path) -> tuple[list[str], dict[str, str]]:
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return lines, values


def update_env(lines: list[str], updates: dict[str, str]) -> list[str]:
    result: list[str] = []
    written: set[str] = set()
    for line in lines:
        if "=" in line and not line.lstrip().startswith("#"):
            key = line.split("=", 1)[0].strip()
            if key in updates:
                result.append(f"{key}={updates[key]}")
                written.add(key)
                continue
        result.append(line)

    missing = [key for key in MANAGED_KEYS if key in updates and key not in written]
    if missing:
        if result and result[-1] != "":
            result.append("")
        result.append("# PlanPilot model configuration")
        result.extend(f"{key}={updates[key]}" for key in missing)
    return result


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{prompt}{suffix}: ").strip()
    return value or default


def ask_bool(prompt: str, default: bool) -> bool:
    marker = "Y/n" if default else "y/N"
    value = input(f"{prompt} [{marker}]: ").strip().lower()
    if not value:
        return default
    return value in {"y", "yes", "1", "true"}


def ask_secret(prompt: str, current: str = "") -> str:
    marker = "（回车保留现有值）" if current else ""
    value = getpass.getpass(f"{prompt}{marker}: ").strip()
    return value or current


def valid_base_url(value: str) -> bool:
    if not value:
        return True
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def redact(value: str) -> str:
    if not value:
        return "<未配置>"
    if len(value) <= 8:
        return "<已配置>"
    return f"{value[:3]}…{value[-3:]}"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="配置 PlanPilot 模型供应商")
    parser.add_argument(
        "--provider",
        choices=("deepseek", "compatible", "local-only"),
        help="云端供应商预设；compatible 表示任意 OpenAI-compatible 服务",
    )
    parser.add_argument("--base-url")
    parser.add_argument("--routine-model")
    parser.add_argument("--pro-model")
    parser.add_argument("--local-enabled", choices=("true", "false"))
    parser.add_argument("--local-base-url")
    parser.add_argument("--local-model")
    parser.add_argument("--embedding-base-url")
    parser.add_argument("--embedding-model")
    parser.add_argument("--yes", action="store_true", help="非交互确认写入")
    parser.add_argument("--show", action="store_true", help="只显示当前配置（密钥脱敏）")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    lines, current = read_env(ENV_PATH)

    if args.show:
        for key in MANAGED_KEYS:
            value = current.get(key, "")
            print(f"{key}={redact(value) if 'KEY' in key else value or '<未配置>'}")
        return 0

    provider = args.provider
    if provider is None:
        print("选择云端模型供应商：")
        print("  1. DeepSeek（预设）")
        print("  2. 其他 OpenAI-compatible 服务")
        print("  3. 纯本地，不配置云端回退")
        choice = ask("请输入序号", "1")
        provider = {"1": "deepseek", "2": "compatible", "3": "local-only"}.get(
            choice, "deepseek"
        )

    updates: dict[str, str] = {}
    local_default = current.get("LOCAL_MODEL_ENABLED", "true").lower() == "true"
    if args.local_enabled is not None:
        local_enabled = args.local_enabled == "true"
    elif args.yes:
        local_enabled = local_default
    else:
        local_enabled = ask_bool("启用本地生成模型作为首选", local_default)
    updates["LOCAL_MODEL_ENABLED"] = str(local_enabled).lower()

    if local_enabled:
        updates["OPENAI_BASE_URL"] = args.local_base_url or (
            current.get("OPENAI_BASE_URL", "http://localhost:8080/v1")
            if args.yes
            else ask("本地生成模型地址", current.get("OPENAI_BASE_URL", "http://localhost:8080/v1"))
        )
        updates["MODEL_NAME"] = args.local_model or (
            current.get("MODEL_NAME", "")
            if args.yes
            else ask("本地生成模型 ID", current.get("MODEL_NAME", ""))
        )
        updates["OPENAI_API_KEY"] = current.get("OPENAI_API_KEY", "local")
    else:
        updates["OPENAI_BASE_URL"] = ""
        updates["MODEL_NAME"] = current.get("MODEL_NAME", "")

    if provider == "local-only":
        updates.update(
            SMART_API_KEY="",
            SMART_BASE_URL="",
            SMART_MODEL_NAME="",
            SMART_PRO_MODEL_NAME="",
        )
    else:
        defaults = (
            {
                "base_url": "https://api.deepseek.com/v1",
                "routine": "deepseek-v4-flash",
                "pro": "deepseek-v4-pro",
            }
            if provider == "deepseek"
            else {
                "base_url": current.get("SMART_BASE_URL", ""),
                "routine": current.get("SMART_MODEL_NAME", ""),
                "pro": current.get("SMART_PRO_MODEL_NAME", ""),
            }
        )
        updates["SMART_BASE_URL"] = args.base_url or (
            defaults["base_url"] if args.yes else ask("云端 OpenAI-compatible 地址", defaults["base_url"])
        )
        updates["SMART_MODEL_NAME"] = args.routine_model or (
            defaults["routine"] if args.yes else ask("日常／快速模型 ID", defaults["routine"])
        )
        updates["SMART_PRO_MODEL_NAME"] = args.pro_model or (
            defaults["pro"] if args.yes else ask("复杂任务／审核模型 ID", defaults["pro"])
        )
        env_key = os.getenv("PLANPILOT_CLOUD_API_KEY", "")
        updates["SMART_API_KEY"] = env_key or (
            current.get("SMART_API_KEY", "")
            if args.yes
            else ask_secret("云端 API Key", current.get("SMART_API_KEY", ""))
        )

    updates["EMBEDDING_BASE_URL"] = args.embedding_base_url or (
        current.get("EMBEDDING_BASE_URL", "http://localhost:1234/v1")
        if args.yes
        else ask("独立 Embedding 地址", current.get("EMBEDDING_BASE_URL", "http://localhost:1234/v1"))
    )
    updates["EMBEDDING_MODEL_NAME"] = args.embedding_model or (
        current.get("EMBEDDING_MODEL_NAME", "qwen3-embedding-0.6b")
        if args.yes
        else ask("Embedding 模型 ID", current.get("EMBEDDING_MODEL_NAME", "qwen3-embedding-0.6b"))
    )
    updates["EMBEDDING_API_KEY"] = current.get("EMBEDDING_API_KEY", "local")
    updates["EMBEDDING_DIMENSIONS"] = "1024"

    for key in ("OPENAI_BASE_URL", "SMART_BASE_URL", "EMBEDDING_BASE_URL"):
        if not valid_base_url(updates.get(key, "")):
            raise SystemExit(f"{key} 不是有效的 http/https 地址")
    if not local_enabled and provider == "local-only":
        raise SystemExit("不能同时关闭本地模型并选择纯本地模式")
    if provider != "local-only" and not updates["SMART_API_KEY"]:
        raise SystemExit("云端模式必须配置 API Key")

    print("\n即将应用：")
    print(f"  本地生成：{'启用' if local_enabled else '关闭'}")
    if local_enabled:
        print(f"  本地模型：{updates['MODEL_NAME']} @ {updates['OPENAI_BASE_URL']}")
    print(f"  云端模式：{provider}")
    if provider != "local-only":
        print(f"  日常模型：{updates['SMART_MODEL_NAME']}")
        print(f"  高质量模型：{updates['SMART_PRO_MODEL_NAME']}")
        print(f"  云端 Key：{redact(updates['SMART_API_KEY'])}")
    print(f"  Embedding：{updates['EMBEDDING_MODEL_NAME']} @ {updates['EMBEDDING_BASE_URL']}")

    if not args.yes and not ask_bool("确认写入 backend/.env", True):
        print("已取消，未修改配置。")
        return 1

    if ENV_PATH.exists():
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = ENV_PATH.with_name(f".env.model-config-{timestamp}.bak")
        shutil.copy2(ENV_PATH, backup)
        print(f"已备份：{backup}")

    ENV_PATH.write_text("\n".join(update_env(lines, updates)) + "\n", encoding="utf-8")
    print("配置已写入 backend/.env。请重启 api、worker 和 beat 使其生效。")
    print("Docker：docker compose restart api worker beat")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
