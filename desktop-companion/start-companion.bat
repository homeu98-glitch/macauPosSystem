@echo off
chcp 65001 >nul
REM ── Macau POS Desktop Companion 啟動器（Windows / Surface Pro）──
REM 雙撃此檔即可喺背景跑起 Companion 代理（綁 127.0.0.1:9311）。
REM 唔使任何打包／封裝，純 Node.js 直接跑 server.mjs。

where node >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 未偵測到 Node.js。請先裝 Node.js LTS（^>=18）：https://nodejs.org
  echo         裝完重開終端機再跑呢個 bat。
  pause
  exit /b 1
)

cd /d "%~dp0"
echo.
echo Macau POS Desktop Companion 啟動中...
echo 監聽 http://127.0.0.1:9311 （只綁本機，網絡其他人連唔到）
echo 關閉請直接關呢個視窗。
echo.

REM 首次／缺依賴時裝 iconv-lite（中文 charset 用；唔裝會 fallback utf-8）
if not exist node_modules (
  call npm install --no-audit --no-fund
) else (
  call npm install --no-audit --no-fund
)

node server.mjs
echo.
echo [已停止] 按任意鍵關閉。
pause
