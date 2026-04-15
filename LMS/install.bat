@echo off
echo ====================================================
echo  JPL Library Security Monitor — Backend Installer
echo ====================================================
cd /d "%~dp0backend"

echo [1/3] Creating Python virtual environment...
python -m venv venv

echo [2/3] Activating venv and installing dependencies...
call venv\Scripts\activate.bat
pip install -r requirements.txt

echo [3/3] Copying .env.example to .env (edit before running!)
if not exist .env (
    copy .env.example .env
    echo  *** Please edit backend\.env with your settings ***
) else (
    echo  .env already exists, skipping.
)

echo.
echo ✓ Installation complete.
echo   Run start_backend.bat to launch the server.
pause
