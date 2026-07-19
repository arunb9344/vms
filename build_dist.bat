@echo off
title VMS Dist Builder
echo ===================================================
echo   Building portable distribution folder (dist/)...
echo ===================================================
echo.

:: Create clean dist directory
if exist dist (
    echo Cleaning existing dist folder...
    rmdir /s /q dist
)
mkdir dist

:: Copy main files
copy index.js dist\
copy server.js dist\
copy recorder.js dist\
copy onvif.js dist\
copy package.json dist\
copy config.json dist\
copy vms_launcher.vbs dist\
copy stop_vms.bat dist\

:: Copy folders
echo Copying Web UI folder...
xcopy /s /e /i /y public dist\public

echo Copying node modules...
xcopy /s /e /i /y node_modules dist\node_modules

:: Copy portable node.exe if it exists in root
if exist node.exe (
    echo Bundling node.exe...
    copy node.exe dist\
) else (
    echo WARNING: node.exe was not found in the root directory!
    echo Please download portable node.exe and place it in the VMS root folder.
)

:: Exclude private owner licensing console from customer distribution folder
if exist dist\public\owner.html (
    echo Excluding private owner dashboard...
    del /q dist\public\owner.html
)

echo.
echo ===================================================
echo   Build complete! "dist/" is ready.
echo ===================================================
pause
