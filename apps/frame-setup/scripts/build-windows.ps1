Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$appRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $appRoot
try {
  Write-Host "Installing FRAME Setup dependencies from the lockfile..."
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }

  Write-Host "Building FRAME Setup Windows installer..."
  npm run dist:win
  if ($LASTEXITCODE -ne 0) { throw "Windows installer build failed." }
} finally {
  Pop-Location
}
