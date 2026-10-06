@echo off
REM GB Logix server loop - started by the "GB Logix Server" scheduled task when the PC starts.
REM Restarts the app if it ever stops. Output goes to logs\server.log.
cd /d "%~dp0.."
if not exist logs mkdir logs
set NODE=node
where node >nul 2>nul || set NODE="C:\Program Files\nodejs\node.exe"
:loop
if exist logs\server.log for %%A in (logs\server.log) do if %%~zA GTR 10485760 move /y logs\server.log logs\server-old.log >nul
echo [%date% %time%] starting >> logs\server.log
%NODE% --disable-warning=ExperimentalWarning --env-file-if-exists=.env src\server.js >> logs\server.log 2>&1
echo [%date% %time%] stopped (exit %errorlevel%) - restarting in 10 seconds >> logs\server.log
ping -n 11 127.0.0.1 >nul
goto loop
