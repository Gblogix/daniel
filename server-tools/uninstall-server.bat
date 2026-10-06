@echo off
REM GB Logix - stop the background server and remove it from Windows startup (data is kept). Run as administrator.
net session >nul 2>&1
if errorlevel 1 ( echo Please right-click uninstall-server.bat and choose "Run as administrator". & pause & exit /b 1 )
powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-ScheduledTask -TaskName 'GB Logix Server' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'GB Logix Server' -Confirm:$false -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*src*server.js*') -or ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*run-server.bat*') } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }"
echo Removed. Your data (data, uploads folders) is untouched. Use start-windows.bat to run it by hand.
pause
