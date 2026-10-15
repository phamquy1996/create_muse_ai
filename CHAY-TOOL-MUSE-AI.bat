@echo off
chcp 65001 >nul
title Muse AI Image Studio - Tool Tao Anh Tu Dong
cd /d "%~dp0"

echo ============================================================
echo   🎨 DANG KHOI DONG MUSE AI IMAGE STUDIO
echo   Tu dong ket noi Cookie Muse.ai ^& Tao anh chat luong goc
echo ============================================================
echo.

if not exist "node_modules" (
  if not exist "..\human-test\node_modules\playwright-core" (
    echo [!] Dang cai dat thu vien playwright-core lan dau...
    call npm install
  )
)

start "" powershell -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 1500; Start-Process 'http://localhost:3456'"

echo ------------------------------------------------------------
echo   🌐 GIAO DIEN WEB STUDIO: http://localhost:3456
echo   📁 Thu muc luu anh goc:  outputs\
echo   🛑 De tat Tool: Dong cua so nay hoac nhan Ctrl+C.
echo ------------------------------------------------------------
echo.

node server.js

if %errorlevel% neq 0 (
  echo.
  echo [LOI] Server bi dung dot ngot!
  pause
)
