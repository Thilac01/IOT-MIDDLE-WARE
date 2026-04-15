@echo off
echo ====================================================
echo  JPL Library Security Monitor — Starting
echo ====================================================

REM Step 1: Open SSH tunnel in a background window
echo [1/2] Opening SSH tunnel (3307 -> server:3306)...
echo       When the new window asks for password, type: JPL@#lib260219a
echo.
start "SSH Tunnel" cmd /k "ssh -L 3307:127.0.0.1:3306 root@137.184.15.52 -o StrictHostKeyChecking=no -o ServerAliveInterval=30"

REM Give user time to enter SSH password
echo Waiting 15 seconds for tunnel to establish...
echo (Enter your SSH password in the new window now!)
timeout /t 15 /nobreak

REM Step 2: Start the FastAPI backend
echo.
echo [2/2] Starting FastAPI backend...
cd /d "%~dp0backend"
call venv\Scripts\activate.bat
python main.py

pause
