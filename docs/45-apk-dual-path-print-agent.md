# 45. APK 跨平台雙路徑打印 — 新增功能需求書（Terminal Local Agent）

> **目的**：呢份係交畀 **APK 開發團隊**（Sunmi / 跨平台 Native App）嘅新增功能需求書。
> 喺 [`docs/37-apk-native-bridge-print-format.md`](./37-apk-native-bridge-print-format.md)（打印格式適配）嘅基礎上，
> 加多一層 **跨平台雙路徑** 能力：① LAN 區域網路直打；② LAN 唔到時自動 fallback 經 Internet（Cloud Print Relay）出單。
> 同時擴充 `connectionType` 到 `lan | usb | bluetooth`，並定義可靠嘅非同步結果回調。
>
> POS 網頁端（本 repo）已經喺 **Phase 0** 擴好統一合約（見 `src/lib/types.ts` + `src/lib/print-bridge/native.ts`），
> 等 APK 對齊。設計藍圖見 [`docs/43-cross-platform-print-dual-path.md`](./43-cross-platform-print-dual-path.md)，
> 打包可行性見 [`docs/44-packaging-feasibility.md`](./44-packaging-feasibility.md)。

---

## 0. 背景：兩層「bridge」要先分清

好多誤會來自「bridge」一字兩義，先講清楚：

| 層 | 係乜 | 必需？ | 由邊個做 |
|---|---|---|---|
| **A. 裝置層中介（第二台常開機）** | 舊方案：店內第二台機做 Hub，轉發打印 | ❌ 已棄用（LAN 直打唔使） | — |
| **B. App 內 web↔native 通訊 bridge** | `window.PosNative.printJob(json)` / `window.__posNativePrintResult` | ✅ **三個平台全部必需** | APK / desktop companion / iOS App |

本需求書講嘅 **Terminal Local Agent = 你哋做嘅 App 本身**（Sunmi APK / Windows exe / iOS App）。
佢自己就係「local agent」，**唔使再裝第二台機**做 LAN 直打。第二台常開機（Stationary Agent）只係 **雙路徑 fallback（relay）** 場景先需要，詳見 §4。

---

## 1. 現狀問題（點解要新功能）

| # | 問題 | 影響 |
|---|---|---|
| 1 | `connectionType` 只有 `"lan"` | USB / Bluetooth 打印機完全冇得接（Sunmi 外置 USB 機、藍牙便攜機都唔到） |
| 2 | `PosNative.printJob` 同步回 `{ok,queued}` 就算「成功」 | 物理出單失敗（紙盡 / 斷線 / 卡紙）POS 唔知，單據會「以為印咗」 |
| 3 | 冇 `storeId` / `ttl` | 將來 LAN 唔到要經 relay 出單時，冇法路由到正確店、冇法丟棄過期 job |
| 4 | LAN 唔到就冇 fallback | 平板去咗另一個 WiFi / 4G 底下，成間店印唔到單 |

---

## 2. 新增功能清單（按優先級）

### P0 · 阻擋性（呢版必須做）

#### 2.1 `connectionType` 擴充：`lan | usb | bluetooth`
Payload `printer.connectionType` 而家可以係三個值之一。APK 按值行唔同 transport：

| `connectionType` | APK 實作 | 關鍵參數（嚟自 payload `printer`） |
|---|---|---|
| `"lan"` | raw socket TCP → `ipAddress:lanPort`（預設 `9100`）ESC/POS | `ipAddress`, `lanPort` |
| `"usb"` | `UsbManager` 按 `usbVendorId`+`usbProductId` 搵到 device → claim interface → bulkTransfer 寫 ESC/POS bytes | `usbVendorId`, `usbProductId` |
| `"bluetooth"` | `BluetoothSocket` connect `bluetoothAddress`（或按 `bluetoothName` 配對）RFCOMM/SPP → 寫 bytes | `bluetoothAddress`, `bluetoothName` |

