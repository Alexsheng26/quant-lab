@echo off
REM ===========================================================
REM  QuantLab launcher: start the market data backend, then
REM  open index.html in the default browser.
REM
REM  Keep this file ASCII-only. cmd.exe reads a .bat by byte
REM  offset in the active codepage, so UTF-8 Chinese text -- and
REM  especially a "chcp" switch partway through -- desynchronises
REM  the parser and the script breaks in confusing ways.
REM ===========================================================
cd /d "%~dp0"
title QuantLab

echo ============================================
echo   QuantLab - US Equity Research Terminal
echo ============================================
echo.

REM --- already running? don't start a second copy ---
curl -s -o nul -m 2 http://127.0.0.1:8000/api/health
if not errorlevel 1 (
  echo [1/2] Backend already running - skipping.
  goto OPEN
)

if not exist ".venv\Scripts\python.exe" goto NOVENV

echo [1/2] Starting market data backend ...
start "QuantLab backend" /min ".venv\Scripts\python.exe" backend\app.py

set /a tries=0
:WAIT
set /a tries+=1
if %tries% GTR 30 goto TIMEOUT
REM ping, not "timeout": timeout aborts with "Input redirection is not
REM supported" whenever stdin is not a real console.
ping -n 2 127.0.0.1 >nul
curl -s -o nul -m 2 http://127.0.0.1:8000/api/health
if errorlevel 1 goto WAIT
echo       Ready: http://127.0.0.1:8000

:OPEN
echo [2/2] Opening web page ...
start "" "index.html"
echo.
echo Done. The badge in the top-right should read LIVE.
echo The backend runs in a minimised window - close it when finished.
echo.
ping -n 6 127.0.0.1 >nul
exit /b 0

:TIMEOUT
echo.
echo [!] Backend did not become ready in time.
echo     Opening the page anyway; it will use simulated data
echo     (the chart carries a watermark saying so).
echo     To see the error, run run-backend.bat on its own.
echo.
start "" "index.html"
pause
exit /b 1

:NOVENV
echo [!] No .venv found. Install dependencies once:
echo.
echo       python -m venv .venv
echo       .venv\Scripts\pip install -r backend\requirements.txt
echo.
echo Opening the page with simulated data for now.
echo.
start "" "index.html"
pause
exit /b 1
