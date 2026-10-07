@echo off
REM GB Logix - restart the background server (after unzipping an update over this folder). Run as administrator.
cd /d "%~dp0.."
net session >nul 2>&1
if errorlevel 1 ( echo Please right-click restart-server.bat and choose "Run as administrator". & pause & exit /b 1 )
fc /b package.json node_modules\.gb-package.json >nul 2>nul
if errorlevel 1 ( echo Updating packages... & call npm.cmd install & copy /y package.json node_modules\.gb-package.json >nul )
echo Restarting...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-ScheduledTask -TaskName 'GB Logix Server' -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*src*server.js*') -or ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*run-server.bat*') } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }; Start-Sleep 2; Start-ScheduledTask -TaskName 'GB Logix Server'; if (Get-Service cloudflared -ErrorAction SilentlyContinue) { sc.exe config cloudflared start= delayed-auto | Out-Null; sc.exe failure cloudflared reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null; Start-Service cloudflared -ErrorAction SilentlyContinue }"
ping -n 7 127.0.0.1 >nul
start "" http://localhost:3000
echo Restarted.
pause
