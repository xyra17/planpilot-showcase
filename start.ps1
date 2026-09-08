$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot

$rootEnv = Join-Path $ProjectRoot ".env"
$backendEnv = Join-Path $ProjectRoot "backend\.env"
$hasReleaseSecrets = (Test-Path $rootEnv) -and (Select-String -Path $rootEnv -Pattern "^PLANPILOT_SECRET_KEY=.+" -Quiet) -and (Select-String -Path $rootEnv -Pattern "^PLANPILOT_DB_PASSWORD=.+" -Quiet) -and (Select-String -Path $rootEnv -Pattern "^PLANPILOT_MINIO_PASSWORD=.+" -Quiet)
if (-not $hasReleaseSecrets -or -not (Test-Path $backendEnv)) {
  Write-Host "[PlanPilot] 首次启动，进入配置向导。" -ForegroundColor Cyan
  & (Join-Path $ProjectRoot "scripts\release\configure.ps1")
}

& (Join-Path $ProjectRoot "scripts\release\preflight.ps1")
Write-Host "[PlanPilot] 正在构建并启动服务，首次运行可能需要数分钟……" -ForegroundColor Cyan
docker compose -f (Join-Path $ProjectRoot "docker-compose.yml") --env-file (Join-Path $ProjectRoot ".env") up --build -d
if ($LASTEXITCODE -ne 0) { throw "Docker Compose 启动失败。" }

$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:8000/ready" -TimeoutSec 3 -UseBasicParsing | Out-Null
    Invoke-WebRequest -Uri "http://127.0.0.1:3000" -TimeoutSec 3 -UseBasicParsing | Out-Null
    $ready = $true
    break
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $ready) {
  docker compose -f (Join-Path $ProjectRoot "docker-compose.yml") ps
  throw "服务未在预期时间内就绪，请运行 docker compose logs 查看原因。"
}
Write-Host "[PlanPilot] 已启动：http://localhost:3000" -ForegroundColor Green
Start-Process "http://localhost:3000"
