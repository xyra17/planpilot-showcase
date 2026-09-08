#!/usr/bin/env bash

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [[ ! -f "${PLANPILOT_BACKEND_ENV}" ]]; then
  cp "${PLANPILOT_ROOT}/backend/.env.example" "${PLANPILOT_BACKEND_ENV}"
  pp_ok "已创建 backend/.env"
fi

secret="$(pp_env_get "${PLANPILOT_ROOT_ENV}" PLANPILOT_SECRET_KEY)"
db_password="$(pp_env_get "${PLANPILOT_ROOT_ENV}" PLANPILOT_DB_PASSWORD)"
minio_password="$(pp_env_get "${PLANPILOT_ROOT_ENV}" PLANPILOT_MINIO_PASSWORD)"
[[ -n "${secret}" ]] || secret="$(pp_random_hex 32)"
[[ -n "${db_password}" ]] || db_password="$(pp_random_hex 20)"
[[ -n "${minio_password}" ]] || minio_password="$(pp_random_hex 20)"

pp_env_set "${PLANPILOT_ROOT_ENV}" PLANPILOT_SECRET_KEY "${secret}"
pp_env_set "${PLANPILOT_ROOT_ENV}" PLANPILOT_DB_PASSWORD "${db_password}"
pp_env_set "${PLANPILOT_ROOT_ENV}" PLANPILOT_MINIO_PASSWORD "${minio_password}"
pp_env_set "${PLANPILOT_BACKEND_ENV}" SECRET_KEY "${secret}"

if [[ "${PLANPILOT_NON_INTERACTIVE:-0}" == "1" ]]; then
  mode="${PLANPILOT_AI_MODE:-none}"
else
  printf '\n选择 AI 模式：\n'
  printf '  1) 暂不配置（基础功能可正常使用）\n'
  printf '  2) 云端 OpenAI-compatible API（最省本机资源）\n'
  printf '  3) 已有本地模型服务（Ollama / LM Studio / llama.cpp / MLX）\n'
  read -r -p '请输入 1、2 或 3 [1]: ' choice
  case "${choice:-1}" in
    2) mode="cloud" ;;
    3) mode="local" ;;
    *) mode="none" ;;
  esac
fi

case "${mode}" in
  cloud)
    if [[ "${PLANPILOT_NON_INTERACTIVE:-0}" == "1" ]]; then
      cloud_key="${PLANPILOT_CLOUD_API_KEY:-}"
      cloud_url="${PLANPILOT_CLOUD_BASE_URL:-https://api.deepseek.com/v1}"
      routine_model="${PLANPILOT_CLOUD_MODEL:-deepseek-chat}"
      pro_model="${PLANPILOT_CLOUD_PRO_MODEL:-${routine_model}}"
    else
      read -r -p 'API Base URL [https://api.deepseek.com/v1]: ' cloud_url
      cloud_url="${cloud_url:-https://api.deepseek.com/v1}"
      read -r -p '日常模型名 [deepseek-chat]: ' routine_model
      routine_model="${routine_model:-deepseek-chat}"
      read -r -p "高质量模型名 [${routine_model}]: " pro_model
      pro_model="${pro_model:-${routine_model}}"
      read -r -s -p 'API Key（输入内容不会显示）: ' cloud_key
      printf '\n'
    fi
    [[ -n "${cloud_key}" ]] || pp_fail "云端模式必须填写 API Key"
    pp_env_set "${PLANPILOT_BACKEND_ENV}" LOCAL_MODEL_ENABLED "false"
    pp_env_set "${PLANPILOT_ROOT_ENV}" PLANPILOT_LOCAL_LLM_URL ""
    pp_env_set "${PLANPILOT_BACKEND_ENV}" SMART_API_KEY "${cloud_key}"
    pp_env_set "${PLANPILOT_BACKEND_ENV}" SMART_BASE_URL "${cloud_url%/}"
    pp_env_set "${PLANPILOT_BACKEND_ENV}" SMART_MODEL_NAME "${routine_model}"
    pp_env_set "${PLANPILOT_BACKEND_ENV}" SMART_PRO_MODEL_NAME "${pro_model}"
    pp_ok "已配置云端 AI；Key 仅保存在本机 backend/.env"
    ;;
  local)
    if [[ "${PLANPILOT_NON_INTERACTIVE:-0}" == "1" ]]; then
      local_url="${PLANPILOT_LOCAL_URL:-}"
      local_model="${PLANPILOT_LOCAL_MODEL:-}"
      embedding_url="${PLANPILOT_EMBEDDING_URL_INPUT:-}"
      embedding_model="${PLANPILOT_EMBEDDING_MODEL:-qwen3-embedding-0.6b}"
    else
      read -r -p '生成模型 API 地址（例：http://host.docker.internal:8080/v1）: ' local_url
      read -r -p '生成模型名: ' local_model
      read -r -p 'Embedding API 地址（可留空）: ' embedding_url
      read -r -p 'Embedding 模型名 [qwen3-embedding-0.6b]: ' embedding_model
      embedding_model="${embedding_model:-qwen3-embedding-0.6b}"
    fi
    [[ -n "${local_url}" && -n "${local_model}" ]] || pp_fail "本地模式必须填写生成模型地址和模型名"
    pp_env_set "${PLANPILOT_BACKEND_ENV}" SMART_API_KEY ""
    pp_env_set "${PLANPILOT_ROOT_ENV}" PLANPILOT_LOCAL_LLM_URL "${local_url%/}"
    pp_env_set "${PLANPILOT_BACKEND_ENV}" OPENAI_API_KEY "local"
    pp_env_set "${PLANPILOT_BACKEND_ENV}" MODEL_NAME "${local_model}"
    pp_env_set "${PLANPILOT_BACKEND_ENV}" LOCAL_MODEL_ENABLED "true"
    if [[ -n "${embedding_url}" ]]; then
      pp_env_set "${PLANPILOT_ROOT_ENV}" PLANPILOT_EMBEDDING_URL "${embedding_url%/}"
      pp_env_set "${PLANPILOT_BACKEND_ENV}" EMBEDDING_API_KEY "local"
      pp_env_set "${PLANPILOT_BACKEND_ENV}" EMBEDDING_MODEL_NAME "${embedding_model}"
      pp_env_set "${PLANPILOT_BACKEND_ENV}" EMBEDDING_DIMENSIONS "1024"
    fi
    pp_ok "已保存本地模型服务配置"
    ;;
  none)
    pp_env_set "${PLANPILOT_BACKEND_ENV}" SMART_API_KEY ""
    pp_env_set "${PLANPILOT_BACKEND_ENV}" LOCAL_MODEL_ENABLED "false"
    pp_env_set "${PLANPILOT_BACKEND_ENV}" EMBEDDING_API_KEY ""
    pp_env_set "${PLANPILOT_ROOT_ENV}" PLANPILOT_LOCAL_LLM_URL ""
    pp_env_set "${PLANPILOT_ROOT_ENV}" PLANPILOT_EMBEDDING_URL ""
    pp_warn "暂未配置 AI。目标、任务、打卡和笔记仍可使用；AI 建议与语义检索暂不可用。"
    ;;
  *) pp_fail "未知的 PLANPILOT_AI_MODE：${mode}" ;;
esac

chmod 600 "${PLANPILOT_ROOT_ENV}" "${PLANPILOT_BACKEND_ENV}" 2>/dev/null || true
pp_ok "配置完成"
