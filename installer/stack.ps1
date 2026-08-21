param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$StackArgs
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$RuntimeImage = "node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920"
$Command = "menu"
if ($StackArgs.Count -gt 0) {
  $Command = $StackArgs[0]
} elseif ([Console]::IsInputRedirected) {
  $Command = "help"
}
$CommandArgs = @()
if ($StackArgs.Count -gt 1) {
  $CommandArgs = $StackArgs[1..($StackArgs.Count - 1)]
}

$Capabilities = @(
  [pscustomobject]@{ Key = "frame-video-relay"; Name = "Video Relay and Stream Management"; Description = "Receive SRTLA/SRT feeds and manage stream profiles." },
  [pscustomobject]@{ Key = "frame-overlays"; Name = "Overlay Wizard"; Description = "Create OBS relay-stat overlays. Automatically enables Video Relay." },
  [pscustomobject]@{ Key = "frame-audio-relay"; Name = "Audio Monitor"; Description = "Capture and distribute monitored audio feeds." },
  [pscustomobject]@{ Key = "frame-discord-audio-bridge"; Name = "Discord Audio Bridge"; Description = "Bridge Discord voice audio and speaking overlays into OBS." },
  [pscustomobject]@{ Key = "frame-belabox-manager"; Name = "Belabox Manager"; Description = "Monitor Belabox agents over one authenticated outbound WSS connection, with SSH reserved for maintenance." },
  [pscustomobject]@{ Key = "frame-photo-ftp"; Name = "Photo FTP Ingest"; Description = "Accept completed camera uploads through FTP." },
  [pscustomobject]@{ Key = "frame-photo-webupload"; Name = "Browser Photo Upload"; Description = "Upload photos from a protected browser page." },
  [pscustomobject]@{ Key = "frame-photo-gallery"; Name = "Photo Gallery"; Description = "Publish multi-day photo galleries. Requires a photo input." },
  [pscustomobject]@{ Key = "frame-photo-todaytools"; Name = "Photo Stage"; Description = "Provide Photo Stage dashboard, OBS viewer, and remote. Requires Gallery and a photo input." }
)

$AdvancedSettings = @(
  "TIMEZONE", "FRAME_AUTH_SESSION_DAYS", "PORTAL_PORT", "AUDIO_BRIDGE_PORT", "AUDIO_MONITOR_PORT",
  "STREAMS_PORT", "OVERLAYS_PORT", "PHOTO_UPLOAD_PORT", "PHOTO_FTP_PORT", "GALLERY_PORT", "TODAY_PORT",
  "PHOTO_FTP_PASSIVE_MIN", "PHOTO_FTP_PASSIVE_MAX", "PHOTO_FTP_PASSIVE_HOST", "PHOTO_FTP_USERNAME",
  "PHOTO_FTP_MIN_PASSWORD_LENGTH", "PHOTO_FTP_MAX_SESSIONS", "PHOTO_FTP_MAX_SESSIONS_PER_IP",
  "PHOTO_FTP_VERBOSE_LOG", "PHOTO_FTP_STABLE_MS", "PHOTO_FTP_SCAN_MS", "PHOTO_UPLOAD_MAX_FILES", "PHOTO_UPLOAD_MAX_SESSIONS",
  "BELABOX_HOST", "BELABOX_USER", "BELABOX_PORT", "BELABOX_SSH_KEY_PATH", "BELABOX_AGENT_REMOTE_PATH",
  "BELABOX_SSH_ENABLED", "BELABOX_AGENT_COMMANDS_ENABLED", "BELABOX_AGENT_INSTALL_ENABLED",
  "BELABOX_CONTROL_RECONNECT_MS", "BELABOX_CONTROL_HEARTBEAT_MS",
  "BELABOX_TELEMETRY_INTERVAL_MS",
  "BELABOX_FTP_TARGET_HOST", "BELABOX_FTP_TARGET_PORT", "BELABOX_FTP_TARGET_USERNAME", "BELABOX_FTP_TARGET_DIR",
  "BELABOX_CAMERA_FTP_USERNAME", "BELABOX_CAMERA_FTP_PORT",
  "BELABOX_CHUNK_UPLOAD_URL", "BELABOX_CHUNK_SIZE_BYTES", "BELABOX_CHUNK_PARALLEL_UPLOADS", "BELABOX_CHUNK_UPLOAD_KBPS",
  "BELABOX_DIAGNOSTIC_UPLOAD_BYTES", "BELABOX_DIAGNOSTIC_MAX_UPLOAD_BYTES", "BELABOX_DIAGNOSTIC_PARALLEL_STREAMS",
  "BELABOX_MANAGER_API_URL",
  "PIPELINE_POLL_MS", "PIPELINE_CONCURRENCY",
  "PHOTO_MAX_INPUT_MB", "PHOTO_MAX_MEGAPIXELS", "PHOTO_CONVERSION_ATTEMPTS", "PHOTO_ARCHIVE_ORIGINALS",
  "GALLERY_THUMB_WIDTH", "GALLERY_THUMB_QUALITY", "TODAY_DEFAULT_INTERVAL_MS", "TODAY_REFRESH_MS",
  "ENABLE_CONTAINER_RESTARTS", "STATUS_REFRESH_MS", "STATUS_CACHE_MS", "REQUEST_TIMEOUT_MS",
  "DISK_WARN_PERCENT", "DISK_ERROR_PERCENT", "DISK_MINIMUM_FREE_GB", "DEFAULT_AUDIO_DELAY_MS",
  "MAX_AUDIO_DELAY_MS", "SESSION_IDLE_TIMEOUT_MINUTES", "PUBLIC_RELAY_HOST", "SRTLA_PORT",
  "SRT_PLAYER_PORT", "SRT_SENDER_PORT", "SLS_STATS_PORT"
)

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
  $dockerArguments = Get-RuntimeDockerArguments $Arguments
  & docker @dockerArguments
  if ($LASTEXITCODE -ne 0) {
    throw "FRAME installer command failed."
  }
}

