$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

function Test-Http([string]$Url) {
  try {
    Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec 4 -UseBasicParsing | Out-Null
    return $true
  } catch { return $false }
}

function Get-EnvValue([string]$Path, [string]$Key) {
  if (-not (Test-Path $Path)) { return "" }
  $line = Get-Content $Path | Where-Object { $_ -match "^$([regex]::Escape($Key))=" } | Select-Object -First 1
  if (-not $line) { return "" }
  return $line.Substring($line.IndexOf("=") + 1)
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "未找到 Docker，请先安装 Docker Desktop。" }
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw "Docker 未运行，请先启动 Docker Desktop。" }
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { throw "需要 Docker Compose v2。" }

foreach ($port in @(3000, 8000, 5432, 6379, 9000, 9001)) {
  $listeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  if ($listeners) {
    $composeServices = docker compose -f (Join-Path $ProjectRoot "docker-compose.yml") ps --services --status running 2>$null
    $expectedService = switch ($port) { 3000 { "frontend" } 8000 { "api" } 5432 { "postgres" } 6379 { "redis" } default { "minio" } }
    if ($composeServices -notcontains $expectedService) { throw "端口 $port 已被其他程序占用。" }
  }
}

$rootEnv = Join-Path $ProjectRoot ".env"
$backendEnv = Join-Path $ProjectRoot "backend\.env"
if (-not (Test-Path $rootEnv) -or -not (Test-Path $backendEnv)) { throw "尚未初始化配置。" }
docker compose -f (Join-Path $ProjectRoot "docker-compose.yml") --env-file $rootEnv config --quiet
if ($LASTEXITCODE -ne 0) { throw "Docker Compose 配置校验失败。" }

$localUrl = Get-EnvValue $rootEnv "PLANPILOT_LOCAL_LLM_URL"
$embeddingUrl = Get-EnvValue $rootEnv "PLANPILOT_EMBEDDING_URL"
$cloudKey = Get-EnvValue $backendEnv "SMART_API_KEY"
$cloudUrl = Get-EnvValue $backendEnv "SMART_BASE_URL"
if ($localUrl) {
  if (Test-Http "$($localUrl.TrimEnd('/'))/models") {
    Write-Host "[PlanPilot] 本地生成模型连接正常" -ForegroundColor Green
  } else {
    Write-Host "[PlanPilot] 本地生成模型暂不可访问；仍会启动基础功能：$localUrl/models" -ForegroundColor Yellow
  }
} elseif ($cloudKey -and $cloudUrl) {
  try {
    Invoke-WebRequest -Uri "$($cloudUrl.TrimEnd('/'))/models" -Headers @{ Authorization = "Bearer $cloudKey" } -TimeoutSec 8 -UseBasicParsing | Out-Null
    Write-Host "[PlanPilot] 云端 AI 连接正常（检查不会产生模型调用费用）" -ForegroundColor Green
  } catch { Write-Host "[PlanPilot] 云端 AI 的 /models 检查失败；仍会启动基础功能。请检查配置。" -ForegroundColor Yellow }
} else {
  Write-Host "[PlanPilot] AI 未配置；基础功能可以正常启动。" -ForegroundColor Yellow
}
if ($embeddingUrl -and -not (Test-Http "$($embeddingUrl.TrimEnd('/'))/models")) { Write-Host "[PlanPilot] Embedding 服务暂不可访问；知识库将使用关键词检索。" -ForegroundColor Yellow }
if (-not $embeddingUrl) { Write-Host "[PlanPilot] Embedding 未配置；知识库将使用关键词检索。" -ForegroundColor Yellow }
Write-Host "[PlanPilot] 启动前检查通过" -ForegroundColor Green
