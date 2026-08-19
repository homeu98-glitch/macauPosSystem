#!/usr/bin/env bash
# 載入同目錄嘅 .env 再起 bridge（跨平台：Termux / Linux / macOS）
set -a
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$SCRIPT_DIR/.env" ] && . "$SCRIPT_DIR/.env"
set +a
exec node "$SCRIPT_DIR/src/server.mjs"
