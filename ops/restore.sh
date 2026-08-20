#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || "$2" != "--confirm" ]]; then
  echo "Usage: $0 /absolute/path/to/backup-set --confirm" >&2
  exit 2
fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_set="$(cd "$1" && pwd)"
backup_root="$(dirname "${backup_set}")"
[[ -f "${backup_set}/database.dump" && -f "${backup_set}/SHA256SUMS" ]] || {
  echo "Backup set is incomplete" >&2
  exit 2
}

(cd "${backup_set}" && shasum -a 256 -c SHA256SUMS)
cd "${project_root}"

docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U planpilot -d planpilot --clean --if-exists --no-owner --no-acl \
  < "${backup_set}/database.dump"

BACKUP_DIR="${backup_root}" docker compose -f docker-compose.prod.yml --profile ops run --rm \
  object-backup -c "mc alias set target http://minio:9000 planpilot \"\${OBJECT_STORAGE_PASSWORD}\" && mc mirror --overwrite --remove /backup/$(basename "${backup_set}")/objects target/planpilot"

docker compose -f docker-compose.prod.yml run --rm migrate
if [[ "${RESTORE_SKIP_RESTART:-0}" != "1" ]]; then
  docker compose -f docker-compose.prod.yml restart api worker beat
fi
