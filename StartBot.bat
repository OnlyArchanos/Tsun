@echo off
:: Force the script to run in the directory where the .bat file is physically located
cd /d "%~dp0"

title Tsun Bot Launcher
echo ===================================
echo Starting Tsun Bot...
echo ===================================

:: 1. Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in your system PATH!
    echo Please go to https://nodejs.org and install the 'LTS' version.
    echo Make sure to check the box that says "Add to PATH" during installation.
    echo.
    pause
    exit /b
)

:: 2. Check for .env file setup
if not exist .env (
    echo [SETUP] No .env file found!
    if exist .env.example (
        echo [SETUP] Creating a blank .env file for you from .env.example...
        copy .env.example .env >nul
    ) else (
        echo [SETUP] Creating a completely blank .env file...
        type nul > .env
    )
    echo.
    echo =================================================================
    echo ACTION REQUIRED:
    echo A new .env file has been created in this folder.
    echo Please open it with Notepad, paste in the database keys/tokens,
    echo save it, and then double-click StartBot.bat again to run!
    echo =================================================================
    echo.
    pause
    exit /b
)

:: 3. Install dependencies quietly (only logs errors or major output)
echo Checking dependencies (this might take a moment on first run)...
call npm install --no-audit --no-fund

echo.
echo Launching Bot (Checking for updates from GitHub...)
node launcher.js

echo.
echo Bot process ended or crashed.
pause
