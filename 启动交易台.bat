@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ============================================================
rem  Nado 交易台 · Windows 一键启动
rem  双击本文件即可：开启 live 模式 -> 起本地服务 -> 自动开浏览器
rem  关闭窗口（或按 Ctrl+C）即停止服务
rem ============================================================

set "NADO_LIVE=1"
set "URL=http://127.0.0.1:18270/"

rem ---- 找 Node：优先用 PATH 里的 node，没有就退回默认安装位置 ----
where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE=C:\Program Files\nodejs\node.exe"
  ) else (
    echo [错误] 没有找到 Node.js，请先安装 Node 22 或更高版本：https://nodejs.org/
    pause
    exit /b 1
  )
) else (
  set "NODE=node"
)

rem ---- 依赖没装过时先装（首次运行会慢一些）----
if not exist "apps\console\node_modules\next" (
  echo [1/2] 首次运行，正在安装依赖（需要几分钟）...
  rem 优先用 pnpm，没有就用 Node 自带的 corepack（不需要单独装 pnpm）
  where pnpm >nul 2>nul
  if errorlevel 1 (
    where corepack >nul 2>nul
    if errorlevel 1 (
      echo [错误] 既没有 pnpm 也没有 corepack，请先安装 Node 22 或更高版本。
      pause
      exit /b 1
    )
    set "PNPM=corepack pnpm"
  ) else (
    set "PNPM=pnpm"
  )
  call %PNPM% install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请查看上面的报错。
    pause
    exit /b 1
  )
)

echo [2/2] 正在启动交易台（live 模式）...
echo.
echo   服务地址：%URL%
echo   提醒：钱包 / 分组 / 配对都存在「浏览器本地」，不同浏览器互不相通：
echo     - Trae 内置浏览器：原有钱包数据都在这里，日常操作请用它打开上面的地址
echo     - 外部浏览器（下面会自动打开一个）：全新的空环境，需单独导入钱包才会显示数据
echo.
echo   关闭本窗口即停止服务。
echo.

rem ---- 先预热页面（首次编译可能要 1 分钟），页面返回 200 后再开浏览器，避免看到空白等待 ----
start "" powershell -NoProfile -WindowStyle Hidden -Command "$u='http://127.0.0.1:18270/'; for($i=0;$i -lt 90;$i++){ try{ if((Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 120).StatusCode -eq 200){ Start-Process $u; break } }catch{}; Start-Sleep -Seconds 2 }"

rem ---- 在 apps\console 目录里跑 next dev（登录用的浏览器进程也依赖这个目录）----
cd /d "%~dp0apps\console"
"%NODE%" node_modules\next\dist\bin\next dev -H 127.0.0.1 -p 18270

rem 服务结束后停在这里，方便看到最后的报错
echo.
echo 服务已停止。
pause
