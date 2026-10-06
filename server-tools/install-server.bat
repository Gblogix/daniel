@echo off
REM GB Logix - make this PC the server. Right-click > "Run as administrator", once.
REM  - installs packages, sets power so the PC never sleeps on AC power (lid close = do nothing)
REM  - registers the "GB Logix Server" task: starts at boot (before anyone signs in) and restarts if it stops
cd /d "%~dp0.."
net session >nul 2>&1
if errorlevel 1 ( echo Please right-click install-server.bat and choose "Run as administrator". & pause & exit /b 1 )
where node >nul 2>nul
if errorlevel 1 ( echo Node.js is not installed - get the 22 LTS from https://nodejs.org and run this again. & pause & exit /b 1 )
if not exist .env ( copy .env.example .env >nul & echo Created .env from .env.example - edit it (BASE_URL, SESSION_SECRET, BACKUP_DIR^). )
echo [1/3] Installing packages...
call npm.cmd install
if errorlevel 1 ( echo npm install failed. & pause & exit /b 1 )
copy /y package.json node_modules\.gb-package.json >nul
echo [2/3] Registering the server task (you will be asked for YOUR Windows sign-in password once)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-server.ps1"
if errorlevel 1 ( echo Could not register the task - see the message above. & pause & exit /b 1 )
echo [3/3] Started. Opening http://localhost:3000 ...
ping -n 9 127.0.0.1 >nul
start "" http://localhost:3000
echo.
echo Done. The server now runs in the background and starts with Windows.
echo Logs: %CD%\logs\server.log    Restart after an update: server-tools\restart-server.bat
pause
