@echo off
title Stop EyeTech VMS Server
echo ===================================================
echo   Stopping EyeTech Video Management System (VMS)...
echo ===================================================
taskkill /f /im node.exe
echo.
echo Server processes stopped successfully. You can close this window.
timeout /t 3
