@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 goto missing_node
node -e "if(Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 goto missing_node
call npm ci --ignore-scripts --no-fund
if errorlevel 1 exit /b 1
echo 眼：基础依赖安装完成。下面进入首次设置；已经完成初始化的可以跳过打开界面。
node src\cli.js setup
if errorlevel 1 (pause & exit /b 1)
echo 如需稍后初始化，可再次双击 setup.cmd。接入AI：运行 npm run config:mcp。
pause
exit /b 0
:missing_node
echo 眼需要 Node.js 22 或更高版本。请安装后重新运行本文件。
pause
exit /b 1
