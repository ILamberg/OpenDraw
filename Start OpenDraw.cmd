@echo off
setlocal
cd /d "%~dp0"
echo Starting private OpenDraw phone companion...
echo.
powershell -NoProfile -File ".\scripts\start.ps1" -Remote
set "OPENDRAW_EXIT=%ERRORLEVEL%"
echo.
if not "%OPENDRAW_EXIT%"=="0" (
  echo OpenDraw stopped with an error. Press any key to close this window.
  pause >nul
)
exit /b %OPENDRAW_EXIT%
