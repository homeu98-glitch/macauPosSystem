# Macau POS Desktop Companion

桌面打印代理（見 [`docs/47-desktop-companion-spec.md`](../docs/47-desktop-companion-spec.md)）。喺 POS 終端機（Windows/macOS/Linux）跑，綁 **loopback（127.0.0.1 + ::1 雙棧）**，俾瀏覽器開嘅 POS 網頁經 localhost HTTP 交打印 job，由 OS 權限打到 LAN:9100。

普通用戶用法：**裝咗 `desktop-companion-setup.exe` 就完**，Companion 喺背景跑，狀態頁自動顯示連線狀態，按「一鍵開 POS 並自動配對」即自動寫入配對，全程唔使手動改設定。

## 三種跑法

| 場景 | 指令 | 說明 |
|---|---|---|
| 普通用戶（最終） | 裝 `desktop-companion-setup.exe` | Electron 包裝，視窗＋ tray，背景常駐 |
| 開發者 GUI | `npm install && npm start` | 跑 Electron（`electron .`），同安裝檔行為一樣 |
| 純 Node（CI/伺服器） | `npm install && npm run serve` | 只跑 HTTP 代理，無視窗（`node server.mjs`） |

> `npm start` 同 `serve` 嘅分別：前者有 GUI 狀態頁＋ tray；後者只係後台代理（俾你想用自己瀏覽器開 `http://127.0.0.1:9311/` 睇狀態）。

## 打包成安裝檔（exe / NSIS）

```bash
cd desktop-companion
npm install
npm run dist          # → electron-builder --win nsis
```

產出：`dist/desktop-companion-setup.exe`（NSIS 安裝檔，用家雙撃下一步就裝好，桌面＋開始選單捷徑）。
首次 build 會下載 Electron 二進制（幾十 MB），需要網絡；之後有 cache。

自定 icon：放 `electron/icon.png`（建議 256×256）即自動用。無 icon 會用 1×1 fallback（tray 圖示極細，功能正常）。

## 自動配對流程（零手動設定）

1. Companion 安裝後背景跑，綁 `127.0.0.1:9311`，並 serve 狀態頁 `http://127.0.0.1:9311/`。
2. POS 網頁（`pos-app` / salon `layout`）mount 嗰陣 call `tryAutoPairCompanion()`：
   - 若 URL 帶 `?companion=http://127.0.0.1:9311` → 直接寫入 localStorage（呢個係「一鍵開 POS 並自動配對」按鈕帶嘅參數）。
   - 否則 probe `http://127.0.0.1:9311/api/config`，連到就自動寫入 `companionUrl`。
3. dispatch 讀到 `macau-pos-companion-url` → `getCompanionTransport()` 有值 → 落單經 Companion 出單。
4. 狀態頁「一鍵開 POS 並自動配對」按鈕會喺預設瀏覽器開 `POS_URL/?companion=http://127.0.0.1:9311`（`POS_URL` 見 companion.config.json，預設 Vercel）。POS 載入即自動配對。

> 手動卡（設置頁「桌面 Companion 代理」）仍然喺，作為 fallback；正常唔使碰。

## 快速驗證（純 Node 模式）

```bash
npm run serve
curl http://127.0.0.1:9311/api/health          # → {"ok":true,"version":"0.1.0"}
curl http://127.0.0.1:9311/                      # → 狀態網頁 HTML
# 打一張 LAN 測試單（改 ipAddress）
curl -X POST http://127.0.0.1:9311/api/print -H 'Content-Type: application/json' -d '{
  "job": {"id":"test-1","orderNo":"A123","storeName":"示範店",
          "items":[{"name":"單號","note":"A123"},{"name":"奶茶","quantity":1},{"name":"應收總計","note":"28.0"}]},
  "printer": {"name":"收銀機","connectionType":"lan","ipAddress":"192.168.1.50","lanPort":9100,"charset":"gb18030"}
}'
```

## 配置（companion.config.json，可省）

```json
{ "port": 9311, "token": "", "posUrl": "https://macau-pos-system.vercel.app" }
```

- `token` 非空時，所有 `/api/print` 必須帶 `x-companion-token` 且匹配（見 docs/47 §3）。
- `posUrl`：「一鍵配對」按鈕開嘅 POS 網址；換咗自己部署網址就改呢度。

## 🔍 固定使用單一 IP（loopback）嘅評估

Companion 同 POS 之間固定用 **`127.0.0.1:9311`（loopback）**，呢個係有意設計，評估如下：

