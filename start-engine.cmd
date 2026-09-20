@echo off
rem hentai-search local engine launcher (ASCII only on purpose: cmd.exe
rem mis-decodes non-ASCII bytes and can abort at parse time before "pause",
rem which is what made the old start-gateway.cmd window flash and vanish).
rem
rem Behaviour:
rem   engine OK      -> launcher closes itself after 3s (engine keeps running in its own window)
rem   -Status/-Stop  -> window stays open so you can read the output
rem   failure        -> window stays open so you can copy the error back
rem
rem Usage: double-click, or: start-engine.cmd -Status / -Stop / -Port 8899 / -Foreground / -KeepOpen
setlocal
cd /d "%~dp0"

set "PSEXE=powershell.exe"
where pwsh.exe >nul 2>nul && set "PSEXE=pwsh.exe"

echo [hentai-search] launcher starting ...
echo [hentai-search] script: "%~dp0tools\start-gateway.ps1"
echo.

"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-gateway.ps1" %*
set "RC=%ERRORLEVEL%"

if "%RC%"=="0" goto :autoclose

echo.
echo [hentai-search] launcher finished, exit code = %RC%
echo [hentai-search] something needs your attention above; copy it back if you need help.
echo.
pause
exit /b %RC%

:autoclose
echo.
echo [hentai-search] engine is up in its own window. Closing this launcher in 3s ...
timeout /t 3 /nobreak >nul 2>nul
exit /b 0
