# 36. Printer Hub 配對（POS 網頁 ↔ Sunmi Hub APK）

> **本文取代舊方案**：WebView Shell + `window.PosNative` JS Bridge（`print-agent-android` 那隻 WebView APK 已棄用）。
> 用戶最終要嘅係：**POS 網頁設定頁** 配對一隻 **喺 Sunmi 機上面跑嘅 Hub APK**（同事做緊，唔喺本 repo），
> POS 落單後經 HTTP 發信號畀 Hub，Hub 再經 LAN 出單到打印機。本 repo 只負責 POS 網頁嗰邊。

## 架構概要

```
┌────────────────────────────────────────────────────────────┐
│  POS Web App (Vercel HTTPS)                                 │
│  macau-pos-system.vercel.app                               │
│                                                            │
│   device-settings 打印設置 tab：                           │
│     QR 掃描 / 手動填 IP 配對 Hub                           │
│     → 記低 posHubIp / posHubPort（localStorage）          │
│                                                            │
│   order 落單 → buildReceiptPrintJobs → pending PrintJob    │
│     → HubPrintWorker 定時 flush                          │
│     → sendJobToHub(job)                                   │
│        resolveJobPrinter(job) → config.printers 按 role/zoneId 搵 IP │
│        renderJobToText(job) → 可讀文本票                  │
│        sendToHubIp(ip, name, text) ──┐                    │
└───────────────────────────────────│──────────────────────┘
                                     │ HTTP（按合約，見下）
                                     ▼
┌────────────────────────────────────────────────────────────┐
│  Sunmi 機：Printer Hub APK（同事做，LAN :8787）            │
│  （唔喺本 repo）                                           │
│                                                            │
│  收到 /api/print → ip 唔空就 printToIp(ip) 直打（優先）    │
│     → raw socket :9100 → ESC/POS 出單                     │
└────────────────────────────────────────────────────────────┘
```

### 兩件獨立嘅嘢

1. **POS 網頁配對 UI（本 repo）**：`device-settings.tsx` 打印設置 tab + `hub.ts` adapter。
2. **Sunmi Hub APK（同事做）**：喺 Sunmi 機安裝，開 App 顯示 QR，Listen `:8787`，掃描區網打印機、做 service 綁定、收 `/api/print` 再轉 ESC/POS 出單。

POS 同 Hub 之間**完全靠 HTTP 合約**溝通，POS 唔使知 Hub 內部點做。

### 點解要用 mixed-content 兩段式發送？

POS 喺 HTTPS（Vercel）上面跑，但 Hub 喺店內 LAN 係 `http://IP:8787`（冇 TLS）。
直 `fetch` 會被瀏覽器 mixed-content  rule block。參考 `print.html` demo 嘅做法：

- **非 HTTPS 先**（例如 LAN IP 載 POS）：直接用 `fetch POST /api/print`。
- **HTTPS 頁**（Vercel）：用 `<img src="/beacon.png?...">` 隱藏圖片 chunked 傳輸（passive mixed content 唔會被 block）。每 chunk ≤ 1400 字元，Hub 端再拼返。
- 用戶已確認 Sunmi 機上面呢套做法可行。

## Hub API 合約（POS → Hub）

Hub APK 暴露嘅 HTTP 接口（同 demo `LanHttpServer.kt` 一致）：

| Method | Path | Body / Query | 說明 |
|---|---|---|---|
| GET | `/api/status` | — | 回 `{ok, listening, localIp, port, deviceCount, bound, devices[]}` |
| GET | `/api/devices` | — | 回 `{ok, devices[]}`；每部 `{key,name,ip,mac,openPorts,service,canRawPrint}` |
| POST | `/api/scan` | `prefix`,`identify` | 掃描區網打印機 |
| POST | `/api/assign` | `key`,`service` | ⚠️ **已棄用**：POS 改行 IP 直打，唔再 service 綁定（留喺 APK 合約但 POS 唔 call） |
| POST | `/api/manual` | `ip`,`name`,`service` | 手動添加打印機（service 欄 POS 已唔使，但 APK 合約仲收） |
| POST | `/api/remove` | `key` | 移除一部 |
| POST | `/api/clear` | — | 清除全部綁定 |
| POST | `/api/print` | `{service,message}` 或 `{ip,title,message}` | 真正出單（service 按綁定分發 / ip 直打某部） |
| GET | `/beacon.png` | chunked query（job/seq/total/chunk + service 或 ip） | mixed-content 被動傳輸通道 |
| GET | `/setup.html` | — | Hub 內部設定頁（POS 側「開啟 Hub 設定頁」會開佢） |

