#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_root="${BACKUP_DIR:-${project_root}/backups}"
case "${backup_root}" in
  /|"${HOME}"|"${project_root}")
    echo "Refusing unsafe BACKUP_DIR: ${backup_root}" >&2
    exit 2
    ;;
esac

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_set="${backup_root}/${stamp}"
mkdir -p "${backup_set}/objects"

cd "${project_root}"
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U planpilot -d planpilot --format=custom --no-owner --no-acl \
  > "${backup_set}/database.dump"

BACKUP_DIR="${backup_root}" docker compose -f docker-compose.prod.yml --profile ops run --rm \
  object-backup -c "mc alias set source http://minio:9000 planpilot \"\${OBJECT_STORAGE_PASSWORD}\" && mc mirror --overwrite source/planpilot /backup/${stamp}/objects"

(
  cd "${backup_set}"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS
)
printf '%s\n' "${backup_set}"
