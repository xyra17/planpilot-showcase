#!/usr/bin/env bash

set -euo pipefail

PLANPILOT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLANPILOT_BACKEND_ENV="${PLANPILOT_ROOT}/backend/.env"
PLANPILOT_ROOT_ENV="${PLANPILOT_ROOT}/.env"

pp_info() { printf '\033[1;34m[PlanPilot]\033[0m %s\n' "$*"; }
pp_ok() { printf '\033[1;32m[PlanPilot]\033[0m %s\n' "$*"; }
pp_warn() { printf '\033[1;33m[PlanPilot]\033[0m %s\n' "$*"; }
pp_fail() { printf '\033[1;31m[PlanPilot]\033[0m %s\n' "$*" >&2; exit 1; }

pp_random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "${1:-32}"
  else
    od -An -N "${1:-32}" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

pp_env_get() {
  local file="$1" key="$2"
  [[ -f "${file}" ]] || return 0
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${file}"
}

pp_env_set() {
  local file="$1" key="$2" value="$3" temp
  temp="$(mktemp "${TMPDIR:-/tmp}/planpilot-env.XXXXXX")"
  if [[ -f "${file}" ]]; then
    awk -v key="${key}" -v value="${value}" '
      BEGIN { updated = 0 }
      $0 ~ "^" key "=" { print key "=" value; updated = 1; next }
      { print }
      END { if (!updated) print key "=" value }
    ' "${file}" >"${temp}"
  else
    printf '%s=%s\n' "${key}" "${value}" >"${temp}"
  fi
  mv "${temp}" "${file}"
}

pp_http_ok() {
  curl --silent --show-error --fail --max-time "${2:-3}" "$1" >/dev/null 2>&1
}

pp_port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "${port}" >/dev/null 2>&1
  else
    return 1
  fi
}

pp_compose_has_service() {
  docker compose -f "${PLANPILOT_ROOT}/docker-compose.yml" ps --services --status running 2>/dev/null | grep -qx "$1"
}
