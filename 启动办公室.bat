@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 已经在运行就直接开页面，不再重复起服务（避免 EADDRINUSE）
netstat -ano | findstr /R /C:":4517 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [Agent Office] 办公室已经在运行，直接打开页面...
  start "" http://127.0.0.1:4517/
  ping -n 2 127.0.0.1 >nul
  exit /b 0
)
echo [Agent Office] 正在启动协作办公室...
start "" cmd /c "ping -n 4 127.0.0.1 >nul & start "" http://127.0.0.1:4517/"
node apps\hub\dist\index.js
pause