**✅ 正確 / 優點**
- **同機限定**：Companion 只喺跑 POS 嗰部機本機，網絡其他人連唔到 → 安全，唔使開防火牆、唔使 token 都相對安全。
- **離線可用**：loopback 永遠喺，就算店 WAN/LAN 斷咗，本機 POS↔Companion 照樣通（打印機要喺同 LAN 先打到）。
- **無 mixed-content 基本盤**：`127.0.0.1` 係瀏覽器認可嘅 secure context，HTTPS 嘅 POS 頁 `fetch` loopback HTTP 通常**唔會**被當 mixed content 擋（同 `localhost` 一樣）。

**⚠️ 潛在問題 / 限制**
1. **IPv4 / IPv6 mismatch（已處理）**：部分系統 `localhost` 會解析成 `::1`（IPv6），若 Companion 只綁 `127.0.0.1`（IPv4）就連唔到。→ 本實作已改**雙棧**同時綁 `127.0.0.1` + `::1`，避免呢個坑。
2. **只限同機**：POS 瀏覽器必須同 Companion 喺**同一部 PC**。如果你喺另一部機／手機開 POS，呢部機嘅 Companion 連唔到（by design；要跨機就係 Cloud Relay 職責，docs/46）。唔可以「固定一個區網 IP」嚟中央化，因為咁會暴露 Companion 畀成個 LAN + 要 token 防濫用。
3. **mixed-content 極端情形**：個別瀏覽器／嚴格企業政策仍可能擋 `https → http://127.0.0.1` 嘅 fetch。→ 避雷：用 POS localhost 開發版（`http://localhost:3000`），或將 Companion 改成 HTTPS（自簽 + 信任，較重）。絕大部分現代瀏覽器 OK。
4. **打印機 IP 固定**：上面講嘅係「POS↔Companion」單一 IP；**打印機本身**若靠 DHCP 攞 IP，IP 可能變 → 收銀機連唔到。→ 打印機建議喺 router 設 DHCP 保留 / 靜態 IP，或 Companion 未來加 mDNS 自發現（docs/47 P2.1）。
5. **單一端口衝突**：若 9311 被佔，`::1`/`127.0.0.1` 任一口 binding 會 skip（已 log 警告），但兩個 host 都佔就完全起唔到 → 改 `port` 或清佔用程式。

**結論**：固定 loopback 單一 IP 係桌面 Companion 嘅**正確選擇**，安全又離線可用；只要雙棧綁定（已做）＋接受「同機先得」嘅限制就得。唔建議改為區網固定 IP。

## 已實作 / 未實作

| 項目 | 狀態 |
|---|---|
| Electron 包裝 ＋ NSIS 安裝檔 ＋ tray ＋ 狀態頁 | ✅（本輪） |
| 雙棧 loopback（127.0.0.1 + ::1） | ✅（本輪，修 IPv4/IPv6 mismatch） |
| `GET /` 狀態網頁 ＋ `GET /api/config` 自動配對 | ✅（本輪） |
| POS 零手動配對（?companion= ＋ probe） | ✅（本輪，pos-app + salon layout） |
| localhost HTTP 服務 ＋ CORS ＋ token | ✅ |
| `GET /api/health` | ✅ |
| LAN 直打（TCP → IP:9100） | ✅ |
| LAN mDNS 自動發現（`GET /api/discover`，bonjour-service） | ✅（2026-08，docs/50 P1） |
| USB 傳輸（node-usb，VID/PID → bulk transfer） | ✅（2026-08，docs/50 P2；需 libusb 驅動） |
| 藍牙傳輸（Windows 虛擬 COM port，serialport） | ✅（2026-08，docs/50 P2；BT 名稱填 COM port） |
| 最小 ESC/POS renderer（init/文字/切紙/charset） | ✅（生產請替換成共用模組，docs/47 §4） |
| 共用 ESC/POS renderer 抽出 | ❌（docs/47 決策①） |
| 自動更新 / 開機自啟（安裝後可手動加捷徑去啟動資料夾） | ⚠️ 安裝檔有桌面捷徑；開機自啟要手動排程或 P2.4 |
| Printer Hub（Sunmi APK） | ❌ 已於 2026-08 移除（docs/50 P0），統一經 Companion / native bridge / relay |

## 安全

只綁 loopback（127.0.0.1 + ::1），網絡其他人連唔到；唔落 DB、唔寫盤（除 companion.config.json）；唔做互聯網暴露（跨網打印交 Cloud Relay，docs/46）。
