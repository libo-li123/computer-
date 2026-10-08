@echo off
rem Restart the PC Observer: stop the process listening on port 5173, then launch it again.
setlocal
set PORT_NUMBER=5173
for /f "tokens=5" %%p in ('netstat -ano -p TCP ^| findstr /c:":%PORT_NUMBER% " ^| findstr /i "LISTENING"') do (
  taskkill /f /pid %%p >nul 2>&1
)
timeout /t 1 /nobreak >nul
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0launcher.ps1"
exit /b 0
