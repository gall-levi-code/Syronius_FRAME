@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\stack.ps1" %*
exit /b %ERRORLEVEL%
