#!/usr/bin/env bash
# 一鍵自簽設定（喺跑 bridge 嗰部機／手機 Termux 跑）
# 做三件事：1) 出自簽證書  2) 寫 .env  3) 印下一步
set -euo pipefail

# 去到 print-bridge 目錄（呢個 script 喺 scripts/ 入面）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

BRIDGE_IP="${BRIDGE_IP:-192.168.31.106}"
CERT_OUT_DIR="${CERT_OUT_DIR:-$HOME/print-bridge-certs}"

echo "▶ 出證書（IP = $BRIDGE_IP）..."
BRIDGE_IP="$BRIDGE_IP" CERT_OUT_DIR="$CERT_OUT_DIR" bash scripts/issue-selfsigned.sh

echo "▶ 寫 .env..."
cat > .env <<EOF
PRINT_BRIDGE_HOST=0.0.0.0
PRINT_BRIDGE_PORT=9222
PRINT_BRIDGE_TLS=1
PRINT_BRIDGE_TLS_CERT=$CERT_OUT_DIR/bridge-selfsigned.cer
PRINT_BRIDGE_TLS_KEY=$CERT_OUT_DIR/bridge-selfsigned.key
PRINT_BRIDGE_TLS_PORT=8443
PRINT_BRIDGE_ALSO_HTTP=0
EOF

echo ""
echo "✅ 完成！證書喺：$CERT_OUT_DIR/bridge-selfsigned.cer"
echo ""
echo "跟住做："
echo "  1) 起 bridge ： bash start.sh"
echo "  2) 將 $CERT_OUT_DIR/bridge-selfsigned.cer 抄去每部 POS 機，裝入『受信任根 CA』"
echo "  3) POS 設定 → 設備 → 橋接 URL 填  https://$BRIDGE_IP:8443"
