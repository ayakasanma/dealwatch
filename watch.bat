@echo off
chcp 65001 >nul
cd /d "%~dp0"
node dealwatch.mjs watch %*
pause
