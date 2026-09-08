$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$RootEnv = Join-Path $ProjectRoot ".env"
$BackendEnv = Join-Path $ProjectRoot "backend\.env"
$BackendExample = Join-Path $ProjectRoot "backend\.env.example"

function New-RandomHex([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToHexString($buffer).ToLowerInvariant()
}

function Get-EnvValue([string]$Path, [string]$Key) {
  if (-not (Test-Path $Path)) { return "" }
  $line = Get-Content $Path | Where-Object { $_ -match "^$([regex]::Escape($Key))=" } | Select-Object -First 1
  if (-not $line) { return "" }
  return $line.Substring($line.IndexOf("=") + 1)
}

function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
  $lines = if (Test-Path $Path) { @(Get-Content $Path) } else { @() }
  $updated = $false
  $result = foreach ($line in $lines) {
    if ($line -match "^$([regex]::Escape($Key))=") {
      "$Key=$Value"
      $updated = $true
    } else { $line }
  }
  if (-not $updated) { $result += "$Key=$Value" }
  [System.IO.File]::WriteAllLines($Path, $result, (New-Object System.Text.UTF8Encoding($false)))
}

if (-not (Test-Path $BackendEnv)) {
  Copy-Item $BackendExample $BackendEnv
  Write-Host "[PlanPilot] 已创建 backend/.env" -ForegroundColor Green
}

$secret = Get-EnvValue $RootEnv "PLANPILOT_SECRET_KEY"
$dbPassword = Get-EnvValue $RootEnv "PLANPILOT_DB_PASSWORD"
$minioPassword = Get-EnvValue $RootEnv "PLANPILOT_MINIO_PASSWORD"
if (-not $secret) { $secret = New-RandomHex 32 }
if (-not $dbPassword) { $dbPassword = New-RandomHex 20 }
if (-not $minioPassword) { $minioPassword = New-RandomHex 20 }

Set-EnvValue $RootEnv "PLANPILOT_SECRET_KEY" $secret
Set-EnvValue $RootEnv "PLANPILOT_DB_PASSWORD" $dbPassword
Set-EnvValue $RootEnv "PLANPILOT_MINIO_PASSWORD" $minioPassword
Set-EnvValue $BackendEnv "SECRET_KEY" $secret

Write-Host "`n选择 AI 模式："
Write-Host "  1) 暂不配置（基础功能可正常使用）"
Write-Host "  2) 云端 OpenAI-compatible API"
Write-Host "  3) 已有本地模型服务"
$choice = Read-Host "请输入 1、2 或 3 [1]"

if ($choice -eq "2") {
  $cloudUrl = Read-Host "API Base URL [https://api.deepseek.com/v1]"
  if (-not $cloudUrl) { $cloudUrl = "https://api.deepseek.com/v1" }
  $routineModel = Read-Host "日常模型名 [deepseek-chat]"
  if (-not $routineModel) { $routineModel = "deepseek-chat" }
  $proModel = Read-Host "高质量模型名 [$routineModel]"
  if (-not $proModel) { $proModel = $routineModel }
  $secureKey = Read-Host "API Key（输入内容不会显示）" -AsSecureString
  $cloudKey = [System.Net.NetworkCredential]::new("", $secureKey).Password
  if (-not $cloudKey) { throw "云端模式必须填写 API Key" }
  Set-EnvValue $BackendEnv "LOCAL_MODEL_ENABLED" "false"
  Set-EnvValue $RootEnv "PLANPILOT_LOCAL_LLM_URL" ""
  Set-EnvValue $BackendEnv "SMART_API_KEY" $cloudKey
  Set-EnvValue $BackendEnv "SMART_BASE_URL" $cloudUrl.TrimEnd("/")
  Set-EnvValue $BackendEnv "SMART_MODEL_NAME" $routineModel
  Set-EnvValue $BackendEnv "SMART_PRO_MODEL_NAME" $proModel
  Write-Host "[PlanPilot] 已配置云端 AI；Key 仅保存在本机 backend/.env" -ForegroundColor Green
} elseif ($choice -eq "3") {
  $localUrl = Read-Host "生成模型 API 地址（例：http://host.docker.internal:8080/v1）"
  $localModel = Read-Host "生成模型名"
  $embeddingUrl = Read-Host "Embedding API 地址（可留空）"
  $embeddingModel = Read-Host "Embedding 模型名 [qwen3-embedding-0.6b]"
  if (-not $embeddingModel) { $embeddingModel = "qwen3-embedding-0.6b" }
  if (-not $localUrl -or -not $localModel) { throw "本地模式必须填写生成模型地址和模型名" }
  Set-EnvValue $BackendEnv "SMART_API_KEY" ""
  Set-EnvValue $RootEnv "PLANPILOT_LOCAL_LLM_URL" $localUrl.TrimEnd("/")
  Set-EnvValue $BackendEnv "OPENAI_API_KEY" "local"
  Set-EnvValue $BackendEnv "MODEL_NAME" $localModel
  Set-EnvValue $BackendEnv "LOCAL_MODEL_ENABLED" "true"
  if ($embeddingUrl) {
    Set-EnvValue $RootEnv "PLANPILOT_EMBEDDING_URL" $embeddingUrl.TrimEnd("/")
    Set-EnvValue $BackendEnv "EMBEDDING_API_KEY" "local"
    Set-EnvValue $BackendEnv "EMBEDDING_MODEL_NAME" $embeddingModel
    Set-EnvValue $BackendEnv "EMBEDDING_DIMENSIONS" "1024"
  }
  Write-Host "[PlanPilot] 已保存本地模型服务配置" -ForegroundColor Green
} else {
  Set-EnvValue $BackendEnv "SMART_API_KEY" ""
  Set-EnvValue $BackendEnv "LOCAL_MODEL_ENABLED" "false"
  Set-EnvValue $BackendEnv "EMBEDDING_API_KEY" ""
  Set-EnvValue $RootEnv "PLANPILOT_LOCAL_LLM_URL" ""
  Set-EnvValue $RootEnv "PLANPILOT_EMBEDDING_URL" ""
  Write-Host "[PlanPilot] AI 暂未配置。目标、任务、打卡和笔记仍可使用。" -ForegroundColor Yellow
}

Write-Host "[PlanPilot] 配置完成" -ForegroundColor Green
