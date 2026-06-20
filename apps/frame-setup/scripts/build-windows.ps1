Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$appRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $appRoot
try {
  Write-Host "Installing FRAME Setup frontend dependencies..."
  npm install

  Write-Host "Building FRAME Setup Windows installer..."
  npm run tauri build
} finally {
  Pop-Location
}
