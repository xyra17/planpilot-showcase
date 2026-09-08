#!/usr/bin/env bash

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${ROOT_DIR}/scripts/release/lib.sh"

if [[ ! -f "${ROOT_DIR}/.env" || ! -f "${ROOT_DIR}/backend/.env" \
  || -z "$(pp_env_get "${ROOT_DIR}/.env" PLANPILOT_SECRET_KEY)" \
  || -z "$(pp_env_get "${ROOT_DIR}/.env" PLANPILOT_DB_PASSWORD)" \
  || -z "$(pp_env_get "${ROOT_DIR}/.env" PLANPILOT_MINIO_PASSWORD)" ]]; then
  pp_info "首次启动，进入配置向导。"
  "${ROOT_DIR}/scripts/release/configure.sh"
fi

"${ROOT_DIR}/scripts/release/preflight.sh"
pp_info "正在构建并启动服务，首次运行可能需要数分钟……"
docker compose -f "${ROOT_DIR}/docker-compose.yml" --env-file "${ROOT_DIR}/.env" up --build -d

ready=0
for _ in $(seq 1 60); do
  if pp_http_ok "http://127.0.0.1:8000/ready" 3 && pp_http_ok "http://127.0.0.1:3000" 3; then
    ready=1
    break
  fi
  sleep 2
done

if [[ "${ready}" != "1" ]]; then
  docker compose -f "${ROOT_DIR}/docker-compose.yml" --env-file "${ROOT_DIR}/.env" ps
  pp_fail "服务未在预期时间内就绪。请运行 docker compose logs 查看原因。"
fi

pp_ok "PlanPilot 已启动：http://localhost:3000"
if command -v open >/dev/null 2>&1; then
  open "http://localhost:3000"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:3000" >/dev/null 2>&1 || true
fi
