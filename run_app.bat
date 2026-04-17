@echo off
setlocal
title JPL Library Security Monitor - System Launcher

echo ====================================================
echo  JPL Library Security Monitor - Launcher
echo ====================================================
echo.

:: 1. Navigate to backend directory
cd /d "%~dp0backend"

:: 2. Check if virtual environment exists
if not exist venv (
    echo [ERROR] Virtual environment 'venv' not found in \backend directory.
    echo Please run 'install.bat' first to set up dependencies.
    echo.
    pause
    exit /b 1
)

:: 3. Launch the browser in a separate process (small delay to allow server startup)
echo [1/2] Preparing to open Dashboard (http://localhost:8000)...
start /b cmd /c "timeout /t 5 >nul && start http://localhost:8000"

:: 4. Start the FastAPI backend
echo [2/2] Launching Backend Server...
echo (SSH Tunnel and CDC Listener will initialize automatically)
echo.

call venv\Scripts\activate.bat
python main.py

if %errorlevel% neq 0 (
    echo.
    echo [CRITICAL ERROR] Backend failed to start.
    echo Ensure Python is installed and requirements are satisfied.
    echo.
    pause
)

endlocal