- `usbVendorId` / `usbProductId` 係 **hex string**（例如 `"0x1234"`），APK 要 `parseInt(it, 16)`。
- `bluetoothAddress` 係 MAC（`"AA:BB:CC:DD:EE:FF"`）。
- ESC/POS 渲染邏輯（`EscPosRenderer`）**完全唔使改** —— 三種 transport 只係「點樣將已經 render 好嘅 byte[] 送到打印機」唔同，票據格式一致。

#### 2.2 可靠非同步結果回調 `window.__posNativePrintResult`
同步回傳（POS call `printJob` 嗰句）只代表「APK 收咗 / queue 咗」。**物理出單結果必須經下面呢條非同步通道返給 POS**：

```js
// POS 網頁側（已預留，APK 要 call 佢）：
window.__posNativePrintResult = (result) => {
  // result = { jobId, ok, error?, code?, at }
  // jobId 必須 = payload.job.id，POS 靠佢對返單
};
```

APK 合約（**必須遵守**）：

```kotlin
// APK 出單完成 / 失敗後 call：
val cb = webView.evaluateJavascript("window.__posNativePrintResult") // 或直接注入
val json = """{"jobId":"$jobId","ok":$ok,"code":"$code","error":"$err","at":${System.currentTimeMillis()}}"""
webView.evaluateJavascript("window.__posNativePrintResult($json)") { }
```

- `jobId`：即 payload `job.id`（String），**必定要返同樣個 id**，否則 POS 對唔到單。
- 時機：物理出單成功 / 失敗後 call，**建議 ≤ 10 秒**內。
- 如果 APK 崩潰 / WebView 銷毀嚟唔切 call，POS 側有自己 `ttl` 超時 fallback，唔會卡死。
- `code` 用 §5 嘅錯誤碼（成功可留空 / `"OK"`）。

#### 2.3 接收並保留新 payload 欄位 `storeId` / `ttl`
Phase 0 開始 payload 頂層多咗兩個欄位。**APK 至少要 `parse` 到佢哋唔報錯**（即使暫時唔用）：

```jsonc
{
  "storeId": "macau-store-a",   // String，relay 路由用
  "ttl": 1755667800000,         // Long epoch millis / null，job 過期
  ... // job / printer / kind / storeName ... 同 docs/37
}
```

- `storeId` 空 string = 終端未補（LAN 直打場景，可忽略）。
- `ttl` 為 `null` = 唔設過期（LAN 直打場景）。

---

### P1 · 雙路徑（relay）功能

> P1 唔係 Phase 0 即做，但 **payload 合約已經留位**（§2.3）。APK 團隊可以喺 P1 才實作下面行為。

#### 2.4 LAN 唔到 → 經 Cloud Print Relay 出單（Terminal Local Agent 角色）
當 APK 偵測到自己 **唔喺店內 LAN**（見 §2.5 anchor 偵測），單據唔能夠 LAN 直打，就要：

1. 開 WSS 去 `wss://<relay-host>/print/<storeId>`（HTTPS 落單頁 → WSS 唔係 mixed-content，安全）。
2. 發 `{job, printer, kind, storeName, storeId, ttl}`（同 LAN 直打 payload 一樣，加多 storeId/ttl）。
3. 收 relay ack（已轉交店內 Stationary Agent）。
4. 店內 **Stationary Agent**（另一台常開機 / 常開 App）收到 relay job → 用同一套 `LanTransport` 出單。
5. 打印結果經 relay 原路返返終端 → 終端再 call `window.__posNativePrintResult`。

> ⚠️ **relay 唔係用嚟取代 LAN 直打**：relay 只係「終端暫時離開店內 LAN」嗰陣嘅 fallback。喺店內就 LAN 直打，最快最穩。

