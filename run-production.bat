@echo off
setlocal
cd /d "%~dp0"
call frontend\node_modules\.bin\vite.cmd build
if errorlevel 1 exit /b %errorlevel%
if not exist backend\.venv\Scripts\python.exe (
  echo Create backend\.venv and install backend\requirements.txt first.
  exit /b 1
)
echo LaundryAI is available at http://127.0.0.1:8000
backend\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
