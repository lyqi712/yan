@echo off
cd /d "%~dp0"
node src\server.js
exit /b %errorlevel%
