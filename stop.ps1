$ErrorActionPreference = "Stop"
docker compose -f (Join-Path $PSScriptRoot "docker-compose.yml") --env-file (Join-Path $PSScriptRoot ".env") down
Write-Host "PlanPilot 已停止，数据仍保留在 Docker volumes 中。"
