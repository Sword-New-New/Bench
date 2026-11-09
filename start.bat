@echo off
cd /d "%~dp0"
where npm >nul 2>&1
if errorlevel 1 (
  echo 先安装 Node.js：https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo 房间地址 http://127.0.0.1:4399（用带口令的链接打开）
start "" /b cmd /c "timeout /t 4 /nobreak >nul & node scripts\open-room.mjs"
call npx next dev -p 4399 -H 127.0.0.1
