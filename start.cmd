@echo off
set "N=C:\Users\Windows_10\AppData\Local\node20\node-v20.19.0-win-x64"
set "PATH=%N%;%PATH%"
cd /d D:\embarko
echo Starting MCPRelay dev server with Node 20...
"%N%\node.exe" --version
"%N%\npm.cmd" run dev
