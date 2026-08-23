# 47 · 桌面 Companion 代理（Phase 2）規格

> 配套文檔：`docs/43`（雙路徑總架構）、`docs/44`（打包可行性）、`docs/45`（APK 團隊需求）、`docs/46`（雲端 Relay 備援）。
> 代碼骨架：`desktop-companion/server.mjs`（最小可跑）、`src/lib/print-bridge/companion-transport.ts`（網頁側 transport）、`src/lib/print-bridge/companion-config.ts`（配置讀取）。

---

## 0. 一句話定位

**桌面 Companion = 喺 Windows / macOS / Linux POS 終端機上跑、綁 `127.0.0.1` 嘅常駐代理**。瀏覽器開嘅 POS 網頁（https://macau-pos-system.vercel.app）因為沙盒限制打唔到 LAN:9100 / USB / BT，就經 `localhost` HTTP 將 job 交俾 Companion，由佢用 OS 權限出單。

佢就係**桌面版嘅 `PosNative`**：
| 平台 | web↔native 橋 | 做法 |
|---|---|---|
| Android（Sunmi APK） | `PosNative.printJob(json)` | in-WebView Kotlin bridge |
| 桌面（瀏覽器開 POS） | `POST http://127.0.0.1:9311/api/print` | 常駐 localhost HTTP agent |

兩者 **payload 完全一樣**（`{job, printer, kind, storeName, paymentMethod, total}`），ESC/POS 渲染邏輯亦應共用（見 §4）。

---

## 1. 為咩需要（問題）

瀏覽器 / WebView 沙盒：
- ❌ 打唔開 raw TCP socket 去 `IP:9100`（ESC/POS 直打）
- ❌ 直接 access USB（`navigator.usb` 喺大多數桌面瀏覽器受限 / 要權限 / 唔穩定）
- ❌ 直接 access 藍牙（`navigator.bluetooth` 僅 Chromium、且 macOS 限制多）
- ❌ mixed content：HTTPS 頁面打開遠端 HTTP（非 localhost）會被瀏覽器擋

**localhost 係例外**：`https://...` 頁面 `fetch('http://127.0.0.1:9311/...')` **唔會**當 mixed content，亦唔使 TLS —— 呢個係「web → HTTP → 打印」唯一乾淨嘅做法（取代舊嘅 beacon hack，見 doc 41 問題③）。

所以桌面方案：喺終端機自己跑一個 localhost agent，網頁經佢出單。

---

## 2. 協議合約（與 native bridge 一致）

### 2.1 請求（網頁 → Companion）

```
POST http://127.0.0.1:9311/api/print
Content-Type: application/json
x-companion-token: <可選，設置頁配對時寫入>
```

Body（JSON）：
```json
{
  "job": { /* PrintJob：id, orderNo, tableName, orderId, printerGroup, ticketType, items[], createdAt, storeId?, ttl? */ },
  "printer": {
    "id": "printer-xxx",
    "name": "收銀機",
    "connectionType": "lan" | "usb" | "bluetooth",
    "ipAddress": "192.168.1.50",          // lan 用
    "lanPort": 9100,                       // lan 用，預設 9100
    "usbVendorId": "0x0416",               // usb 用
    "usbProductId": "0x5011",              // usb 用
    "bluetoothAddress": "AA:BB:CC:DD:EE:FF", // bt 用
    "bluetoothName": "XP-58",              // bt 用
    "paperSize": "80mm",
    "charset": "gb18030"                   // gb18030 / gbk / big5 / utf-8
  },
  "kind": "receipt" | "kitchen",
  "storeName": "示範美容院",
  "paymentMethod": "cash",
  "total": 128.0
}
```

### 2.2 回應（Companion → 網頁）

```json
{ "ok": true,  "queued": false }
{ "ok": false, "error": "打印機連線失敗：ETIMEDOUT 192.168.1.50:9100" }
```