### service 對應（PrinterService）— ⚠️ 已棄用，僅留作文檔

> 2026-08-20 起 POS 改行 **IP 直打**（`sendToHubIp`），唔再用 service 綁定路由。
> 下面對應表只係舊 contract 嘅參考，APK 端 `printToIp(ip)` 優先過 `printService(service)`。

| service id | 中文 | 對應 PrintJob.printerGroup |
|---|---|---|
| `front` | 前台 | `receipt` / `label` / 其他 |
| `bar` | 水吧 | `bar` |
| `kitchen` | 廚房 | `kitchen` / `zone` |

## POS 側實作（本 repo）

```
macauPosSystem/
├── src/lib/print-bridge/
│   ├── hub.ts          ← 唯一 print path adapter：配對、status/devices、send、QR、resolveJobPrinter 按 config.printers IP 路由
│   └── dispatch.ts     ← flushPendingPrintJobs：pending job → sendJobToHub；retryFailedPrintJob
│
├── src/lib/salon/print.ts   ← salon 收據 dispatch（call sendJobToHub）
│
├── src/components/
│   ├── device-settings.tsx  ← 打印設置 tab：Hub 配對 UI（QR 掃描 / 手動 IP / 設備列表 / service 綁定）
│   └── hub-print-worker.tsx ← 背景定時 flush pending job（取代舊 print-bridge-worker.tsx）
│
└── src/app/layout.tsx       ← 掛 <HubPrintWorker />
```

### 打印派發流程

```
order 落單
  → buildReceiptPrintJobs() / dispatchSalonReceipt()
  → 新建 PrintJob status = resolvePrintJobStatus()
       ├─ 已配對 Hub → "sent"（樂觀，等 worker flush）
       └─ 未配對 Hub → "pending"（等店主喺設置頁配對）
  → HubPrintWorker 定時 flushPendingPrintJobs()
       ├─ isHubConfigured() == false → 保持 pending
       └─ 否則 sendJobToHub(job)
            resolveJobPrinter(job) → config.printers 按 role/zoneId 搵目標打印機 IP
            → renderJobToText(job)  // 可讀文本票
            → sendToHubIp(ip, name, text)  // 經 Hub 直打該 IP（fetch 或 beacon）
            → ok ? "sent" : "failed"
```

### 配對 UI（device-settings 打印設置 tab）

- **QR 掃描**：`navigator.mediaDevices.getUserMedia` + 動態載入 jsQR（CDN `jsqr@1.4.0`），解析 `http://IP:PORT` / `poshub://IP:PORT` / `IP:PORT` / `IP`。
- **選取 QR 圖片**：`<input type=file capture=environment>` → 解碼圖片入面嘅 QR。
- **手動填 IP + Port**（預設 `8787`）→ 「記住 IP」寫 `localStorage.posHubIp / posHubPort`。
- **開啟 Hub 設定頁**：`window.open("http://IP:PORT/setup.html")`。

#### UI 合併 + IP 路由（2026-08-19 → 2026-08-20 改 IP 路由）

用戶要求將「Hub 掃描到嘅打印機」同原本「打印機列表」（`config.printers`）合埋，用**打印機列表做單一真源**；「Hub ID 配對」區（QR / IP / Port / 記住 / 設定頁）保留不動。

> **2026-08-20 路由策略改為方案 B（按 IP 直打）**：經核對 APK `LanHttpServer.kt`，`runPrint(service, ip, title, message)` 優先 `ip.isNotBlank() → hub.printToIp(ip,...)`，service 路徑係舊嘅、且 user 確認「之前 hub service 其實都不 work」。所以**移除晒所有 service 綁定代碼**（`mapGroupToService` / `sendToHub` / `assignHubPrinter` / `/api/assign` call），改為 `sendJobToHub` 按 `config.printers` 嘅 `role`/`zoneId` 搵 `ipAddress` → `sendToHubIp`。徹底單一真源，`dispatch.ts` 同 `salon/print.ts` 都 call `sendJobToHub`，改呢度就兩邊一齊改。

