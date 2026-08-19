#!/usr/bin/env bash
# 自簽證書（無 domain 方案 / Path ② 方案 B）：
# 對住 bridge 嘅 LAN IP 出一份自簽證書，POS 填 https://<IP>:8443，
# 但每部 POS 機要將 .cer 裝入「受信任根 CA」先會信任呢個 HTTPS 連線。
#
# 前置：
#   - openssl 已裝（Termux: pkg install openssl；macOS/Linux 通常內建；Windows 用 Git Bash/WSL）
#   - bridge 部機建議設 DHCP 固定 IP，否則 IP 一變證書 SAN 就唔 match
#   - 需要 openssl >= 1.1.1（支援 -addext）；Termux / 現代系統都夠
set -euo pipefail

IP="${BRIDGE_IP:-192.168.31.106}"
OUT_DIR="${CERT_OUT_DIR:-$HOME/print-bridge-certs}"
DAYS="${CERT_DAYS:-825}"

mkdir -p "$OUT_DIR"

KEY="$OUT_DIR/bridge-selfsigned.key"
CER="$OUT_DIR/bridge-selfsigned.cer"

if [ -f "$CER" ]; then
  echo "證書已存在：$CER"
  echo "要重出就 rm 咗佢再跑：rm '$CER' '$KEY'"
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY" -out "$CER" -days "$DAYS" \
  -subj "/CN=macau-pos-print-bridge" \
  -addext "subjectAltName=IP:$IP"

echo ""
echo "✅ 自簽證書已生成"
echo "  cert : $CER"
echo "  key  : $KEY"
echo ""
echo "下一步："
echo "  1) .env 設 PRINT_BRIDGE_TLS=1 + 指去上面 cert/key 路徑（見 docs/33 方案 B）"
echo "  2) bash start.sh 起 bridge"
echo "  3) 將 $CER 抄去每部 POS 機，裝入『受信任根 CA』（見 docs/33 方案 B Step B4）"
echo "  4) POS 橋接 URL 填 https://$IP:8443"
