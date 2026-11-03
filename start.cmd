@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
  node server.js %*
  goto :eof
)

rem Fallback: use the Node runtime bundled with DSH Desktop when Node.js is not on PATH
set "NODEEXE="
for /d %%d in ("%APPDATA%\DSH Desktop\runtime-commands\generations\*") do (
  if exist "%%d\private\node-bin\node.cmd" set "NODEEXE=%%d\private\node-bin\node.cmd"
)

if not defined NODEEXE (
  echo.
  echo  [ERROR] Node.js 18+ not found. Please install it from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

call "%NODEEXE%" server.js %*