- `queued: true` 表示 Companion 接受了但排隊異步出單（生產級可加，骨架暫唔用）。
- 與 `native.ts` 嘅 `window.__posNativePrintResult` 回調語義一致（`ok` / `error`），網頁側 `CompanionTransport` 直接當同步結果用。

### 2.3 健康檢查

```
GET http://127.0.0.1:9311/api/health  →  { "ok": true, "version": "0.1.0" }
```

網頁 `isCompanionConfigured()` 之外，可加 `fetchHealth()` 探活（見 companion-config.ts 擴展位）。

---

## 3. 安全模型（重要）

1. **只綁 `127.0.0.1`**（loopback）—— 拒絕任何來自網絡嘅請求，只有本機瀏覽器 / 本機進程能打到。`net.createServer().listen(9311, '127.0.0.1')`。
2. **可選 token**：設置頁配對 Companion 時生成並雙向寫入（網頁 `localStorage` + Companion 配置檔）。若 Companion 設咗 token，所有 `/api/print` 必須帶 `x-companion-token` 且匹配，否則 `401`。
3. **CORS**：回應 reflect 請求 `Origin`（或 `*`，因為 loopback 已限定）＋ `Access-Control-Allow-Methods: POST, GET` ＋ `Access-Control-Allow-Headers: Content-Type, x-companion-token`，令跨域 fetch 成功。
4. **唔落 DB、唔寫盤**（除咗配置檔）—— job 即收即打即棄，唔留痕跡。
5. **唔做互聯網暴露**：Companion 永遠 localhost；跨網打印交畀 doc 46 嘅 Cloud Relay，唔好喺呢度開 port forwarding。

---

## 4. ESC/POS 渲染策略（DRY）

生產級建議：**把現有網頁 `EscPosRenderer` 抽成一份平台無關嘅純函數模組**（輸入 `PrintJob + DevicePrinterConfig` → 輸出 `Uint8Array`），咁樣：
- Android APK 經 `PosNative` 收結構化 job、自己 render（已係咁）
- 桌面 Companion 收結構化 job、用同一份 render 出 `Buffer`
- 保證兩邊出單格式 100% 一致

骨架 `server.mjs` 內含一個**最小 ESC/POS renderer**（init + 文字行 + 分隔線 + 切紙 + charset 經 `iconv-lite` 編碼），夠跑基本收據；生產請替換成共用模組。

**charset**：`printer.charset` 決定 `iconv-lite` 編碼（gb18030/gbk/big5/utf-8）；中文機多數收 GBK/GB18030 raw bytes。生產級要同 WebView 側用同一套 codepage 指令（`ESC t n`）。

---

## 5. 各 OS 傳輸實作

Companion 統一收 `connectionType`，再分派：

| connectionType | Windows | macOS | Linux |
|---|---|---|---|
| `lan` | `net.Socket` → `IP:9100` | 同左 | 同左 |
| `usb` | `node-usb`（libusb）＋ 廠商驅動；需 `winusb` / Zadig 替換驅動 | `node-usb`＋權限（`/dev/bus/usb` udev rule） | `node-usb`＋udev rule |
| `bluetooth` | Winsock RFCOMM / 廠商 SDK（複雜） | `IOBluetooth` / `node-ble` | `bluez` RFCOMM / `node-ble` |

- **LAN 最穩**：三平台都用 Node `net`，骨架已實作。
- **USB**：`node-usb` 跨平台但每機要裝驅動＋權限，維運重；優先推 LAN。
- **BT**：桌面 BT 比 Android 難（macOS 限制多），除非強需求否則唔推。

---

## 6. 打包與常駐（交桌面團隊）

Companion 要「開機自啟、常駐、自動更新、托盤圖示」：

