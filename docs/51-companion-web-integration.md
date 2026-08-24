# 51 · 桌面 Companion 打印整合（取代 Sunmi Printer Hub）

> 狀態：已落地（2026-08-24 重建並 commit）。Web 端 `src/` 與桌面代理 `desktop-companion/` 均已就位。

## 1. 背景 / 問題

舊方案只有兩條打印通道：

1. **native bridge**（`window.PosNative`，Sunmi Android WebView）
2. **Sunmi Printer Hub**（Android APK HTTP `:8787`）

實測痛點（用戶回報「打印唔到、掃唔到機」）：

- 喺 Windows / macOS 嘅 Electron / 普通瀏覽器 POS，冇 native bridge 又無 Sunmi APK → 落單 job 卡 `pending` / `failed`，收據靜默唔出。
- 掃描打印機靠 Hub APK 嘅 scan（要 APK + 指定網段），唔係桌面代理 mDNS。
- USB / 藍牙要手填 VID/PID、COM 名，商家唔識。

## 2. 方案總覽

引入**桌面 Companion 代理**（Electron Node server，loopback `http://127.0.0.1:9311` + `::1` 雙棧）。

- **Web 派發優先級**：native Android bridge > 桌面 Companion（**完全移除 Sunmi Hub**，Web 唔再依賴 `:8787`）。
- **零配置預配對**：固定 loopback 地址 + 空 token，開 App 即自動連；UI 只顯示連線狀態 +「測試連線」掣，IP / Token 欄位灰咗唔使填。
- **Meituan 式型號選擇**：插 USB → Companion 經 `node-usb` 枚舉 → 按 VID/PID 對照型號表自動填品牌 / 型號 / ESC/POS 編碼 / 紙張；商家全程唔使手填 VID/PID。
- **共享組件**：餐飲（`device-settings`）同美容（`salon/settings`）共用 `PrinterCompanionPanel`。

```
┌──────────────────────────────┐         ┌──────────────────────────────┐
│  Web POS（Vercel / Electron） │  fetch  │  桌面 Companion 代理          │
│  src/lib/print-bridge/       │ ──────▶ │  http://127.0.0.1:9311       │
│   companion.ts（客戶端）      │ ◀────── │  companion-server.mjs         │
│   PrinterCompanionPanel       │  JSON   │  · /api/health 探測          │
└──────────────────────────────┘         │  · /api/discover mDNS 區網   │
                                          │  · /api/usb  node-usb 枚舉   │
                                          │  · /api/print 派發           │
                                          └───────────┬────────┬─────────┘
                                               :9100 TCP │        │ USB / 藍牙
                                                  LAN 機   │        │（stub，待擴充）
                                                           ▼
                                                      熱感打印機
```

## 3. Web 端檔案清單（`src/`）

| 檔案 | 角色 |
| --- | --- |
| `lib/print-bridge/printer-models.ts` | `USB_PRINTER_DB`（VID→品牌/型號/編碼/紙張）、`toHexId`、`resolveUsbMeta`、`CHARSET_OPTIONS`、`PAPER_SIZE_OPTIONS` |
| `lib/print-bridge/companion.ts` | **客戶端核心**：`tryAutoPairCompanion`、`isCompanionAvailable`、`testCompanionConnection`、`sendJobToCompanion`、`discoverCompanionLanPrinters`、`enumerateCompanionUsbPrinters`、`listCompanionPrinters`、`resolveJobPrinter`、`resolvePrintJobStatus` |
| `lib/print-bridge/dispatch.ts` | `flushPendingPrintJobs`：native > Companion；移除 `hub` import |
| `lib/print-bridge/native.ts` | 不變（Android native bridge） |
| `lib/print-bridge/hub.ts` | **已刪除**（Sunmi Hub 基建） |
| `components/printer-companion-panel.tsx` | 共享：零配置狀態卡 + Meituan 式發現/加機精靈 |
| `components/print-flush-worker.tsx` | 全域後台 worker（root layout 掛載）：定時 auto-pair + flush |
| `app/layout.tsx` | `<PrintFlushWorker />` 取代 `<HubPrintWorker />` |
| `lib/types.ts` | `ConnectionType = "lan" \| "usb" \| "bluetooth"`；`DevicePrinterConfig` 加 `usbVendorId` / `usbProductId` / `bluetoothName` / `autoDetected` |
| `lib/salon/print.ts` | import 由 `hub` → `companion`；`dispatchPrint` fallback `sendJobToCompanion` |
| `lib/ledger/ledger-pos-bridge.ts`、`components/print-center.tsx`、`components/pos-app.tsx` | import 由 `hub` → `companion` |
| `components/device-settings.tsx` | 移除 Hub UI，掛 `PrinterCompanionPanel` + `connectionType` `<select>` |
| `components/salon/settings.tsx` | 掛 `PrinterCompanionPanel` + `usb`/`bluetooth` 連線選項 |