function Invoke-RuntimeInput {
  param([string[]]$Arguments, [string]$InputText)
  $dockerArguments = Get-RuntimeDockerArguments $Arguments
  $InputText | & docker @dockerArguments
  if ($LASTEXITCODE -ne 0) {
    throw "FRAME installer credential command failed."
  }
}

function Invoke-Verification {
  & docker run --rm -i --mount "type=bind,source=$Root,target=/workspace" -w /workspace $RuntimeImage node scripts/verify.mjs
  if ($LASTEXITCODE -ne 0) {
    throw "FRAME verification failed."
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
    throw "Docker Compose command failed."
  }
}

function Get-EnvMap {
  $values = @{}
  $file = Join-Path $Root ".env"
  if (-not (Test-Path $file)) { return $values }
  foreach ($line in Get-Content $file) {
    if ($line -notmatch "^([^#=]+)=(.*)$") { continue }
    $key = $Matches[1].Trim()
    $value = $Matches[2].Trim()
    if ($value.StartsWith('"') -and $value.EndsWith('"')) {
      try { $value = $value | ConvertFrom-Json } catch {}
    }
    $values[$key] = $value
  }
  return $values
}

function Get-ArgumentValue {
  param([string[]]$Arguments, [string]$Name)
  for ($index = 0; $index -lt $Arguments.Count - 1; $index++) {
    if ($Arguments[$index] -eq $Name) {
      return $Arguments[$index + 1]
    }
  }
  return $null
}

function Resolve-FrameDataPath {
  param([string]$DataRoot)
  if ([System.IO.Path]::IsPathRooted($DataRoot)) {
    return [System.IO.Path]::GetFullPath($DataRoot)
  }
  $relativeDataRoot = ($DataRoot -replace "^\./", "") -replace "/", "\"
  return Join-Path $Root $relativeDataRoot
}

function Get-RuntimeDockerArguments {
  param([string[]]$Arguments)
  $dockerArguments = @("run", "--rm", "-i", "--mount", "type=bind,source=$Root,target=/workspace")
  $dataRoot = Get-ArgumentValue $Arguments "--data-root"
  if (-not $dataRoot) {
    $env = Get-EnvMap
    if ($env.FRAME_DATA_ROOT) { $dataRoot = $env.FRAME_DATA_ROOT }
  }
  if ($dataRoot -and [System.IO.Path]::IsPathRooted($dataRoot)) {
    $dataPath = Resolve-FrameDataPath $dataRoot
    New-Item -ItemType Directory -Force -Path $dataPath | Out-Null
    $dockerArguments += @("--mount", "type=bind,source=$dataPath,target=/frame-data", "--env", "FRAME_INSTALLER_DATA_ROOT=/frame-data")
  }
  return $dockerArguments + @("-w", "/workspace", $RuntimeImage, "node", "installer/frame-installer.mjs") + $Arguments
}

function Get-StackConfig {
  $env = Get-EnvMap
  $dataRoot = "./data"
  if ($env.FRAME_DATA_ROOT) { $dataRoot = $env.FRAME_DATA_ROOT }
  $path = Resolve-FrameDataPath $dataRoot
  $configPath = Join-Path $path "state\stack-config.json"
  if (-not (Test-Path $configPath)) { return $null }
  return Get-Content $configPath -Raw | ConvertFrom-Json
}

function Test-CapabilityEnabled {
  param($Config, [string]$Key)
  if (-not $Config) { return $false }
  $property = $Config.capabilities.PSObject.Properties[$Key]
  return [bool]($property -and $property.Value)
}

function Read-Default {
  param([string]$Prompt, [string]$Default)
  $suffix = ""
  if ($Default) { $suffix = " [$Default]" }
  $value = Read-Host "$Prompt$suffix"
  if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
  return $value.Trim()
}

function Get-HostLanIPv4Candidates {
  $candidates = @()
  try {
    $ipConfig = Get-NetIPConfiguration -ErrorAction Stop |
      Where-Object {
        $_.IPv4Address -and
        $_.NetAdapter.Status -eq "Up" -and
        $_.NetAdapter.HardwareInterface
      }
    foreach ($config in $ipConfig) {
      foreach ($address in $config.IPv4Address) {
        $value = [string]$address.IPAddress
        if (Test-LanIPv4Candidate $value) {
          $candidates += $value
        }
      }
    }
  } catch {
    try {
      $candidates += [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
        Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } |
        ForEach-Object { $_.IPAddressToString } |
        Where-Object { Test-LanIPv4Candidate $_ }
    } catch {}
  }
  return @($candidates | Select-Object -Unique)
}

function Test-LanIPv4Candidate {
  param([string]$Address)
  if (-not $Address) { return $false }
  if ($Address -eq "127.0.0.1" -or $Address.StartsWith("169.254.")) { return $false }
  return $Address -match "^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)"
}