#### 2.5 LAN anchor 偵測（mDNS，可選但推薦）
- Stationary Agent / 店內打印機廣播 mDNS：`_macau-print._tcp.local`，txt record 帶 `storeId=<storeId>`。
- Terminal Local Agent 定期 resolve 呢個 anchor：
  - **anchor 在** + 打印機 socket 失敗 → 係**打印機問題**（紙盡 / 斷線），**唔 escalate 去 relay**，只係返錯誤碼俾 POS。
  - **anchor 唔在** → 終端離開店內 LAN → escalate 去 relay（§2.4）。
- 呢個區分好重要：避免「打印機壞咗」被誤判成「LAN 冇咗」而亂用 relay。

---

## 3. 合約確認（Payload 完整例）

POS `dispatchJobToNative` 會 call：

```js
window.PosNative.printJob(JSON.stringify(payload))
```

`payload` 完整結構（APK `Bridge.printJob` 收呢個形）：

```jsonc
{
  "job": {
    "id": "print-xxxx",
    "orderNo": "A123",
    "tableName": "3號枱",
    "ticketType": "normal",          // "normal" | "addon" | "void"
    "printerId": "printer-xxx",
    "printerName": "前檯收據機",
    "items": [
      { "name": "炸雞", "quantity": 2, "specs": ["大"], "note": "走冰" },
      { "name": "總計", "quantity": 1, "specs": [], "note": "MOP 100" }
    ],
    "createdAt": 1755667200000        // ⚠️ epoch millis（Long），唔係 ISO string
  },
  "printer": {
    "id": "printer-xxx",
    "name": "前檯收據機",
    "connectionType": "lan",          // ⚠️ 新：可以 "lan" | "usb" | "bluetooth"
    "ipAddress": "192.168.1.112",     // usb/bluetooth 時可空
    "lanPort": 9100,
    "paperSize": "80mm",              // 含 "58" → 32 寬，否則 42 寬
    "charset": "gb18030",             // gb18030 / gbk / big5 / utf-8
    "usbVendorId": "",                // ⚠️ 新：connectionType==="usb" 用（hex string）
    "usbProductId": "",               // ⚠️ 新
    "bluetoothAddress": "",           // ⚠️ 新：connectionType==="bluetooth" 用（MAC）
    "bluetoothName": ""               // ⚠️ 新
  },
  "kind": "receipt",                  // "receipt" | "kitchen" | "test"
  "storeName": "示範店",
  "paymentMethod": "",
  "total": null,
  "storeId": "macau-store-a",         // ⚠️ 新（Phase 0 起必須能 parse）
  "ttl": null                         // ⚠️ 新（Long epoch millis / null）
}
```

> `createdAt` / `charset` / `kind` 映射 / `storeName` 等規則同 [`docs/37`](./37-apk-native-bridge-print-format.md) §3 完全一致，唔重複。

---

## 4. 雙路徑狀態機（APK 側邏輯參考）

```
                 ┌─────────────────────────────┐
   落單 job ───▶ │  LAN anchor 在？             │
                 └────────────┬────────────────┘
                    yes │          │ no
                        ▼          ▼
              ┌──────────────┐  ┌──────────────────────┐
              │ path A       │  │ path B               │
              │ LAN 直打      │  │ relay（WSS→店內      │
              │ LanTransport │  │ Stationary Agent）   │
              └──────┬───────┘  └──────────┬───────────┘
                     │                     │
        打印機 socket 失敗？                │
           yes → 返錯誤碼（唔 escalate）    │ relay 唔到 → 返 RELAY_UNAVAILABLE
           no  → 出單成功                   │
                     │                     │
                     └─────────┬───────────┘
                               ▼
                  call window.__posNativePrintResult({jobId, ok, code, error?})
```

- 每部打印機獨立狀態（ON_LAN ↔ RELAY），唔係全局一切換。
- 自愈：每 45s 探一次 anchor；連續 2 次 anchor 在 + LAN 直打造成功 → 由 RELAY 切返 ON_LAN。
- job `ttl` 過期（relay 側 / POS 側都會 check）→ 丟棄，唔出單。

---

## 5. 錯誤碼規範（建議）

