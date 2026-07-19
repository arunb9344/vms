@echo off
title EyeTech Video Management System (VMS)
echo ===================================================
echo   Starting EyeTech Video Management System (VMS)...
echo ===================================================
echo.

:: Change directory to the folder where this batch file is located
cd /d "%~dp0"

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [Error] Node.js was not found on this system.
    echo Please install Node.js from https://nodejs.org/ and try again.
    echo.
    pause
    exit /b
)

:: Launch a background task that waits 2 seconds, then opens Chrome pointing to port 3000
:: If Chrome is not installed, it falls back to the system's default web browser.
start /b cmd /c "ping -n 3 127.0.0.1 >nul && (start chrome http://localhost:3000 2>nul || start http://localhost:3000)"

:: Start the VMS server
node index.js

:: If the server stops or crashes, keep window open to view log
echo.
echo ===================================================
echo   VMS Server Stopped.
echo ===================================================
pause
