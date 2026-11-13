@echo off
cd /d "%~dp0"
where npm >nul 2>&1
if errorlevel 1 (
  echo 先安装 Node.js：https://nodejs.org
  pause
  exit /b 1
)
node scripts\check-node.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
rem A room already running here: open it, don't start a second one.
rem 4399 is fixed: every client's MCP bridge talks to it.
curl -sf --max-time 2 http://127.0.0.1:4399/api/v1/user 2>nul | find /i "name" >nul 2>&1
if not errorlevel 1 (
  echo 房间已经在运行，直接打开，不再启动第二个。
  node scripts\open-room.mjs
  exit /b 0
)
curl -s -o nul --max-time 2 http://127.0.0.1:4399/ >nul 2>&1
if not errorlevel 1 (
  echo 4399 端口被别的程序占着，不是并坐。先关掉它再双击 start.bat。
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