APK 喺 `window.__posNativePrintResult` 嘅 `code` 用以下枚舉（同步回傳 `error` 亦可重用）：

| code | 意思 | POS 側建議動作 |
|---|---|---|
| `OK` | 出單成功 | 標 sent |
| `PRINTER_NOT_FOUND` | 按 connectionType 搵唔到打印機（IP/USB/BT） | 提示店主檢查連接 |
| `CONNECTION_FAILED` | socket / USB open / BT connect 失敗 | 提示重試 / 檢查電源 |
| `WRITE_FAILED` | 寫入 bytes 失敗（中途斷） | 提示重印 |
| `USB_PERMISSION_DENIED` | Android USB 權限未授權 | 提示授權 |
| `BT_NOT_PAIRED` | 藍牙未配對 | 提示配對 |
| `PAPER_EMPTY` / `PRINTER_ERROR` | 打印機狀態回報異常 | 提示檢查紙張 |
| `TIMEOUT` | 出單超時（≥10s） | 轉 fallback / 重印 |
| `RELAY_UNAVAILABLE` | LAN 唔到且 relay 連唔上 | 提示網絡 / 標 failed 等人工 |
| `QUEUED` | 已 queue 但未出單（異步中） | 等 `__posNativePrintResult` |

> 同步回傳 `printJob` 仍保留 `{ok, queued, error}` 形（docs/37 合約唔變）；`error` 可填上面 code 嘅人類可讀版。

---

## 6. 驗收標準（APK 團隊 self-check）

**P0（必須）**
- [ ] `printer.connectionType === "usb"` 時，APK 用 `usbVendorId`+`usbProductId` 搵到 USB 打印機並出單（ESC/POS bytes 經 bulkTransfer）。
- [ ] `printer.connectionType === "bluetooth"` 時，APK 用 `bluetoothAddress`（或 name）connect 並出單。
- [ ] `connectionType === "lan"` 行為同之前完全一樣（唔回歸）。
- [ ] 物理出單完成 / 失敗後，APK **必定** call `window.__posNativePrintResult({jobId, ok, code, error?})`，`jobId` = payload `job.id`。
- [ ] Payload 頂層 `storeId` / `ttl` 能 parse、唔報錯（即使暫未使用）。
- [ ] 三種 transport 共用同一套 `EscPosRenderer`（票據格式一致，只係送達方式唔同）。

**P1（雙路徑，後續）**
- [ ] LAN anchor（mDNS `_macau-print._tcp.local` + `storeId`）resolve 到 → ON_LAN；resolve 唔到 → escalate relay。
- [ ] 打印機 socket 失敗但 anchor 在 → 只返錯誤碼，**唔** escalate relay。
- [ ] 離開店內 LAN → WSS 去 `wss://<relay-host>/print/<storeId>` 發 job，收 ack。
- [ ] 收 relay 回傳嘅打印結果 → 再 call `window.__posNativePrintResult`。
- [ ] job `ttl` 過期唔出單（relay 側 + 終端側都 check）。

---

## 7. 聯絡 / 上下文

- POS 端 Phase 0 改動（`src/lib/types.ts` `ConnectionType`/`DevicePrinterConfig`/`PrintJob` + `src/lib/print-bridge/native.ts` payload）已落地，純合約擴充，**冇改打印邏輯**。
- 現役打印格式適配需求：見 [`docs/37-apk-native-bridge-print-format.md`](./37-apk-native-bridge-print-format.md)（APK 團隊已按佢改 `EscPosRenderer.renderReceiptTicket`）。
- 雙路徑設計藍圖：見 [`docs/43-cross-platform-print-dual-path.md`](./43-cross-platform-print-dual-path.md)。
- 三平台打包可行性（Android / Windows exe / iOS）：見 [`docs/44-packaging-feasibility.md`](./44-packaging-feasibility.md)。
- APK 團隊改完 rebuild、裝機（Sunmi + 一部 USB 機 + 一部 BT 機）測試，並確認非同步回調有返 `jobId` 就得。
