@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
chcp 65001 >nul
title SillyTavern GPT-SoVITS Launcher

echo [INFO] Starting up...
echo [INFO] Current path: %cd%

:: Set PYTHONPATH to current directory
set "PYTHONPATH=%~dp0"

:: Try embedded Python runtime first
set "RUNTIME_PYTHON=%~dp0runtime\python\python.exe"
set "PYTHON_CMD="

if exist "%RUNTIME_PYTHON%" (
    echo [INFO] Using embedded Python runtime...
    set "PYTHON_CMD=%RUNTIME_PYTHON%"
    goto python_found
)

:: Fallback to system Python
echo [INFO] Embedded runtime not found, checking system Python...
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Python not found!
    echo Please ensure the 'runtime' folder exists, or install Python 3.10+.
    echo.
    pause
    exit /b 1
)
set "PYTHON_CMD=python"

:python_found
:: Verify PYTHON_CMD is valid
if not defined PYTHON_CMD (
    echo [ERROR] PYTHON_CMD is not set!
    pause
    exit /b 1
)

:: Show Python version
echo [INFO] Python: %PYTHON_CMD%
"%PYTHON_CMD%" --version

:: Install/update dependencies
echo [INFO] Checking dependencies...
"%PYTHON_CMD%" -m pip install -r requirements.txt -q

:: Start service
echo.
echo [INFO] Preparing to start Manager...
echo [INFO] If "Uvicorn running..." appears, the startup is successful.
echo [INFO] Admin UI will open automatically in your browser...
echo ---------------------------------------------------

:: Open browser after 5 seconds
start /b cmd /c "timeout /t 5 /nobreak >nul && start http://localhost:3000/admin"

"%PYTHON_CMD%" manager.py

:: Exit
echo.
echo ---------------------------------------------------
echo [INFO] Program has stopped running.
endlocal
pause