| 手段 | 說明 | 注意 |
|---|---|---|
| **方式 A：Electron / Tauri 單體 App** | 包埋 Chromium / WebView，連 POS 網頁 + agent 一齊；用家開 App 就同時有 POS 同打印 agent | 最簡單一致，但 Electron 體積大 |
| **方式 B：後台 service（Node）+ 獨立 POS 瀏覽器** | `server.mjs` 註冊成 Windows Service / macOS launchd / Linux systemd，POS 照用瀏覽器開 | 輕，但要處理 service 安裝／權限／自啟 |
| **自動更新** | electron-updater（A）/ 自寫檢查（B） | 打印 agent 要靜默升級，唔好彈窗打斷營業 |
| **Authenticode / 公證** | Windows 要 SignTool 簽名；macOS 要 Apple 公證（否則 Gatekeeper 擋） | 見 doc 44 §2 |

**最小起步（骨架）**：直接用 `node desktop-companion/server.mjs`（唔使打包），驗證 localhost 打印鏈；打包留生產級再做。

---

## 7. 與舊 Hub 嘅關係

- 舊 Hub = 一檯**獨立常駐機**做 LAN 直打（要第二部機）。
- Companion = **喺 POS 終端機自己跑**嘅 localhost agent（唔使第二部機）。
- 架構上 Companion **取代** Hub 嘅「第二部機」角色；`dispatch.ts` 優先級 native → **companion** → hub → relay，保留 Hub 只為舊部署兼容。

---

## 8. 分階段

- **P2.0（骨架，已完成）**：`server.mjs` localhost HTTP ＋ LAN TCP 出單 ＋ 最小 ESC/POS ＋ token/CORS ＋ health。網頁側 `companion-transport.ts` / `companion-config.ts` ＋ `dispatch.ts` 接駁。
- **P2.1（已於 2026-08 完成，見 doc 50）**：LAN mDNS 自動發現——`companion-server.mjs` 加 `bonjour` 掃描 ＋ `GET /api/discover`；網頁「掃描 LAN」按鈕自動填 IP。
- **P2.2（已於 2026-08 完成，見 doc 50）**：USB 傳輸——`companion-server.mjs` `printUsb()` 經 `usb` 套件 `findByIds(vid,pid)` → `transfer(buf)`；`package.json` 加 `usb` dependency。
- **P2.3（已於 2026-08 完成，見 doc 50）**：BT 傳輸——`companion-server.mjs` `printBluetooth()` 經 `serialport` 打 Windows 配對後虛擬 COM port（填落 `bluetoothName`）；`package.json` 加 `serialport` dependency。
- **P2.4（已於 2026-08 完成，見 doc 48）**：打包成 Electron ＋ NSIS 安裝檔 ＋ tray ＋ 自動更新（electron-updater）；簽名公證待做（SmartScreen 警告）。
- **P2.5（已於 2026-08 完成）**：設置頁「桌面 Companion 代理」UI（填 URL/token、探活、測試打印）+ QR 掃描配對。

---

## 9. 待決策

1. **共用 renderer 抽到邊**：提議 `src/lib/print-bridge/escpos-renderer.ts`（純 TS，輸出 `Uint8Array`），Android 與 Companion 都引用。
2. **Companion 默認 port**：建議 `9311`（避免同 Hub `9191` 撞）；可配置。
3. **多打印機並發**：骨架串行，生產要 queue（避免同一端口並發寫）。

---

## 10. 驗收清單（生產級）

- [ ] `POST /api/print` 收結構化 payload，LAN 機實體出單，內容同 WebView 側一致。
- [ ] 只綁 `127.0.0.1`，外部 IP 訪問被拒（`curl 192.168.x.x:9311` 應連唔到）。
- [ ] token 啟用時，錯 token / 無 token → `401`。
- [ ] CORS 令 https POS 頁面 fetch 成功（無 mixed content / CORS 報錯）。
- [ ] `GET /api/health` 回 `{ok:true}`。
- [ ] USB / BT（若實作）按 `connectionType` 分派，唔支援時回清晰錯誤唔靜默。
- [ ] 崩潰自動重啟（service / Electron 守護）。
