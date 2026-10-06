@echo off
REM GB Logix - check whether this PC is good enough to be the server. Double-click; results open in Notepad.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-specs.ps1"
pause
