@echo off
REM GlobalBridge Logistics - Windows test launcher (double-click).
REM Installs packages the first time (and again when package.json changes), starts the app and opens the browser.
cd /d "%~dp0"
title GlobalBridge Logistics

REM If this PC is set up as the server (server-tools\install-server.bat), it already runs in the background.
schtasks /query /tn "GB Logix Server" >nul 2>&1
if not errorlevel 1 (
  echo The GB Logix server already runs in the background - opening the browser.
  start "" http://localhost:3000
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the 22 LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [1/2] Installing packages - first time only, takes a few minutes...
  call npm.cmd install
  if errorlevel 1 ( echo npm install failed. & pause & exit /b 1 )
  echo [2/2] Installing Chromium for PDF documents...
  call npx.cmd playwright install chromium
  copy /y package.json node_modules\.gb-package.json >nul
)

REM After an update: install any new packages when package.json changed.
fc /b package.json node_modules\.gb-package.json >nul 2>nul
if errorlevel 1 (
  echo Updating packages...
  call npm.cmd install
  if errorlevel 1 ( echo npm install failed. & pause & exit /b 1 )
  copy /y package.json node_modules\.gb-package.json >nul
)


echo.
echo Opening http://localhost:3000  (keep this window open; close it to stop the app)
echo Login: admin@gblogix.com / changeme123
echo.
start "" http://localhost:3000
call npm.cmd start
pause
