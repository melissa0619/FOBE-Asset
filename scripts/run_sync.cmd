@echo off
setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs
".venv\Scripts\python.exe" main.py >> "logs\task-scheduler.log" 2>&1
exit /b %ERRORLEVEL%