- **發現區重構**：`hubDevices` 唔再做 service `<select>` 綁定 UI，改為每行一部機 + 「＋ 加入列表」掣；IP 已經喺 `config.printers` 嘅顯示「已加入 ✓」（用 ip 去重）；保留「移除」（call `/api/remove`）同「清除 Hub 綁定」（call `/api/clear`）。
- **`handleAddDiscoveredToPrinterList(device)`**：用 `hubDevice` 預填一條 `config.printers`（`name/ipAddress/lanPort=9100/connectionType=lan/charset=gb18030/role` 由 `device.service` 映射 `front→receipt` 其餘→zone/`enabled=true`）。IP 已存在則跳過。唔再做任何 service 綁定（`assignHubPrinter` 已刪）。
- **`handleManualAdd`**：同時寫入 APK（`/api/manual`）+ `config.printers`（master），APK 回傳 error 用 `setStatus` 顯示（修咗之前「添加打印機唔行」冇 error 嘅問題）。
- **打印機列表狀態燈**：每條 printer 用 `ipAddress` 對照即時 `hubDevices`，連到且 `canRawPrint` → 綠點「Hub 已連線」，否則灰點。
- **`handleRoleChange`**：同步 `updatePrinter(printer.id, { role: newRole })`；只改 `config.printers` 嘅 role（IP 路由靠 role/zoneId，唔使重新綁 service）。
- **路由策略（方案 B · 按 IP 直打 · 2026-08-20）**：`sendJobToHub(job)` → `resolveJobPrinter(job)` 按 `config.printers` 搵目標（先 `printerId`，再 `role`/`zoneId` 配 `job.printerGroup`）→ 攞 `ipAddress` → `sendToHubIp(ip, name, text)`。`dispatch.ts` / `salon/print.ts` 唔使改，食 `sendJobToHub` 新行為。
- **測試打印**：未配對 → 提示先配對；配對咗 → `sendToHubIp(printer.ipAddress, printer.name, "Macau POS 測試打印\nPrinter Hub OK")`。

## 已移除（按用戶指示：fallback print-bridge / native bridge 唔使要）

| 檔案 | 原因 |
|---|---|
| `src/lib/print-bridge/client.ts` | 舊 HTTP print-bridge（`getPrintBridgeUrl` / `syncPrintBridgeConfig` 等）。`resolvePrintJobStatus` 已搬去 `hub.ts` 並改 Hub-aware。 |
| `src/lib/print-bridge/native.ts` | `window.PosNative` native bridge（`isNativeBridgeAvailable` / `dispatchJobToNative`）。 |
| `src/components/print-bridge-worker.tsx` | 改名 `hub-print-worker.tsx`，改成只 flush Hub。 |
| `print-agent-android/`（WebView Shell APK） | 舊方案：WebView 載 POS + `PosNative` bridge。已棄用，改用同事隻獨立 Hub APK。倉庫入面嘅 `app-debug.apk` 唔再係目標成品。 |

> ⚠️ **唯一路徑**：依家打印只經 Hub。未配對 Hub 嘅 job 會一直 `pending`，等店主喺設置頁配對 Sunmi Hub 先出單。
> 非 Sunmi / 冇裝 Hub APK 嘅裝置（desktop、iPad）暫時冇打印出口。

## 驗收

- `tsc --noEmit`：除咗 `layout.tsx` 預存 `LayoutProps` 誤報（同本任務無關）外，零錯誤。
- 連接方式只餘 **LAN（經 Printer Hub 直打）**：USB / WebUSB / 瀏覽器打印（`window.print`）三種連接方法已移除（唔 work，且 Hub-only 架構下全部走 Hub → raw socket :9100）。`print-webusb.ts` / `print-browser.ts` / `escpos.ts` 三個模塊已刪除。`ConnectionType` 收窄為 `"lan"`，`DevicePrinterConfig` 移除 `usbLabel` / `webusbSerial` 欄位。
- **打印機只可以 IP 新增**：「新增廚房/分區 / 收據 / 標籤打印機」三個空白掣已刪除（開出嚟冇 IP、Hub-only 下印唔到）。改為統一經「手動添加打印機」表單（填 IP + 名稱 + **角色** 收據/分區/標籤；分區/標籤會再揀所屬 print zone）或 Hub 掃描「＋ 加入列表」新增。`addPrinter()` 函數已刪除；`handleManualAdd` 改用 `manualRole` / `manualZoneId` 決定 `role` / `zoneId`，`HUB_SERVICES` import 移除（Hub 註冊 service 只係 metadata，路由靠 IP/role/zoneId）。

## 文檔關聯

| 文檔 | 內容 | 與本文關係 |
|---|---|---|
| docs/33 | 自管 HTTPS 證書 | 舊方案（被取代） |
| docs/34 | 本機部署（LAN HTTP） | 舊方案（部分保留） |
| docs/35 | Cloudflare Tunnel | 舊方案（被取代） |
| **docs/36** | **Printer Hub 配對** | **本文（現行方案）** |
