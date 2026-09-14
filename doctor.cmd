@echo off
chcp 65001 >nul
cd /d "%~dp0"
node src\cli.js doctor
exit /b %errorlevel%
