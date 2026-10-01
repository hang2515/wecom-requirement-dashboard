@echo off
setlocal
cd /d "%~dp0"

rem Clear only this dashboard process's stale environment proxy settings.
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "http_proxy="
set "https_proxy="
set "all_proxy="

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请安装后重新运行。
  pause
  exit /b 1
)

set "WECOM_AUTH_STATUS="
call :read_auth_status
if /I not "%WECOM_AUTH_STATUS%"=="authorized" (
  echo 企微 CLI 尚未授权，正在打开登录流程...
  wecom-cli auth init
  call :read_auth_status
)
if /I not "%WECOM_AUTH_STATUS%"=="authorized" (
  echo 企微 CLI 登录未完成，无法启动看板。
  pause
  exit /b 1
)

echo.
echo 企微 CLI 登录选择
echo   1. 重新登录企微 CLI
echo      联系人搜索失败，或网络/代理变更时请选择此项。
echo   2. 使用当前登录状态启动看板
choice /C 12 /N /M "请输入 1 或 2"
if errorlevel 2 goto wecom_ready
wecom-cli auth init
call :read_auth_status
if /I not "%WECOM_AUTH_STATUS%"=="authorized" (
  echo 企微 CLI 登录未完成，无法启动看板。
  pause
  exit /b 1
)
:wecom_ready

if not exist package.json (
  echo 当前目录未找到 package.json，无法启动看板。
  pause
  exit /b 1
)

echo 正在停止旧的需求看板进程...
powershell -NoProfile -Command "$ports = @(3210, 3211); $listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }; $processIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique); foreach ($processId in $processIds) { $process = Get-Process -Id $processId -ErrorAction SilentlyContinue; if ($null -eq $process) { continue }; if ($process.ProcessName -ne 'node') { Write-Error ('Port ' + ($listeners | Where-Object { $_.OwningProcess -eq $processId } | Select-Object -First 1 -ExpandProperty LocalPort) + ' is used by ' + $process.ProcessName); exit 1 }; Stop-Process -Id $processId -Force }"
if errorlevel 1 (
  echo 看板端口被非 Node 程序占用，已停止启动以避免误关其他程序。
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul

echo 正在后台启动需求看板，请稍候...
start "需求看板服务" /min node server.js
timeout /t 2 /nobreak >nul

curl.exe -s -o nul --max-time 3 http://127.0.0.1:3210/api/board
if not errorlevel 1 (
  echo 看板已启动，正在打开：http://127.0.0.1:3210/
  start "" http://127.0.0.1:3210/
  exit /b 0
)

curl.exe -s -o nul --max-time 3 http://127.0.0.1:3211/api/board
if not errorlevel 1 (
  echo 看板已启动，正在打开：http://127.0.0.1:3211/
  start "" http://127.0.0.1:3211/
  exit /b 0
)

echo 需求看板启动失败，请检查端口占用或 Node.js 错误。
pause
exit /b 1

:read_auth_status
set "WECOM_AUTH_STATUS="
for /f "usebackq delims=" %%A in (`wecom-cli auth show --status 2^>nul`) do set "WECOM_AUTH_STATUS=%%A"
exit /b
