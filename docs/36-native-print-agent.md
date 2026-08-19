# 36. Native Android Print Agent（WebView Shell + JS Bridge）

> **取代方案**：Node print-bridge / Cloudflare Tunnel / 自管 HTTPS 證書 → 全部唔使。
> 唯一要求：POS 需跑喺 Android 裝置上（手機 / 平板）。

## 架構概要

```
┌──────────────────────────────────────────────────────┐
│  Android Tablet / Phone                              │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  WebView (com.macau.pos.printagent)           │  │
│  │  ┌──────────────────────────────────────────┐ │  │
│  │  │  POS Web App (Vercel HTTPS)              │ │  │
│  │  │  https://macau-pos-system.vercel.app     │ │  │
│  │  │                                          │ │  │
│  │  │  window.PosNative.printJob(json) ──┐    │ │  │
│  │  └────────────────────────────────────│───┘ │  │
│  │                                       │      │  │
│  │  ┌────────────────────────────────────▼───┐  │  │
│  │  │  Kotlin JS Bridge (@JavascriptInterface) │  │
│  │  │  Bridge.printJob(payloadJson)           │  │  │
│  │  │  → EscPosRenderer.render* (GB18030)     │  │  │
│  │  │  → EscPosPrinter.printRaw(ip:9100)      │  │  │
│  │  └────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────┘  │
│                         │                            │
│                    LAN (raw socket)                   │
│                         ▼                            │
│              ┌─────────────────────┐                 │
│              │  ESC/POS Printer    │                 │
│              │  192.168.1.110:9100 │                 │
│              └─────────────────────┘                 │
└──────────────────────────────────────────────────────┘
```

### 點解唔使 mixed content / Tunnel？

- POS 喺 HTTPS（Vercel）上面跑。
- POS 呼叫 `window.PosNative.printJob()` —— 呢個係 **JavaScript method call**，唔係 HTTP `fetch`。
- Kotlin 端用 `Socket(IP, 9100)` raw TCP 直出 ESC/POS bytes —— 唔經瀏覽器網絡層。
- 冇 mixed content violation、冇 Private Network Access preflight、冇 HTTPS cert 需求、冇 Tunnel。
- **斷網照印**：LAN socket 係本地網絡，唔使上網。

## 與舊方案對照

| | Node print-bridge + Tunnel | Native Agent |
|---|---|---|
| 印表路徑 | POS → HTTPS fetch → Tunnel → HTTP bridge → LAN socket | POS → JS call → Kotlin → LAN socket |
| 需要上網 | ✅（Tunnel） | ❌（純 LAN） |
| 斷網 | 印唔到（fetch fail） | 照印 |
| HTTPS 證書 | 需要（Tunnel 或自管） | 唔使 |
| 店主操作 | 設定 Tunnel URL | 裝 APK 即可 |
| 非打印機功能（落單、結帳） | 斷網仍可用（離線 mode） | 斷網仍可用（WebView cache） |
| 適用裝置 | 任何裝置（browser） | **只有 Android** |

## 代碼位置

```
macauPosSystem/
├── print-agent-android/           ← Android Studio 專案
│   ├── app/
│   │   ├── build.gradle.kts       ← applicationId = com.macau.pos.printagent
│   │   └── src/main/
│   │       ├── AndroidManifest.xml
│   │       ├── java/com/macau/pos/printagent/
│   │       │   ├── MainActivity.kt          ← WebView + PosNative bridge
│   │       │   ├── model/
│   │       │   │   ├── PrintJobDto.kt       ← JSON → PrintJob 解析
│   │       │   │   └── PrinterCfgDto.kt    ← JSON → Printer 解析 + 匹配
│   │       │   ├── net/
│   │       │   │   ├── EscPosRenderer.kt   ← ESC/POS bytes（GB18030，port 自 escpos.mjs）
│   │       │   │   ├── EscPosPrinter.kt    ← raw Socket(ip, 9100)
│   │       │   │   └── LanScanner.kt       ← subnet 掃描
│   │       │   └── hub/                     ← PrinterHub + 前台服務（fallback）
│   │       └── assets/index.html           ← app 內打印機設定 UI
│   └── settings.gradle.kts
│
├── src/lib/print-bridge/
│   ├── native.ts                  ← isNativeBridgeAvailable() + dispatchJobToNative()
│   ├── client.ts                  ← 舊 HTTP bridge（fallback）
│   └── dispatch.ts                ← 統一 dispatch：native 優先 → webusb → browser → HTTP bridge
│
├── src/lib/salon/print.ts         ← salon 收據 dispatch（也走 native 優先）
└── src/components/
    ├── device-settings.tsx        ← native 連線狀態 banner + charset 下拉
    └── print-bridge-worker.tsx    ← native 模式跳過 HTTP health/config sync
```

## Bridge 合約

POS 側（TypeScript）呼叫 → Kotlin 側接收：

