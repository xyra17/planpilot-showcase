#!/usr/bin/env bash

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker compose -f "${ROOT_DIR}/docker-compose.yml" --env-file "${ROOT_DIR}/.env" down
printf 'PlanPilot 已停止，数据仍保留在 Docker volumes 中。\n'
