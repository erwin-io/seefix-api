@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo node_modules not found. Running npm install...
  call npm install
  if errorlevel 1 exit /b 1
)
call npm run check
if errorlevel 1 exit /b 1
node server.js