function Get-FrameDiscoveryStatePath {
  $env = Get-EnvMap
  $dataRoot = "./data"
  if ($env.FRAME_DATA_ROOT) { $dataRoot = $env.FRAME_DATA_ROOT }
  $stateDir = Join-Path (Resolve-FrameDataPath $dataRoot) "state"
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  return Join-Path $stateDir "frame-mdns.json"
}

function Get-FrameDiscoveryWatchStatePath {
  return Join-Path (Split-Path -Parent (Get-FrameDiscoveryStatePath)) "frame-mdns-watch.json"
}

function Get-FrameDiscoveryStartupPath {
  if (-not $env:APPDATA) { return $null }
  $startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
  New-Item -ItemType Directory -Force -Path $startupDir | Out-Null
  return Join-Path $startupDir "Syronius FRAME Discovery.cmd"
}

function Get-FrameDiscoveryProcess {
  $statePath = Get-FrameDiscoveryStatePath
  if (-not (Test-Path $statePath)) { return $null }
  try {
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    $processId = [int]$state.pid
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if ($process -and $process.Name -eq "dns-sd.exe" -and $process.CommandLine -like "*frame.local*") {
      return $process
    }
  } catch {}
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  return $null
}

function Stop-FrameDiscoveryPublisher {
  param([switch]$Quiet)
  $statePath = Get-FrameDiscoveryStatePath
  if (-not (Test-Path $statePath)) { return }
  try {
    $process = Get-FrameDiscoveryProcess
    if ($process) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
      if (-not $Quiet) { Write-Host "Stopped frame.local discovery." -ForegroundColor DarkGray }
    }
  } catch {
    if (-not $Quiet) { Write-Host "Could not inspect the previous frame.local publisher." -ForegroundColor Yellow }
  } finally {
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  }
}

