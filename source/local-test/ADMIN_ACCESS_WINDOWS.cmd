@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS from https://nodejs.org/en/download
  echo After installation, close this window and open ADMIN_ACCESS_WINDOWS.cmd again.
  pause
  exit /b 1
)
node -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)"
if errorlevel 1 (
  echo Task Controlling Management requires Node.js 24 or newer.
  echo Install Node.js 24 LTS from https://nodejs.org/en/download
  pause
  exit /b 1
)
node admin-access.mjs
pause
