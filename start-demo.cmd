@echo off
cd /d "%~dp0"
start "Pixel server" node server.js
timeout /t 2 /nobreak >nul
start "" http://localhost:3000/
start "" http://localhost:3000/chaos
