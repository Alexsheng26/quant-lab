@echo off
REM Serve the front-end over HTTP at http://localhost:5500, which avoids
REM the file:// restrictions. Optional -- opening index.html directly works too.
REM ASCII-only on purpose -- see the note at the top of quantlab.bat.
cd /d "%~dp0"
start "" http://localhost:5500
python -m http.server 5500
