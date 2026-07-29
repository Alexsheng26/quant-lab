@echo off
REM Start the market data backend (FastAPI + yfinance / akshare) on 127.0.0.1:8000.
REM ASCII-only on purpose -- see the note at the top of quantlab.bat.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [!] No .venv found. Install dependencies once:
  echo       python -m venv .venv
  echo       .venv\Scripts\pip install -r backend\requirements.txt
  pause
  exit /b 1
)
".venv\Scripts\python.exe" backend\app.py
pause
