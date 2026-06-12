param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$StackArgs
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$RuntimeImage = "node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920"
$Command = if ($StackArgs.Count -gt 0) { $StackArgs[0] } else { "help" }
$CommandArgs = if ($StackArgs.Count -gt 1) { $StackArgs[1..($StackArgs.Count - 1)] } else { @() }

function Assert-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker is required but was not found in PATH."
  }
  docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Docker is installed but the Docker engine is not available."
  }
  docker compose version *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose v2 is required."
  }
}

function Invoke-Runtime {
  param([string[]]$Arguments)
  & docker run --rm -i --mount "type=bind,source=$Root,target=/workspace" -w /workspace $RuntimeImage node installer/frame-installer.mjs @Arguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

function Invoke-RuntimeInput {
  param([string[]]$Arguments, [string]$InputText)
  $InputText | & docker run --rm -i --mount "type=bind,source=$Root,target=/workspace" -w /workspace $RuntimeImage node installer/frame-installer.mjs @Arguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

function Invoke-Verification {
  & docker run --rm -i --mount "type=bind,source=$Root,target=/workspace" -w /workspace $RuntimeImage node scripts/verify.mjs
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

function Read-PlainTextSecret {
  param([string]$Prompt)
  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Invoke-Compose {
  param([string[]]$Arguments)
  if (-not (Test-Path (Join-Path $Root "docker-compose.yml"))) {
    throw "The generated docker-compose.yml is missing. Run stack.cmd install first."
  }
  & docker compose --project-directory $Root --env-file (Join-Path $Root ".env") -f (Join-Path $Root "docker-compose.yml") @Arguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

Assert-Docker

switch ($Command) {
  "hybrid-stage" {
    $hostname = Read-Host "Cloudflare public hostname (for example frame.syroni.us)"
    if ([string]::IsNullOrWhiteSpace($hostname)) {
      throw "A Cloudflare public hostname is required."
    }
    Invoke-Runtime (@("install", "--mode", "HYBRID", "--public-hostname", $hostname) + $CommandArgs)
    Invoke-Compose @("config", "--quiet")
    Write-Host "Hybrid configuration staged. No tunnel was started."
  }
  "tunnel-token" {
    $token = Read-PlainTextSecret "Paste the Cloudflare tunnel token (input hidden)"
    Invoke-RuntimeInput @("set-tunnel-token") $token
  }
  "portal-auth" {
    $username = Read-Host "Portal username"
    $password = Read-PlainTextSecret "Portal password (input hidden)"
    Invoke-RuntimeInput @("set-portal-auth") "$username`n$password"
  }
  "install" {
    Invoke-Runtime (@("install") + $CommandArgs)
    Invoke-Compose @("config", "--quiet")
  }
  "validate" {
    Invoke-Runtime (@("validate") + $CommandArgs)
    Invoke-Compose @("config", "--quiet")
    Write-Host "Docker Compose configuration is valid."
  }
  "verify" {
    Invoke-Verification
    if (Test-Path (Join-Path $Root "docker-compose.yml")) {
      Invoke-Compose @("config", "--quiet")
    }
    Write-Host "FRAME contracts, scripts, and Docker Compose configuration are valid."
  }
  "start" {
    Invoke-Runtime @("validate", "--for-start")
    Invoke-Compose @("up", "-d", "--build", "--remove-orphans", "--wait", "--wait-timeout", "120")
  }
  "stop" {
    Invoke-Compose @("down")
  }
  "status" {
    Invoke-Runtime @("status")
    Invoke-Compose @("ps", "--all")
  }
  "logs" {
    Invoke-Compose (@("logs", "--tail", "150") + $CommandArgs)
  }
  "reset" {
    $confirmed = $CommandArgs -contains "--yes"
    if (-not $confirmed) {
      $answer = Read-Host "Reset removes FRAME's generated config and data. Type RESET to continue"
      $confirmed = $answer -ceq "RESET"
    }
    if (-not $confirmed) {
      Write-Host "Reset cancelled."
      exit 1
    }
    if (Test-Path (Join-Path $Root "docker-compose.yml")) {
      Invoke-Compose @("down", "--remove-orphans")
    }
    Invoke-Runtime @("reset", "--yes")
  }
  default {
    Invoke-Runtime (@($Command) + $CommandArgs)
  }
}
