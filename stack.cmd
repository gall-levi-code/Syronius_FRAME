@echo off
setlocal
if not exist "%~dp0installer\stack.ps1.next" goto run
set "FRAME_NEXT_WRAPPER=%~dp0installer\stack.ps1.next"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:FRAME_NEXT_WRAPPER, [ref]$null, [ref]$errors); if ($errors.Count) { Write-Error 'Downloaded FRAME installer wrapper failed syntax validation.'; exit 1 }"
if errorlevel 1 (
  del /Q "%FRAME_NEXT_WRAPPER%" >nul 2>&1
  exit /b 1
)
move /Y "%FRAME_NEXT_WRAPPER%" "%~dp0installer\stack.ps1" >nul
if errorlevel 1 exit /b %ERRORLEVEL%
:run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\stack.ps1" %*
exit /b %ERRORLEVEL%
