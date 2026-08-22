# Macau POS Desktop Companion

桌面打印代理（見 [`docs/47-desktop-companion-spec.md`](../docs/47-desktop-companion-spec.md)）。喺 POS 終端機（Windows/macOS/Linux）跑，綁 `127.0.0.1`，俾瀏覽器開嘅 POS 網頁經 localhost HTTP 交打印 job，由 OS 權限出單。

## 快速跑（驗證鏈）

```bash
cd desktop-companion
npm install        # 裝 iconv-lite（唔裝都跑得，會 fallback utf-8）
node server.mjs
```

開兩個終端：

```bash
# 1) 探活
curl http://127.0.0.1:9311/api/health
# → {"ok":true,"version":"0.1.0"}

# 2) 打一張 LAN 測試單（改 ipAddress）
curl -X POST http://127.0.0.1:9311/api/print \
  -H 'Content-Type: application/json' \
  -d '{
    "job": {
      "id":"test-1","orderNo":"A123","storeName":"示範店",
      "items":[{"name":"單號","note":"A123"},{"name":"奶茶","quantity":1},{"name":"應收總計","note":"28.0"}]
    },
    "printer": {"name":"收銀機","connectionType":"lan","ipAddress":"192.168.1.50","lanPort":9100,"charset":"gb18030"}
  }'
# → {"ok":true}
```

## 配置（companion.config.json，可省）

```json
{ "port": 9311, "binding": "127.0.0.1", "token": "" }
```

- `token` 非空時，所有 `/api/print` 必須帶 `x-companion-token` 且匹配（見 docs/47 §3）。
- 設置頁「配對 Companion」會生成 token 並雙向寫入（網頁 localStorage ＋ 呢個檔）。

## 已實作 / 未實作

| 項目 | 狀態 |
|---|---|
| localhost HTTP 服務 ＋ CORS ＋ token | ✅ 骨架 |
| `GET /api/health` | ✅ |
| LAN 直打（TCP → IP:9100） | ✅ |
| 最小 ESC/POS renderer（init/文字/切紙/charset） | ✅（生產請替換成共用模組，docs/47 §4） |
| USB 傳輸（node-usb） | ❌ stub（docs/47 P2.2） |
| 藍牙傳輸 | ❌ stub（docs/47 P2.3） |
| 打包成 App / 後台 service / 自啟 / 自動更新 | ❌（docs/47 §6） |

## 安全

只綁 `127.0.0.1`，拒絕網絡訪問；唔落 DB、唔寫盤（除配置檔）；唔做互聯網暴露（跨網打印交 Cloud Relay，docs/46）。