function Start-FrameDiscovery {
  param([switch]$PublisherOnly)
  Stop-FrameDiscoveryPublisher -Quiet
  $publisher = Get-Command dns-sd.exe -ErrorAction SilentlyContinue
  if (-not $publisher) {
    Write-Host "FRAME is running, but this computer does not provide dns-sd for frame.local discovery." -ForegroundColor Yellow
    return
  }
  $addresses = @(Get-HostLanIPv4Candidates)
  if ($addresses.Count -eq 0) {
    Write-Host "FRAME is running, but no private LAN address was found for frame.local discovery." -ForegroundColor Yellow
    return
  }
  $env = Get-EnvMap
  $port = 80
  if ($env.EDGE_HTTP_PORT) { $port = [int]$env.EDGE_HTTP_PORT }
  $address = $addresses[0]
  $process = Start-Process -FilePath $publisher.Source -ArgumentList @(
    "-P", "FRAME", "_http._tcp", "local", "$port", "frame.local", $address, "path=/dashboard"
  ) -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 250
  if ($process.HasExited) {
    Write-Host "FRAME is running, but frame.local discovery could not start." -ForegroundColor Yellow
    return
  }
  [pscustomobject]@{
    pid = $process.Id
    address = $address
    port = $port
    startedAt = [DateTime]::UtcNow.ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath (Get-FrameDiscoveryStatePath) -Encoding UTF8
  $url = "http://frame.local"
  if ($port -ne 80) { $url = "http://frame.local:$port" }
  Write-Host "FRAME is available on the LAN at $url" -ForegroundColor Green
  if (-not $PublisherOnly) { Enable-FrameDiscoveryWatch }
}

function Test-FrameEdgeReachable {
  $env = Get-EnvMap
  $port = 80
  if ($env.EDGE_HTTP_PORT) { $port = [int]$env.EDGE_HTTP_PORT }
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connection = $client.ConnectAsync("127.0.0.1", $port)
    return $connection.Wait(1000) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Test-FrameDiscoveryWatchRunning {
  $statePath = Get-FrameDiscoveryWatchStatePath
  if (-not (Test-Path $statePath)) { return $false }
  try {
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    $processId = [int]$state.pid
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    return [bool]($process -and $process.Name -eq "powershell.exe" -and $process.CommandLine -like "*stack.ps1*discovery-watch*")
  } catch {
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    return $false
  }
}

function Enable-FrameDiscoveryWatch {
  $startupPath = Get-FrameDiscoveryStartupPath
  if ($startupPath) {
    $command = '@start "" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" discovery-watch' -f $PSCommandPath
    Set-Content -LiteralPath $startupPath -Value $command -Encoding ASCII
  }
  if (-not (Test-FrameDiscoveryWatchRunning)) {
    Start-Process -FilePath "powershell.exe" -ArgumentList @(
      "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", ('"{0}"' -f $PSCommandPath), "discovery-watch"
    ) -WindowStyle Hidden | Out-Null
  }
}

function Watch-FrameDiscovery {
  $statePath = Get-FrameDiscoveryWatchStatePath
  [pscustomobject]@{
    pid = $PID
    startedAt = [DateTime]::UtcNow.ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
  try {
    while ($true) {
      if (Test-FrameEdgeReachable) {
        if (-not (Get-FrameDiscoveryProcess)) { Start-FrameDiscovery -PublisherOnly }
      } elseif (Get-FrameDiscoveryProcess) {
        Stop-FrameDiscoveryPublisher -Quiet
      }
      Start-Sleep -Seconds 10
    }
  } finally {
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  }
}

function Stop-FrameDiscovery {
  param([switch]$Quiet)
  $watchStatePath = Get-FrameDiscoveryWatchStatePath
  if (Test-FrameDiscoveryWatchRunning) {
    $state = Get-Content $watchStatePath -Raw | ConvertFrom-Json
    Stop-Process -Id ([int]$state.pid) -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $watchStatePath -Force -ErrorAction SilentlyContinue
  $startupPath = Get-FrameDiscoveryStartupPath
  if ($startupPath) { Remove-Item -LiteralPath $startupPath -Force -ErrorAction SilentlyContinue }
  Stop-FrameDiscoveryPublisher -Quiet:$Quiet
}

function Get-PhotoFtpPassiveHostDefault {
  param([hashtable]$Env)
  $current = ""
  if ($Env -and $Env.PHOTO_FTP_PASSIVE_HOST) {
    $current = [string]$Env.PHOTO_FTP_PASSIVE_HOST
  }
  if ($current -and $current -ne "127.0.0.1") {
    return $current
  }
  $candidates = @(Get-HostLanIPv4Candidates)
  if ($candidates.Count -gt 0) {
    return $candidates[0]
  }
  return $current
}

function Read-PhotoFtpPassiveHost {
  param([hashtable]$Env)
  $default = Get-PhotoFtpPassiveHostDefault $Env
  $detected = @(Get-HostLanIPv4Candidates)
  if ($detected.Count -gt 1) {
    Write-Host "Detected LAN IPv4 candidates for Photo FTP: $($detected -join ', ')" -ForegroundColor DarkGray
  } elseif ($detected.Count -eq 1) {
    Write-Host "Detected LAN IPv4 for Photo FTP: $($detected[0])" -ForegroundColor DarkGray
  } elseif (-not $default -or $default -eq "127.0.0.1") {
    Write-Host "Could not auto-detect a LAN IPv4 address. Enter the FRAME host address your camera can reach." -ForegroundColor Yellow
  }
  return Read-Default "Photo FTP passive/LAN host" $default
}

function Configure-AuthSessionDays {
  $env = Get-EnvMap
  $current = "7"
  if ($env.FRAME_AUTH_SESSION_DAYS) { $current = $env.FRAME_AUTH_SESSION_DAYS }
  $days = Read-Default "Shared login session length in days (1-30)" $current
  Invoke-Install @("--set", "FRAME_AUTH_SESSION_DAYS=$days")
}

function Ensure-PortalAuth {
  $env = Get-EnvMap
  if ($env.PORTAL_USERNAME -and $env.PORTAL_PASSWORD) { return }
  Write-Host "Portal login is required before FRAME can start." -ForegroundColor Cyan
  $username = Read-Default "Portal username" $env.PORTAL_USERNAME
  $password = Read-PlainTextSecret "Portal password (input hidden)"
  Configure-AuthSessionDays
  Invoke-RuntimeInput @("set-portal-auth") "$username`n$password"
}

function Read-Timezone {
  param([string]$Current)
  if ([string]::IsNullOrWhiteSpace($Current)) { $Current = "America/Chicago" }
  $timezones = @(
    [pscustomobject]@{ Name = "Eastern"; Value = "America/New_York" },
    [pscustomobject]@{ Name = "Central"; Value = "America/Chicago" },
    [pscustomobject]@{ Name = "Mountain"; Value = "America/Denver" },
    [pscustomobject]@{ Name = "Arizona"; Value = "America/Phoenix" },
    [pscustomobject]@{ Name = "Pacific"; Value = "America/Los_Angeles" },
    [pscustomobject]@{ Name = "Alaska"; Value = "America/Anchorage" },
    [pscustomobject]@{ Name = "Hawaii"; Value = "Pacific/Honolulu" },
    [pscustomobject]@{ Name = "Atlantic"; Value = "America/Halifax" },
    [pscustomobject]@{ Name = "Newfoundland"; Value = "America/St_Johns" }
  )
  while ($true) {
    Write-Host "Timezone:"
    for ($index = 0; $index -lt $timezones.Count; $index++) {
      Write-Host "$($index + 1). $($timezones[$index].Name) ($($timezones[$index].Value))"
    }
    Write-Host "C. Custom"
    $choice = (Read-Host "Selection [keep $Current]").Trim()
    if ([string]::IsNullOrWhiteSpace($choice)) { return $Current }
    if ($choice -eq "C" -or $choice -eq "c") { return Read-Default "Custom timezone" $Current }
    $number = 0
    if ([int]::TryParse($choice, [ref]$number) -and $number -ge 1 -and $number -le $timezones.Count) {
      return $timezones[$number - 1].Value
    }
    Write-Host "Choose a listed timezone, C for custom, or Enter to keep the current value." -ForegroundColor Yellow
  }
}

function Read-MenuChoice {
  param([string]$Prompt, [string[]]$Allowed)
  while ($true) {
    $choice = (Read-Host $Prompt).Trim()
    if ($Allowed -contains $choice) { return $choice }
    Write-Host "Choose one of: $($Allowed -join ', ')." -ForegroundColor Yellow
  }
}

function Read-YesNo {
  param([string]$Prompt, [bool]$Default = $false)
  $label = "[y/N]"
  if ($Default) { $label = "[Y/n]" }
  $answer = (Read-Host "$Prompt $label").Trim().ToLowerInvariant()
  if (-not $answer) { return $Default }
  return $answer -eq "y" -or $answer -eq "yes"
}

function Wait-ForMenu {
  [void](Read-Host "Press Enter to return to the menu")
}

function Invoke-Install {
  param([string[]]$Arguments)
  Invoke-Runtime (@("install") + $Arguments)
  Invoke-Compose @("config", "--quiet")
}

function Invoke-StartStack {
  Write-Host ""
  Write-Host "Reconciling configuration..." -ForegroundColor Cyan
  Invoke-Runtime @("install")
  Invoke-Compose @("config", "--quiet")
  Write-Host "Validating startup requirements..." -ForegroundColor Cyan
  Invoke-Runtime @("validate", "--for-start")
  Invoke-Compose @("up", "-d", "--build", "--remove-orphans", "--wait", "--wait-timeout", "120")
  $currentEnv = Get-EnvMap
  if ($currentEnv.FRAME_MODE -eq "HYBRID") {
    Invoke-Compose @("up", "-d", "--force-recreate", "--no-deps", "--wait", "--wait-timeout", "60", "frame-public-gateway")
  }
  Start-FrameDiscovery
  Write-Host "FRAME stack reconciliation completed." -ForegroundColor Green
}

function Invoke-ReadinessFlow {
  Write-Host ""
  Write-Host "Validation" -ForegroundColor Cyan
  Invoke-Runtime @("validate")
  Invoke-Compose @("config", "--quiet")
  Write-Host ""
  Write-Host "Verification" -ForegroundColor Cyan
  Invoke-Verification
  Invoke-Compose @("config", "--quiet")
  Write-Host "Configuration and contracts are ready." -ForegroundColor Green
  if (Read-YesNo "Start or update the complete FRAME stack now?") {
    Invoke-StartStack
  }
}

function Get-SetupIssues {
  $issues = [System.Collections.Generic.List[string]]::new()
  $env = Get-EnvMap
  $config = Get-StackConfig
  if (-not $config) {
    $issues.Add("FRAME has not been configured yet.")
    return $issues
  }
  if ($config.mode -eq "HYBRID" -and -not $env.CLOUDFLARE_PUBLIC_HOSTNAME) {
    $issues.Add("Hybrid mode needs a public hostname.")
  }
  if ($config.mode -eq "HYBRID") {
    $dataRoot = "./data"
    if ($env.FRAME_DATA_ROOT) { $dataRoot = $env.FRAME_DATA_ROOT }
    $tokenPath = Join-Path (Resolve-FrameDataPath $dataRoot) "state\cloudflare-tunnel-token"
    $token = ""
    if (Test-Path $tokenPath) { $token = (Get-Content $tokenPath -Raw).Trim() }
    if ($token.Length -lt 100 -or $token -eq "paste_cloudflare_tunnel_token_here") {
      $issues.Add("Hybrid mode needs a Cloudflare tunnel token.")
    }
  }
  if (-not $env.PORTAL_USERNAME -or -not $env.PORTAL_PASSWORD) {
    $issues.Add("Portal login needs setup.")
  }
  if ((Test-CapabilityEnabled $config "frame-photo-ftp") -and $env.PHOTO_FTP_PASSIVE_HOST -eq "127.0.0.1") {
    $issues.Add("Photo FTP passive host still points at 127.0.0.1.")
  }
  if (((Test-CapabilityEnabled $config "frame-photo-ftp") -or (Test-CapabilityEnabled $config "frame-photo-webupload")) -and $env.FRAME_HOST_DATA_ROOT -eq "/data") {
    $issues.Add("Host-visible photo data path is not configured for StreamerBot.")
  }
  if ((Test-CapabilityEnabled $config "frame-discord-audio-bridge") -and ($env.DISCORD_TOKEN -like "your_*" -or $env.DISCORD_CLIENT_ID -like "your_*")) {
    $issues.Add("Discord Audio Bridge credentials need setup.")
  }
  return $issues
}

function Show-ConfigurationSummary {
  $env = Get-EnvMap
  $config = Get-StackConfig
  if (-not $config) {
    Write-Host "Current state: Not configured" -ForegroundColor Yellow
    return
  }
  $enabled = @($Capabilities | Where-Object { Test-CapabilityEnabled $config $_.Key }).Count
  $timezone = "America/Chicago"
  if ($env.TIMEZONE) { $timezone = $env.TIMEZONE }
  Write-Host "Current state: $($config.mode) | $enabled optional services enabled | Timezone $timezone | Edge $($env.EDGE_LAN_BASE_URL)" -ForegroundColor DarkGray
  $issues = @(Get-SetupIssues)
  if ($issues.Count -eq 0) {
    Write-Host "Readiness: no known setup issues" -ForegroundColor Green
  } else {
    Write-Host "Readiness: $($issues.Count) setup item(s) need attention" -ForegroundColor Yellow
  }
}

function Select-Capabilities {
  $config = Get-StackConfig
  $selected = @{}
  foreach ($capability in $Capabilities) {
    $selected[$capability.Key] = Test-CapabilityEnabled $config $capability.Key
  }
  while ($true) {
    Clear-Host
    Write-Host "Configure Services" -ForegroundColor Cyan
    Write-Host "Toggle services, then choose 0 to apply. Required dependencies are enabled automatically." -ForegroundColor DarkGray
    Write-Host ""
    for ($index = 0; $index -lt $Capabilities.Count; $index++) {
      $capability = $Capabilities[$index]
      $mark = "[ ]"
      if ($selected[$capability.Key]) { $mark = "[x]" }
      Write-Host "$($index + 1). $mark $($capability.Name)"
      Write-Host "   $($capability.Description)" -ForegroundColor DarkGray
    }
    Write-Host "0. Apply and return"
    $choice = Read-MenuChoice "Selection" (@("0") + (1..$Capabilities.Count | ForEach-Object { "$_" }))
    if ($choice -eq "0") { break }
    $capability = $Capabilities[[int]$choice - 1]
    $selected[$capability.Key] = -not $selected[$capability.Key]
  }

  if ($selected["frame-overlays"]) { $selected["frame-video-relay"] = $true }
  if ($selected["frame-photo-todaytools"]) { $selected["frame-photo-gallery"] = $true }
  if ($selected["frame-photo-gallery"] -and -not ($selected["frame-photo-ftp"] -or $selected["frame-photo-webupload"])) {
    $selected["frame-photo-webupload"] = $true
    Write-Host "Browser Photo Upload was enabled to satisfy the Photo Gallery input requirement." -ForegroundColor Yellow
  }

  $arguments = @()
  $needsBelaboxHybrid = $selected["frame-belabox-manager"] -and (-not $config -or $config.mode -ne "HYBRID")
  foreach ($capability in $Capabilities) {
    if ($selected[$capability.Key]) {
      $arguments += @("--enable", $capability.Key)
    } else {
      $arguments += @("--disable", $capability.Key)
    }
  }
  if ($needsBelaboxHybrid) {
    $currentEnv = Get-EnvMap
    Write-Host "Belabox Manager requires Hybrid mode. FRAME will stage Hybrid access now." -ForegroundColor Yellow
    while ($true) {
      $hostname = Read-Default "Cloudflare public hostname (or 0 to cancel)" $currentEnv.CLOUDFLARE_PUBLIC_HOSTNAME
      if ($hostname -eq "0") { return }
      if ([string]::IsNullOrWhiteSpace($hostname)) {
        Write-Host "A public hostname is required." -ForegroundColor Yellow
        continue
      }
      try {
        Invoke-Runtime (@("install", "--mode", "HYBRID", "--public-hostname", $hostname) + $arguments)
        break
      } catch {
        Write-Host "Hybrid setup was not applied. Enter a valid public hostname or 0 to cancel." -ForegroundColor Red
      }
    }
    Invoke-Compose @("config", "--quiet")
    return
  }
  Invoke-Install $arguments
}

function Configure-NetworkStorage {
  $env = Get-EnvMap
  $config = Get-StackConfig
  $modeChoice = Read-MenuChoice "Deployment mode: 1) Keep current  2) LAN  3) HYBRID" @("1", "2", "3")
  $mode = "LAN"
  if ($modeChoice -eq "2") {
    $mode = "LAN"
  } elseif ($modeChoice -eq "3") {
    $mode = "HYBRID"
  } elseif ($config) {
    $mode = $config.mode
  }
  $arguments = @("--mode", $mode)
  if ($mode -eq "HYBRID") {
    $hostname = Read-Default "Cloudflare public hostname" $env.CLOUDFLARE_PUBLIC_HOSTNAME
    $arguments += @("--public-hostname", $hostname)
    $relayHost = $env.PUBLIC_RELAY_HOST
    if ($relayHost -eq "localhost") { $relayHost = "" }
    $relayHost = Read-Default "Public SRTLA relay hostname or IPv4 address" $relayHost
    if ($relayHost) { $arguments += @("--public-relay-host", $relayHost) }
  }
  $edgePort = "80"
  if ($env.EDGE_HTTP_PORT) { $edgePort = $env.EDGE_HTTP_PORT }
  $dataRoot = Join-Path $Root "data"
  if ($env.FRAME_DATA_ROOT) { $dataRoot = $env.FRAME_DATA_ROOT }
  $timezone = "America/Chicago"
  if ($env.TIMEZONE) { $timezone = $env.TIMEZONE }
  $arguments += @("--edge-http-port", (Read-Default "FRAME Edge HTTP port" $edgePort))
  $dataRoot = Read-Default "FRAME data folder" $dataRoot
  $arguments += @("--data-root", $dataRoot)
  $arguments += @("--set", "TIMEZONE=$(Read-Timezone $timezone)")
  Invoke-Install $arguments
}

function Configure-StandardSettings {
  Configure-NetworkStorage
  Select-Capabilities
  Ensure-PortalAuth
  $env = Get-EnvMap
  $config = Get-StackConfig
  if (Test-CapabilityEnabled $config "frame-photo-ftp") {
    Invoke-Install @("--set", "PHOTO_FTP_PASSIVE_HOST=$(Read-PhotoFtpPassiveHost $env)")
  }
}

function Resolve-SetupIssues {
  $env = Get-EnvMap
  $config = Get-StackConfig
  if (-not $config) {
    Configure-StandardSettings
    return
  }
  if ($config.mode -eq "HYBRID" -and -not $env.CLOUDFLARE_PUBLIC_HOSTNAME) {
    Invoke-Install @("--mode", "HYBRID", "--public-hostname", (Read-Default "Cloudflare public hostname" ""))
    $env = Get-EnvMap
  }
  if (-not $env.PORTAL_USERNAME -or -not $env.PORTAL_PASSWORD) {
    Ensure-PortalAuth
    $env = Get-EnvMap
  }
  if ($config.mode -eq "HYBRID" -and (@(Get-SetupIssues) -contains "Hybrid mode needs a Cloudflare tunnel token.")) {
    $token = Read-PlainTextSecret "Cloudflare tunnel token (input hidden)"
    Invoke-RuntimeInput @("set-tunnel-token") $token
  }
  if ((Test-CapabilityEnabled $config "frame-photo-ftp") -and $env.PHOTO_FTP_PASSIVE_HOST -eq "127.0.0.1") {
    Invoke-Install @("--set", "PHOTO_FTP_PASSIVE_HOST=$(Read-PhotoFtpPassiveHost $env)")
  }
  if (((Test-CapabilityEnabled $config "frame-photo-ftp") -or (Test-CapabilityEnabled $config "frame-photo-webupload")) -and $env.FRAME_HOST_DATA_ROOT -eq "/data") {
    $dataRoot = Join-Path $Root "data"
    if ($env.FRAME_DATA_ROOT) { $dataRoot = $env.FRAME_DATA_ROOT }
    Invoke-Install @("--host-data-root", $dataRoot)
  }
  if ((Test-CapabilityEnabled $config "frame-discord-audio-bridge") -and ($env.DISCORD_TOKEN -like "your_*" -or $env.DISCORD_CLIENT_ID -like "your_*")) {
    $clientId = Read-Default "Discord application client ID" $env.DISCORD_CLIENT_ID
    $token = Read-PlainTextSecret "Discord bot token (input hidden)"
    Invoke-RuntimeInput @("set-discord-auth") "$clientId`n$token"
  }
}

function Configure-AdvancedSetting {
  $env = Get-EnvMap
  Write-Host ""
  Write-Host "Advanced non-secret settings" -ForegroundColor Cyan
  for ($index = 0; $index -lt $AdvancedSettings.Count; $index++) {
    $key = $AdvancedSettings[$index]
    Write-Host "$($index + 1). $key = $($env[$key])"
  }
  Write-Host "0. Back"
  $choice = Read-MenuChoice "Setting to change" (@("0") + (1..$AdvancedSettings.Count | ForEach-Object { "$_" }))
  if ($choice -eq "0") { return }
  $key = $AdvancedSettings[[int]$choice - 1]
  $value = Read-Default $key $env[$key]
  Invoke-Install @("--set", "$key=$value")
}

function Configure-Credentials {
  while ($true) {
    Write-Host ""
    Write-Host "Credentials and Security" -ForegroundColor Cyan
    Write-Host "1. Portal login        Shared login and session length for protected panels"
    Write-Host "2. Cloudflare token    Hidden connector token for Hybrid mode"
    Write-Host "3. Discord bot         Client ID and hidden bot token"
    Write-Host "4. Photo FTP           Camera upload username and hidden password"
    Write-Host "5. Stream Management   Optional basic-auth username and hidden password"
    Write-Host "6. Overlay Wizard      Optional basic-auth username and hidden password"
    Write-Host "0. Back"
    switch (Read-MenuChoice "Selection" @("0", "1", "2", "3", "4", "5", "6")) {
      "0" { return }
      "1" {
        $username = Read-Host "Portal username"
        $password = Read-PlainTextSecret "Portal password (input hidden)"
        Configure-AuthSessionDays
        Invoke-RuntimeInput @("set-portal-auth") "$username`n$password"
      }
      "2" {
        $token = Read-PlainTextSecret "Paste the Cloudflare tunnel token (input hidden)"
        Invoke-RuntimeInput @("set-tunnel-token") $token
      }
      "3" {
        $clientId = Read-Host "Discord application client ID"
        $token = Read-PlainTextSecret "Discord bot token (input hidden)"
        Invoke-RuntimeInput @("set-discord-auth") "$clientId`n$token"
      }
      "4" {
        $env = Get-EnvMap
        $username = Read-Default "Photo FTP username" $env.PHOTO_FTP_USERNAME
        $minimum = "5"
        if ($env.PHOTO_FTP_MIN_PASSWORD_LENGTH) {
          $minimum = $env.PHOTO_FTP_MIN_PASSWORD_LENGTH
        }
        $password = Read-PlainTextSecret "Photo FTP password, at least $minimum characters (input hidden)"
        Invoke-RuntimeInput @("set-service-auth") "photo-ftp`n$username`n$password"
      }
      "5" {
        $env = Get-EnvMap
        $username = Read-Default "Stream Management username" $env.STREAMS_USERNAME
        $password = Read-PlainTextSecret "Stream Management password (input hidden)"
        Invoke-RuntimeInput @("set-service-auth") "streams`n$username`n$password"
      }
      "6" {
        $env = Get-EnvMap
        $username = Read-Default "Overlay Wizard username" $env.OVERLAYS_USERNAME
        $password = Read-PlainTextSecret "Overlay Wizard password (input hidden)"
        Invoke-RuntimeInput @("set-service-auth") "overlays`n$username`n$password"
      }
    }
  }
}

function Invoke-GuidedSetup {
  Clear-Host
  Write-Host "Guided FRAME Setup" -ForegroundColor Cyan
  $issues = @(Get-SetupIssues)
  if ($issues.Count) {
    Write-Host "Items needing attention:" -ForegroundColor Yellow
    foreach ($issue in $issues) { Write-Host " - $issue" }
    Write-Host ""
    $scope = Read-MenuChoice "Setup scope: 1) Resolve these issues only  2) Review everything  0) Cancel" @("0", "1", "2")
    if ($scope -eq "0") { return }
    if ($scope -eq "1") {
      Resolve-SetupIssues
      Invoke-ReadinessFlow
      return
    }
  } else {
    Write-Host "No known setup issues. You can still review the complete configuration." -ForegroundColor Green
  }
  Write-Host ""
  $level = Read-MenuChoice "Configuration level: 1) Standard  2) Advanced  0) Cancel" @("0", "1", "2")
  if ($level -eq "0") { return }
  Configure-StandardSettings
  if ($level -eq "2") {
    while (Read-YesNo "Change an advanced setting?") { Configure-AdvancedSetting }
  }
  if (Read-YesNo "Review optional credentials and security now?") { Configure-Credentials }
  Invoke-ReadinessFlow
}

function Invoke-InteractiveMenu {
  while ($true) {
    Clear-Host
    Write-Host "Syronius FRAME Installer" -ForegroundColor Cyan
    Write-Host "Guided configuration and lifecycle management" -ForegroundColor DarkGray
    Write-Host ""
    Show-ConfigurationSummary
    Write-Host ""
    Write-Host "1. Guided setup                 Resolve setup issues or review all settings"
    Write-Host "2. Configure services           Enable or disable FRAME capabilities"
    Write-Host "3. Configure network/storage    Mode, hostname, data path, timezone, and Edge settings"
    Write-Host "4. Configure Hybrid access      Stage hostname, tunnel token, and Portal login"
    Write-Host "5. Credentials and security     Portal, Cloudflare, and Discord credentials"
    Write-Host "6. Validate and verify          Check configuration and contracts"
    Write-Host "7. Start or update stack        Reconcile the complete Docker Compose stack"
    Write-Host "8. Status and logs              Inspect configuration, containers, or logs"
    Write-Host "9. Stop stack                   Stop services without deleting data"
    Write-Host "10. Advanced settings           Edit one advanced non-secret setting"
    Write-Host "11. Reset FRAME                 Remove generated configuration and data"
    Write-Host "0. Exit"
    try {
      switch (Read-MenuChoice "Selection" @("0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11")) {
        "0" { return }
        "1" { Invoke-GuidedSetup; Wait-ForMenu }
        "2" { Select-Capabilities; Invoke-ReadinessFlow; Wait-ForMenu }
        "3" { Configure-NetworkStorage; Invoke-ReadinessFlow; Wait-ForMenu }
        "4" {
          $env = Get-EnvMap
          $hostname = Read-Default "Cloudflare public hostname" $env.CLOUDFLARE_PUBLIC_HOSTNAME
          Invoke-Install @("--mode", "HYBRID", "--public-hostname", $hostname)
          Configure-Credentials
          Invoke-ReadinessFlow
          Wait-ForMenu
        }
        "5" { Configure-Credentials; Wait-ForMenu }
        "6" { Invoke-ReadinessFlow; Wait-ForMenu }
        "7" { Invoke-StartStack; Wait-ForMenu }
        "8" {
          Invoke-Runtime @("status")
          Invoke-Compose @("ps", "--all")
          if (Read-YesNo "Show recent logs?") {
            $service = Read-Default "Service name, or leave blank for all" ""
            $logArguments = @("logs", "--tail", "150")
            if ($service) { $logArguments += $service }
            Invoke-Compose $logArguments
          }
          Wait-ForMenu
        }
        "9" { if (Read-YesNo "Stop the complete FRAME stack?") { Stop-FrameDiscovery; Invoke-Compose @("down") }; Wait-ForMenu }
        "10" { Configure-AdvancedSetting; Invoke-ReadinessFlow; Wait-ForMenu }
        "11" {
          $answer = Read-Host "Reset removes FRAME's generated config and data. Type RESET to continue"
          if ($answer -ceq "RESET") {
            Stop-FrameDiscovery
            if (Test-Path (Join-Path $Root "docker-compose.yml")) { Invoke-Compose @("down", "--remove-orphans") }
            Invoke-Runtime @("reset", "--yes")
          }
          Wait-ForMenu
        }
      }
    } catch {
      Write-Host ""
      Write-Host $_.Exception.Message -ForegroundColor Red
      Wait-ForMenu
    }
  }
}

if ($Command -notin @("discovery-start", "discovery-stop", "discovery-watch")) {
  Assert-Docker
}

switch ($Command) {
  "menu" {
    Invoke-InteractiveMenu
  }
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
    Configure-AuthSessionDays
    Invoke-RuntimeInput @("set-portal-auth") "$username`n$password"
  }
  "discord-auth" {
    $clientId = Read-Host "Discord application client ID"
    $token = Read-PlainTextSecret "Discord bot token (input hidden)"
    Invoke-RuntimeInput @("set-discord-auth") "$clientId`n$token"
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
    Invoke-StartStack
  }
  "discovery-start" {
    Start-FrameDiscovery
  }
  "discovery-stop" {
    Stop-FrameDiscovery
  }
  "discovery-watch" {
    Watch-FrameDiscovery
  }
  "stop" {
    Stop-FrameDiscovery
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
    Stop-FrameDiscovery
    if (Test-Path (Join-Path $Root "docker-compose.yml")) {
      Invoke-Compose @("down", "--remove-orphans")
    }
    Invoke-Runtime @("reset", "--yes")
  }
  default {
    Invoke-Runtime (@($Command) + $CommandArgs)
  }
}