| JS call | 參數 | 回傳 | 說明 |
|---|---|---|---|
| `PosNative.printJob(payloadJson)` | `{job, printer?, kind?, storeName?, paymentMethod?, total?}` | `"{ok,queued,jobId,ip,port}"` 同步；異步 `window.__posNativePrintResult(json)` | 主路：POS 帶齊 printer 資料 |
| `PosNative.testPrint(payloadJson)` | `{printer, storeName?}` | 同上 | 測試打印 |
| `PosNative.getStatus()` | — | `"{ok,available,localIp,printerCount}"` | 健康檢查 |
| `PosNative.listDevices()` | — | `"{ok,devices:[...]}"` | 列出已綁定打印機 |
| `PosNative.openPrinterSettings()` | — | void | 跳 app 內掃描 / 綁定 UI |
| `PosNative.backToPos()` | — | void | 返回 POS |

### payload JSON 形狀

```json
{
  "job": {
    "id": "print-abc123",
    "orderId": "order-001",
    "orderNo": "A001",
    "tableName": "桌5",
    "ticketType": "normal",
    "printerGroup": "kitchen",
    "printerId": "printer-001",
    "printerName": "廚房主印",
    "items": [
      { "name": "炸雞桶", "quantity": 2, "specs": ["辣"], "note": "少鹽" }
    ],
    "createdAt": "2026-08-19T10:30:00.000Z"
  },
  "printer": {
    "id": "printer-001",
    "name": "廚房主印",
    "connectionType": "lan",
    "ipAddress": "192.168.1.110",
    "lanPort": 9100,
    "paperSize": "80mm",
    "charset": "gb18030"
  },
  "kind": "kitchen",
  "storeName": "示範餐廳"
}
```

## ESC/POS 字集（每台可配）

| charset | 支援 | 預設 |
|---|---|---|
| `gb18030` | 簡體中文 + 繁體基本 | ✅ 預設 |
| `gbk` | 簡體中文 | |
| `big5` | 繁體中文 | |
| `utf-8` | 全 Unicode（部分打印機唔支援） | |

- Kotlin 端用 `Charset.forName(charset)` 做 encoding。
- POS 側 `DevicePrinterConfig.charset` 可選填；留空走 Kotlin 預設 GB18030。
- 設定頁 → 打印機列表 → 每台 LAN 打印機有「ESC/POS 跨碼」下拉。

## POS URL 配置

`app/build.gradle.kts`：
```kotlin
buildConfigField("String", "POS_URL", "\"https://macau-pos-system.vercel.app\"")
```

- 改 URL：改呢一行，重新 build APK。
- 預設 fallback：`MainActivity.DEFAULT_POS_URL = "https://macau-pos-system.vercel.app"`。

## 打印機站點對應

POS 側 `DeviceConfig.printers` 已有 `role`（`kitchen` / `receipt` / `zone` / `label`）+ `zoneId`。
Native bridge 接收 POS 帶嚟嘅 `printer` object（已經係配對好嘅具體打印機），唔使自己再路由。

Fallback（POS 冇帶 printer）：Kotlin `resolvePrinterFromHub(job)` 用 `job.printerName` 或 `job.printerId` 去 `PrinterHub` 已綁定設備度搵。

## 構建 APK

### 前置

- Android Studio (Hedgehog 或更新)
- JDK 17（Android Studio 自帶）
- Android SDK 36（compileSdk）

### 步驟

```bash
cd print-agent-android

# Debug APK
./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk

# Release APK（需簽名）
./gradlew assembleRelease
```

### 安裝到裝置

```bash
adb install app/build/outputs/apk/debug/app-debug.apk
```

或者 copy APK 到手機再點擊安裝。

## 使用流程

1. 喺 Android 裝置裝好 APK
2. 開 app → 自動載入 POS（Vercel）
3. 落單 → POS call `window.PosNative.printJob()` → 打印機出單
4. 測試：POS 設定 → 打印機列表 → 測試打印按鈕 → 經 native bridge 出測試頁
5. 綁定新打印機：POS 設定 → 「開啟打印機設定」→ app 內掃描 UI

## 完全取代嘅限制

> ⚠️ **只有 Android 裝置能打印。**

- Desktop / iPad / 非 Android 平板：冇 `window.PosNative` → POS fallback 走舊 HTTP bridge（如有設 URL）。
- 如果冇設 HTTP bridge URL：非 Android 裝置嘅打印 job 會維持 `pending` 狀態，唔會出單。
- 這是 confirmed 的 trade-off（用戶選擇「完全取代」方案 A）。

## 離線行為

- **POS 離線**：WebView cache + LocalStorage 離線 mode 照常落單。
- **打印機離線**：`EscPosPrinter.printRaw` 4 秒超時 → 回報失敗 → job status = `failed`。
- **兩者都斷**：落單正常（離線 mode），打印 job 維持 pending，等下次 flush 重試。

## 文檔關聯

| 文檔 | 內容 | 與本文關係 |
|---|---|---|
| docs/33 | 自管 HTTPS 證書 | 舊方案（被取代） |
| docs/34 | 本機部署（LAN HTTP） | 舊方案（部分保留） |
| docs/35 | Cloudflare Tunnel | 舊方案（被取代） |
| **docs/36** | **Native Android Agent** | **本文（推薦）** |
