@echo off
rem Starts the Remote Play host. Put a shortcut to this file in shell:startup
rem to have it run every time you log in.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install || pause
)
call npm start
