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
│        mapGroupToService(group) → front/bar/kitchen       │
│        renderJobToText(job) → 可讀文本票                  │
│        sendToHub(service, text) ──┐                       │
└───────────────────────────────────│──────────────────────┘
                                     │ HTTP（按合約，見下）
                                     ▼
┌────────────────────────────────────────────────────────────┐
│  Sunmi 機：Printer Hub APK（同事做，LAN :8787）            │
│  （唔喺本 repo）                                           │
│                                                            │
│  收到 /api/print → 按 service 分發到綁定嘅打印機           │
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
| POST | `/api/assign` | `key`,`service` | 將某部機綁定到 front/bar/kitchen |
| POST | `/api/manual` | `ip`,`name`,`service` | 手動添加打印機 |
| POST | `/api/remove` | `key` | 移除一部 |
| POST | `/api/clear` | — | 清除全部綁定 |
| POST | `/api/print` | `{service,message}` 或 `{ip,title,message}` | 真正出單（service 按綁定分發 / ip 直打某部） |
| GET | `/beacon.png` | chunked query（job/seq/total/chunk + service 或 ip） | mixed-content 被動傳輸通道 |
| GET | `/setup.html` | — | Hub 內部設定頁（POS 側「開啟 Hub 設定頁」會開佢） |

### service 對應（PrinterService）

| service id | 中文 | 對應 PrintJob.printerGroup |
|---|---|---|
| `front` | 前台 | `receipt` / `label` / 其他 |
| `bar` | 水吧 | `bar` |
| `kitchen` | 廚房 | `kitchen` / `zone` |

## POS 側實作（本 repo）

```
macauPosSystem/
├── src/lib/print-bridge/
│   ├── hub.ts          ← 唯一 print path adapter：配對、status/devices、send、QR、service 映射
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
            mapGroupToService(job.printerGroup)
            → renderJobToText(job)  // 可讀文本票
            → sendToHub(service, text)  // fetch 或 beacon
            → ok ? "sent" : "failed"
```

### 配對 UI（device-settings 打印設置 tab）

- **QR 掃描**：`navigator.mediaDevices.getUserMedia` + 動態載入 jsQR（CDN `jsqr@1.4.0`），解析 `http://IP:PORT` / `poshub://IP:PORT` / `IP:PORT` / `IP`。
- **選取 QR 圖片**：`<input type=file capture=environment>` → 解碼圖片入面嘅 QR。
- **手動填 IP + Port**（預設 `8787`）→ 「記住 IP」寫 `localStorage.posHubIp / posHubPort`。
- **狀態列**：`fetchHubStatus()` 顯示 Hub IP / 已綁定數；設備列表 show 每部機 service `<select>` 綁定 + 「移除」。
- **手動添加打印機** + **掃描區網** + **清除全部**（call `/api/manual` `/api/scan` `/api/clear`）。
- **開啟 Hub 設定頁**：`window.open("http://IP:PORT/setup.html")`。
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
- WebUSB / browser 直印測試（device-settings 入面）保留做手動測試工具，但**唔係** order 派發路徑。

## 文檔關聯

| 文檔 | 內容 | 與本文關係 |
|---|---|---|
| docs/33 | 自管 HTTPS 證書 | 舊方案（被取代） |
| docs/34 | 本機部署（LAN HTTP） | 舊方案（部分保留） |
| docs/35 | Cloudflare Tunnel | 舊方案（被取代） |
| **docs/36** | **Printer Hub 配對** | **本文（現行方案）** |
