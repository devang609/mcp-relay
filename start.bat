@echo off
set "PATH=C:\node-v24.21.0-win-x64;%PATH%"
cd /d D:\embarko

echo Freeing ports 3000 and 5173...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5173 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1

echo Starting MCPRelay dev server...
node --version
npm run dev
pause
