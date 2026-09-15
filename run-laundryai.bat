@echo off
setlocal

set "ROOT=%~dp0"

echo ===================================================
echo   🧺 LaundryAI - Starting Platform (Backend + UI)
echo ===================================================
echo.

:: 1. Launch FastAPI Backend
start "🧺 LaundryAI Backend" cmd /k "cd /d "%ROOT%backend" && (if not exist ".venv\Scripts\python.exe" (python -m venv .venv && ".venv\Scripts\python.exe" -m pip install -r requirements.txt)) && ".venv\Scripts\python.exe" -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000"

:: 2. Launch Vite React Frontend
start "🧺 LaundryAI Frontend" cmd /k "cd /d "%ROOT%frontend" && (if not exist "node_modules" (call npm install)) && npm run dev"

echo Backend and Frontend have been started in dedicated windows!
echo.
echo   • Frontend Web App : http://localhost:5173
echo   • Backend API Docs : http://127.0.0.1:8000/docs
echo.
echo Opening browser in 3 seconds...
timeout /t 3 /nobreak >nul
start http://localhost:5173

endlocal
