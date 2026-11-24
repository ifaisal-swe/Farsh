@echo off
title Forsah - connect live data
cd /d "%~dp0"
set C=docker compose -f docker-compose.yml -f docker-compose.local.yml
%C% exec app node scripts/services.js setup
if errorlevel 1 goto end
echo.
echo Restarting...
%C% restart app
echo.
echo Done. Sign in as the operator at http://localhost:8790
:end
pause
