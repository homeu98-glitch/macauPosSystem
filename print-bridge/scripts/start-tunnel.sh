#!/usr/bin/env bash
# ============================================================================
# Cloudflare Tunnel（Path X）一鍵起動 — 喺 bridge 手機（Android Termux）跑
# ----------------------------------------------------------------------------
# 做咗兩件事：
#   1) 起 print-bridge（本地 HTTP :9222，TLS 由 cloudflared 幫手終止，所以唔使開）
#   2) 用 cloudflared 將 http://localhost:9222 暴露成公眾信任嘅
#      https://<random>.trycloudflare.com（唔使 domain、唔使 DNS、唔使證書）
#
# 店主日常：開咗呢個 script 就唔使理；POS 喺 Vercel 照樣用，斷線靠 offline mode 照開單。
# 想自動開機就配合 Termux:Boot（見 docs/35）。
# ============================================================================

set -a
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$SCRIPT_DIR/.env" ] && . "$SCRIPT_DIR/.env"
set +a

# bridge 用本地 HTTP，TLS 一定 0（cloudflared 喺雲端終止 HTTPS）
export PRINT_BRIDGE_TLS=0
PORT="${PRINT_BRIDGE_PORT:-9222}"

# 模式：quick（試用，唔使 domain）| named（穩定 URL，需要 domain + cloudflared login）
MODE="${PRINT_BRIDGE_TUNNEL_MODE:-quick}"

# ---- 1. 檢查 cloudflared ----
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[tunnel] 搵唔到 cloudflared，請先安裝（見 docs/35-cloudflare-tunnel-print-bridge.md）："
  echo "           wget https://github.com/igrek51/cloudflared-termux/releases/latest/download/cloudflared -O cloudflared"
  echo "           chmod +x cloudflared && install cloudflared \$PREFIX/bin/"
  exit 1
fi

# ---- 2. 起 print-bridge（背景） ----
echo "[tunnel] 起 print-bridge (HTTP :$PORT) ..."
node "$SCRIPT_DIR/src/server.mjs" &
BRIDGE_PID=$!

# 等到 bridge /health ready
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "[tunnel] bridge ready (http://127.0.0.1:$PORT)"
    break
  fi
  sleep 0.5
done

# 防止 Android 休眠斷線（Termux 有 wake-lock 就用）
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock 2>/dev/null

# ---- 3. 起 cloudflared ----
LOG="$SCRIPT_DIR/.tunnel.log"
: > "$LOG"

if [ "$MODE" = "named" ]; then
  TUNNEL_NAME="${PRINT_BRIDGE_TUNNEL_NAME:-macau-pos-bridge}"
  echo "[tunnel] 起 named tunnel '$TUNNEL_NAME' → http://localhost:$PORT（需先 cloudflared login）"
  cloudflared tunnel --url "http://localhost:$PORT" "$TUNNEL_NAME" 2>&1 | tee "$LOG" &
else
  echo "[tunnel] 起 quick tunnel → http://localhost:$PORT（唔使 domain，URL 每次重開都變）"
  cloudflared tunnel --url "http://localhost:$PORT" 2>&1 | tee "$LOG" &
fi
CLOUDFLARED_PID=$!

# ---- 4. 等 URL 出現，寫入檔案方便複製 ----
URL=""
for i in $(seq 1 40); do
  URL=$(grep -oE 'https://[a-z0-9.-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1)
  [ -n "$URL" ] && break
  sleep 1
done

echo ""
if [ -n "$URL" ]; then
  echo "=================================================================="
  echo " bridge 公眾 URL（複製落 POS 設定 → 橋接 URL）："
  echo "   $URL"
  echo "=================================================================="
  echo "$URL" > "$SCRIPT_DIR/.tunnel-url.txt"
  echo "[tunnel] 已寫入 $SCRIPT_DIR/.tunnel-url.txt"
else
  echo "[tunnel] 等唔到 URL，請檢查網絡同 cloudflared 版本（見 docs/35 FAQ）。"
fi
echo "[tunnel] 按 Ctrl+C 停止；日常靠 Termux:Boot 自動起。bridge pid=$BRIDGE_PID tunnel pid=$CLOUDFLARED_PID"

wait
