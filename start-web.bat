@echo off
rem One-click launcher for the DeepSeek Harness Web UI (called by the desktop shortcut).
setlocal
cd /d "%~dp0"

rem 1. Install dependencies on first run.
if not exist "node_modules" (
    echo [1/3] Installing dependencies via pnpm...
    call pnpm install
    if errorlevel 1 goto :error
)

rem 2. Build once when the frontend dist is missing (dsh web needs apps\web\dist\index.html).
if not exist "apps\web\dist\index.html" (
    echo [2/3] Building project...
    call pnpm run build
    if errorlevel 1 goto :error
)

rem 3. Start the Web UI (long-running server; keep the window open).
echo [3/3] Starting DeepSeek Harness Web UI at http://127.0.0.1:3080 ...
call pnpm dsh web
goto :eof

:error
echo.
echo Launch failed. Check the error above.
pause
exit /b 1
