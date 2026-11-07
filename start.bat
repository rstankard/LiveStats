@echo off
REM ---- espn-statcrew launcher (portable, no admin) ----
REM Put a portable Node here as .\node\node.exe, or have node on PATH.
setlocal
cd /d "%~dp0"
set PORT=8089
REM set EVENT_ID=401856686
REM set OUT_FILE=%~dp0game.xml
REM set AUTO=30   REM start in auto mode every N seconds (or pick a mode in the panel)

set NODE=node
if exist "%~dp0node\node.exe" set NODE="%~dp0node\node.exe"

start "" http://localhost:%PORT%
%NODE% "%~dp0server.js"