## 4. Companion 代理 API（`desktop-companion/companion-server.mjs`）

| Method | Path | 回應 |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, version }` |
| GET | `/api/config` | `{ companionUrl, posUrl, tokenEnabled }`（俾 POS 自動配對） |
| GET | `/api/discover` | `{ ok, printers: [{ name, ip, port, type }] }`（mDNS 區網 LAN 機；未裝 `bonjour-service` 回空陣列） |
| GET | `/api/usb` | `{ ok, printers: [{ vendorId, productId, brand, model, charset, paperSize, connectionType:"usb", recognized }], note }`（node-usb 枚舉） |
| GET | `/api/printers` | `{ ok, lan, usb, note }`（合併上面兩者） |
| POST | `/api/print` | body `{ job, printer }` → 經 OS 權限打到 LAN `:9100`（USB/藍牙為 stub，待擴充） |

- 雙棧 loopback 監聽（`127.0.0.1` + `::1`），避免單 stack 時 `EADDRINUSE` 雙 bind 都失敗。
- `usb` / `bonjour-service` 唔裝就 graceful degrade，其他功能唔受影響。

啟動（桌面代理，需喺用戶機器跑）：

```bash
cd desktop-companion/desktop-companion
npm install          # 裝 iconv-lite / usb / bonjour-service（唔裝都跑得，會 fallback）
npm run serve        # = node server.mjs → http://127.0.0.1:9311
```

## 5. 零配置預配對流程

1. POS 開頁 → root layout 掛嘅 `PrintFlushWorker` 每 2.5s 跑一次 `tryAutoPairCompanion()`。
2. `tryAutoPairCompanion()` 優先順序：URL `?companion=` 參數 → 已儲存地址 → 預設 `http://127.0.0.1:9311` 探測。
3. 探測 `/api/health` 成功 → 寫入 `localStorage['macau-pos-companion-url']`（token 留空）→ 標記「已連線」。
4. 之後落單 job 經 `dispatch.ts` → `sendJobToCompanion(job, printer)` → POST `/api/print`。

## 6. 商家加機流程（Meituan 式）

餐飲「設定 → 打印機」或美容「設定 → 打印」頁：

1. 頂部 **Companion 狀態卡**：綠點=已連線（顯 version）、紅點=未連線；「測試連線」掣即場探測；IP / Token 欄灰咗唔使填。
2. 「+ 區網 / LAN 打印機」→ `discoverCompanionLanPrinters()` 列出 mDNS 機 → 點選填入 IP/Port。
3. 「+ USB 打印機」→ `enumerateCompanionUsbPrinters()` 列出 node-usb 機 → **自動填 VID/PID/型號/編碼/紙張**，商家只改名同紙張/編碼。
4. 「+ 藍牙打印機」→ 手填藍牙名稱。
5. 填名稱 / 類型（分區出單 / 收據 / 標籤）/ 對應分區 / 紙張 / 編碼 → 「加入呢部機」→ `onAddPrinter` 寫入 `config.printers`，`autoDetected: true`。

## 7. 連線方式（`DevicePrinterConfig.connectionType`）

- **lan**：`ipAddress` + `lanPort`（預設 9100）
- **usb**：`usbVendorId` / `usbProductId`（**auto-detected，UI 灰 disable 唔使填**）
- **bluetooth**：`bluetoothName`（手填）

`dispatchOneJob` 唔再以 `ipAddress` 缺失報錯（USB/BT 無 IP），改由 Companion 按 `connectionType` 路由。

## 8. 驗證

- **型別**：`npx tsc --noEmit` → `src/` 零錯（唯一已知誤報 `src/app/layout.tsx` `LayoutProps` 係 standalone tsc 冇 `.next/types` 所致，`next build` 無礙）。
- **手動**：開 Companion → 瀏覽器開 POS → 設定頁見「已連線」→ +LAN / +USB 掃到機 → 加機 → 落單出單。
- **端點**：`curl http://127.0.0.1:9311/api/health` 應回 `{ "ok": true, "version": "..." }`；`/api/usb`、`/api/discover` 回對應清單（沙盒無實體機/未裝 usb 套件時回空陣列，屬正常 degrade）。

## 9. 注意 / 已知限制

- 真後端 / Ledger push 仍留 seam，未接。
- 沙盒無 Android SDK，APK build 待用戶 dev box；Companion 代理只需 Node ≥ 18。
- USB / 藍牙嘅實際位元組傳輸喺代理端仍係 stub，LAN `:9100` 已可派發；接實體 USB/BT 機需喺代理補 `usb` / `serialport` 傳輸層。
- `src/` 工作目錄曾被環境偶發清空，所有改動已逐檔 commit 入 git，必要時 `git checkout HEAD -- .` 即可還原。
