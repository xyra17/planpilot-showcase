#!/usr/bin/env bash

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

command -v docker >/dev/null 2>&1 || pp_fail "未找到 Docker。请先安装并启动 Docker Desktop。"
command -v curl >/dev/null 2>&1 || pp_fail "未找到 curl，无法执行服务健康检查。"
docker info >/dev/null 2>&1 || pp_fail "Docker 未运行，请先启动 Docker Desktop。"
docker compose version >/dev/null 2>&1 || pp_fail "需要 Docker Compose v2。"

available_kb="$(df -Pk "${PLANPILOT_ROOT}" | awk 'NR == 2 { print $4 }')"
if [[ "${available_kb:-0}" -lt 10485760 ]]; then
  pp_warn "可用磁盘不足 10 GB，首次构建或模型下载可能失败。"
fi

for target in "3000:frontend" "8000:api" "5432:postgres" "6379:redis" "9000:minio" "9001:minio"; do
  port="${target%%:*}"
  service="${target##*:}"
  if pp_port_in_use "${port}" && ! pp_compose_has_service "${service}"; then
    pp_fail "端口 ${port} 已被其他程序占用。请关闭占用程序后重试。"
  fi
done

[[ -f "${PLANPILOT_ROOT_ENV}" && -f "${PLANPILOT_BACKEND_ENV}" ]] || pp_fail "尚未初始化配置，请先运行配置向导。"
docker compose -f "${PLANPILOT_ROOT}/docker-compose.yml" --env-file "${PLANPILOT_ROOT_ENV}" config --quiet \
  || pp_fail "Docker Compose 配置校验失败。"

local_url="$(pp_env_get "${PLANPILOT_ROOT_ENV}" PLANPILOT_LOCAL_LLM_URL)"
embedding_url="$(pp_env_get "${PLANPILOT_ROOT_ENV}" PLANPILOT_EMBEDDING_URL)"
cloud_key="$(pp_env_get "${PLANPILOT_BACKEND_ENV}" SMART_API_KEY)"
cloud_url="$(pp_env_get "${PLANPILOT_BACKEND_ENV}" SMART_BASE_URL)"

if [[ -n "${local_url}" ]]; then
  if pp_http_ok "${local_url%/}/models" 4; then
    pp_ok "本地生成模型连接正常"
  else
    pp_warn "本地生成模型暂不可访问；PlanPilot 仍会启动基础功能：${local_url%/}/models"
  fi
elif [[ -n "${cloud_key}" && -n "${cloud_url}" ]]; then
  if ! printf 'url = "%s/models"\nheader = "Authorization: Bearer %s"\nsilent\nshow-error\nfail\nmax-time = 8\n' "${cloud_url%/}" "${cloud_key}" | curl --config - >/dev/null 2>&1; then
    pp_warn "云端 AI 的 /models 检查失败；PlanPilot 仍会启动基础功能。请确认 Base URL、API Key 和网络。"
  else
    pp_ok "云端 AI 连接正常（检查不会产生模型调用费用）"
  fi
else
  pp_warn "AI 未配置；基础功能可以正常启动。"
fi

if [[ -n "${embedding_url}" ]]; then
  if pp_http_ok "${embedding_url%/}/models" 4; then
    pp_ok "Embedding 服务连接正常"
  else
    pp_warn "Embedding 服务暂不可访问；知识库将使用关键词检索：${embedding_url%/}/models"
  fi
else
  pp_warn "Embedding 未配置；知识库将使用关键词检索。"
fi

pp_ok "启动前检查通过"
