@echo off
chcp 65001 >nul
REM ── Macau POS Desktop 打包器（Windows / Surface Pro）──
REM 雙撃此檔：build 全屏收銀版 exe → 同步去 public/releases/ → 提示 git push。
REM 用 cmd 跑（避開 PowerShell 執行政策擋 npm.ps1）。

where node >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 未偵測到 Node.js。請先裝 Node.js LTS（^>=18）：https://nodejs.org
  echo         裝完重開終端機再跑呢個 bat。
  pause
  exit /b 1
)

cd /d "%~dp0"
echo.
echo ========================================
echo  Macau POS Desktop —— 全屏收銀版打包
echo ========================================
echo.

REM 1) 裝依賴（electron + electron-builder + iconv-lite）
echo [1/4] 檢查並安裝依賴...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [失敗] npm install 出錯，請檢查網絡。
  pause
  exit /b 1
)

REM 2) bump 版本 + build NSIS + 同步去 ../public/releases/
REM    --patch 自動 +0.0.1；想 major/minor 改 --minor / --major
echo [2/4] 打包 NSIS 安裝檔 + 更新 manifest...
call npm run release -- --patch
if errorlevel 1 (
  echo [失敗] release script 出錯。
  pause
  exit /b 1
)

REM 3) 提示 commit + push（Vercel 部署 /releases/）
echo [3/4] 發佈產物已喺 ..\public\releases\
echo.
echo   下一步要你自己做（bat 唔能 git push，要你授權）：
echo.
echo   cd ..
echo   git add public/releases/ desktop-companion/package.json
echo   git commit -m "release: desktop (fullscreen kiosk)"
echo   git push
echo.
echo   push 完 Vercel 自動部署 → 用家 APP 內「檢查更新」拉到全屏版。
echo.

REM 4) 打開 dist 目錄方便你拎 exe 手動發
echo [4/4] 開啟 dist 目錄（exe 喺呢度）...
explorer "%~dp0dist" 2>nul

echo.
echo 完成。按任意鍵關閉。
pause
