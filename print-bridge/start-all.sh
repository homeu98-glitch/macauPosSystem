#!/usr/bin/env bash
# on-prem 一鍵：同部機起 print-bridge（HTTP :9222）+ POS app 靜態伺服器（:3000）
# 用家（店主）日常：開咗呢個 script 就唔使理，零證書零 DNS。
set -a
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$SCRIPT_DIR/.env" ] && . "$SCRIPT_DIR/.env"
set +a

# on-prem 用本地 HTTP，唔使 TLS（mixed content 只發生喺 HTTPS 網頁，本地 HTTP app 唔會中招）
export PRINT_BRIDGE_TLS=0

echo "[on-prem] 起 print-bridge (HTTP :9222) ..."
node "$SCRIPT_DIR/src/server.mjs" &
BRIDGE_PID=$!

echo "[on-prem] 起 POS app 靜態伺服器 (:3000) ..."
node "$SCRIPT_DIR/app-server.mjs" &
APP_PID=$!

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "[on-prem] bridge pid=$BRIDGE_PID  app pid=$APP_PID"
echo "[on-prem] Sunmi / 平板開瀏覽器去： http://${LAN_IP:-192.168.31.106}:3000"
echo "[on-prem] 按 Ctrl+C 停止；日常靠 termux-boot 自動起。"
wait
