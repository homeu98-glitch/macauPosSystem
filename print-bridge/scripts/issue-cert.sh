#!/usr/bin/env bash
# 用 acme.sh + DNS-01 發 Let's Encrypt 證書俾 bridge。
# DNS-01 唔需要 bridge 對外開 80 port，適合 LAN 內部機。
#
# 前置：
#   1) 你 own 一個 domain（例 bridge.yourdomain.com），DNS 交畀下面嘅提供商管。
#   2) 裝 acme.sh：  curl https://get.acme.sh | sh
#   3) 按你嘅 DNS 提供商設定對應 API token（以下以 Cloudflare 為例）。
#
# 其他提供商見： https://github.com/acmesh-official/acme.sh/wiki/dnsapi
#   Cloudflare -> CF_Token / CF_Account_ID
#   Aliyun     -> Ali_Key / Ali_Secret
#   Tencent    -> DP_Id / DP_Key
#   GoDaddy    -> GD_Key / GD_Secret
set -euo pipefail

DOMAIN="${BRIDGE_DOMAIN:-bridge.yourdomain.com}"
OUT_DIR="${CERT_OUT_DIR:-/etc/print-bridge}"

mkdir -p "$OUT_DIR"

# ↓↓↓ 按你嘅 DNS 提供商填（示例：Cloudflare）↓↓↓
export CF_Token="${CF_Token:-}"
export CF_Account_ID="${CF_Account_ID:-}"
# ↑↑↑ 改上方為你實際嘅提供商變數 ↑↑↑

~/.acme.sh/acme.sh --issue --dns dns_cf -d "$DOMAIN" \
  --cert-file      "$OUT_DIR/$DOMAIN.cer" \
  --key-file       "$OUT_DIR/$DOMAIN.key" \
  --fullchain-file "$OUT_DIR/$DOMAIN.fullchain.cer" \
  --reloadcmd     "echo '[bridge] cert renewed for $DOMAIN'"

echo ""
echo "證書已發出到 $OUT_DIR/"
echo "請將 .env 嘅 PRINT_BRIDGE_TLS_CERT 指去 $OUT_DIR/$DOMAIN.fullchain.cer"
echo "PRINT_BRIDGE_TLS_KEY 指去 $OUT_DIR/$DOMAIN.key，然後重啟 bridge。"
echo ""
echo "續期（acme.sh 安裝時已加咗 cron，一般唔使手動）："
echo "  ~/.acme.sh/acme.sh --renew -d $DOMAIN"
