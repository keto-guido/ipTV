@echo off
title McKinley Screen
curl.exe -sS -X POST "http://127.0.0.1:8090/tv/api/screen/stop" -H "Content-Type: application/json" -d "{}"
if errorlevel 1 echo Server unavailable or request failed.
echo.
pause
