@echo off
title Election Results Folder Monitor Server
cd /d "%~dp0"

:loop
echo [%DATE% %TIME%] Starting Election Results Monitor Server...
python "%~dp0server_monitor.py"

echo [%DATE% %TIME%] Monitor server stopped/crashed (exit code %ERRORLEVEL%). Restarting in 5 seconds...
timeout /t 5
goto loop
