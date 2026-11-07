@echo off
REM ---- espn-statcrew launcher (portable, no admin) ----
REM Settings now live in the control panel (gear button, top right) and are
REM saved to settings.json next to this file. Nothing here needs editing.
REM
REM Advanced: any line below, uncommented, overrides the Settings window.
REM set PORT=8089
REM set OUT_FILE=D:\Data\Football\livestats.xml
REM set EVENT_ID=401856686
REM set AUTO=30
setlocal
cd /d "%~dp0"

set NODE=node
if exist "%~dp0node\node.exe" set NODE="%~dp0node\node.exe"

%NODE% "%~dp0server.js"
if errorlevel 1 pause
