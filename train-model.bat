@echo off
setlocal

set "ROOT=%~dp0"

echo ===================================================
echo   🧺 LaundryAI - Deep Neural Network Model Training
echo ===================================================
echo.
echo Dataset directory: data/
echo Output model:     backend/models/fabric_mobilenetv2.pt
echo.

cd /d "%ROOT%backend"

if not exist ".venv\Scripts\python.exe" (
    echo [.venv not found. Creating Python virtual environment...]
    python -m venv .venv
    ".venv\Scripts\python.exe" -m pip install --upgrade pip
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)

echo [Starting MobileNetV2 Training across all fabric datasets...]
echo.
".venv\Scripts\python.exe" scripts/train.py --data ../data --epochs 15 --batch-size 32

echo.
echo ===================================================
echo   Training Completed!
echo   Updated model weights saved to backend/models/
echo ===================================================
echo.
pause
endlocal
