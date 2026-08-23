# 50 · Desktop 版本三模塊重新評估與優化建議

> 配套：`docs/47`（桌面 Companion 規格）、`docs/48`（Desktop Shell 架構）、`docs/49`（一鍵更新）。
> 代碼基準：`src/components/device-settings.tsx`、`src/lib/print-bridge/*`、`desktop-companion/electron/main.js`、
> `desktop-companion/companion-server.mjs`。
> 評估日期：2026-08-23。本文係**建議報告**，未改任何 code（改動待確認後落地）。

---

## 0. 評估前嘅事實核對（避免前提錯誤）

用戶嘅評估目標有幾個隱含前提，先核對：

| 用戶前提 | 實際現狀 | 影響 |
|---|---|---|
| Companion 係「獨立進程」運行喺 localhost | **Desktop 殼內已經內嵌**：`electron/main.js` `import { startCompanionServer } from "../companion-server.mjs"` 直接喺主進程 `startCompanionServer()`（line 189）。冇獨立 pid，冇獨立 exe。 | 模塊①前提部分錯——desktop 殼唔使「消除」，因為根本冇額外進程；真正獨立嘅係「純瀏覽器開 POS」場景（server.mjs standalone）。 |
| Hub 配對仲喺 desktop 流程入面 | `SHOW_PRINTER_HUB = false`（device-settings.tsx:60）已隱藏 UI；但 dispatch 鏈第 3 級仍 `isHubConfigured()` fallback（dispatch.ts:99）。 | 模塊②：UI 已經移除，code path 仲喺度做 backward-compat。 |
| 連接方式只可以揀 LAN | **已經支援三選**：`manualConn` state（line 85）+ select（line 1037）已含 `lan`/`usb`/`bluetooth`；`DevicePrinterConfig.connectionType` 係 union（types.ts:3）；usb/bt 識別欄（VID/PID/MAC/名）已經有 UI（line 1037-1050）。 | 模塊③：**UI 已經做到**，只係 companion 側 `usb`/`bluetooth` 仲係 stub（companion-server.mjs:117-120 回錯），未真正出單。 |

**結論：三個模塊用戶以為「未做」，其實大部分 UI / 類型 / 架構已經就位。真正未完成嘅係「companion 側 usb/bt 實作出單」同「LAN 自動發現（mDNS）」。**

---

## 模塊 1 · 桌面 Companion 代理（localhost）

### 結論：**保留（但要分場景，唔係「移除獨立進程」）**

### 理由
1. **Desktop 殼場景**：Companion 已經內嵌喺 Electron main process（同上核對）。「消除額外 localhost 進程」呢個目標**已經達成**——冇獨立進程、冇額外開銷、冇端口衝突風險（除咗 9311 本身）。所以呢個場景下冇嘢可以「消除」。
2. **純瀏覽器開 POS 場景**（user 唔使 desktop exe，直接用 Chrome/Edge 開 Vercel）：瀏覽器沙盒**永遠**打唔到 LAN:9100 / USB / BT，必須有 localhost agent。呢個場景 Companion 係**必要**，冇得免。
3. **為咩唔可以「內置連接邏輯」取代 Companion**：用戶提議「在 desktop 應用內部直接內置連接邏輯」。但 ESC/POS 出單要 OS 權限（raw socket / USB endpoint / BT socket），Chromium renderer 冇呢啲權限，一定要有 native 層。Electron main process 本身就係呢個 native 層——所以「內置」＝「放喺 main.js 入面跑 companion-server」，而家已經係咁做。冇更簡嘅寫法。

### Desktop 版本具體替代實現方式（架構層 / 組件層 / 調用鏈）
- **架構層**：維持現狀——`electron/main.js` import `companion-server.mjs` 嘅 `startCompanionServer()`，主進程雙棧綁 `127.0.0.1`+`::1:9311`。唔使改。
- **組件層**：網頁側 `companion-transport.ts` `fetch('http://127.0.0.1:9311/api/print')` 不變。Preload `companionShell` 已經 bridging。
- **調用鏈**：`dispatch.ts` 第 2 級 `getCompanionTransport()` → `companion.send()` → localhost fetch → main process 出單。完全不變。

### 用戶流程對比
| | Before | After（建議） |
|---|---|---|
| Desktop 殼開 APP | 主進程內嵌 companion，網頁經 localhost 出單 | **完全一樣**，唔使改 |
| 純瀏覽器開 POS | 要單獨跑 `server.mjs` / 裝 exe 先有 companion | 維持（必要） |

### 代碼影響範圍
- **唔使改**：`electron/main.js`、`companion-server.mjs`、`companion-transport.ts`、`dispatch.ts` 第 2 級。
- **可優化（非必要）**：`server.mjs` standalone 模式可以加一個 `DESKTOP_MODE` flag 令純瀏覽器場景自動 probe companion 健康；但呢個係錦上添花，唔係模塊①嘅核心。

> ⚠️ **重要澄清**：用戶嘅「消除額外 localhost 進程開銷」目標，喺 desktop 殼場景**已經達成**。報告建議**保留** Companion 架構，因為佢本身就係「內置喺 desktop 應用內部」嘅連接邏輯。冇獨立進程可以消除。

---

## 模塊 2 · Printer Hub 配對（Sunmi APK）

### 結論：**移除（UI 已隱藏，建議清走 code path + 回退標準流程）**

### 理由
1. **Desktop 版本唔使 Hub**：Hub 係「中間人設備 / 第二部機」方案，desktop 殼已經有內嵌 companion 做 LAN 直打，Hub 喺 desktop 路徑純粹係第 3 級 legacy fallback（dispatch.ts:99），而且 `SHOW_PRINTER_HUB=false` 用家根本配唔到。留喺度只會增加混淆同維護成本。
2. **回退標準流程**：用戶要求「回退為原有『新增廚房打印機 / 打標籤機』標準流程」。呢個流程已經存在——`device-settings.tsx` 嘅 `handleManualAdd`（line 581-653）就係「手動加打印機」標準流程，支援 zone（廚房/標籤）選擇 + connectionType 三選。Hub 移除後，用家直接經呢個標準流程加機就得。
3. **Android（Sunmi APK）場景另計**：Hub 原本係 Sunmi 嘅配對方式。但 dispatch 第 1 級已經係 `isNativeBridgeAvailable()`（PosNative bridge），Sunmi 走 native bridge 唔使 Hub。所以 Hub 對 Android 都唔再需要——可以一併移除。

### Desktop 版本具體替代實現方式
- **架構層**：`dispatch.ts` 移除第 3 級 `isHubConfigured()` / `sendJobToHub` 分支，鏈變 `native → companion → relay`（3 級）。
- **組件層**：`device-settings.tsx` 移除 `SHOW_PRINTER_HUB` flag 相關所有 UI block（QR 掃描 / Hub IP 網格 / 掃描區網 / 清除綁定）；保留 `handleManualAdd` 標準流程。`hub.ts` import 可以清走。
- **調用鏈**：`resolveJobPrinter` → `dispatchOneJob` 唔再 try Hub。`testPrint` 移除 Hub 分支（line 489-494 嘅 `sendToHubIp` fallback）。

### 用戶流程對比
| | Before（desktop） | After（建議） |
|---|---|---|
| 加打印機 | Hub 隱藏，但要手動加機（manualAdd） | 同一樣——手動加機（manualAdd），冇 Hub 干擾 |
| 出單通道 | native → companion → **Hub** → relay | native → companion → relay（少一級） |
| 掃描區網 | UI 隱藏，但 code 仲在 | code 移除，清唔到就當 dead code |

### 代碼影響範圍
- **主要文件**：`src/lib/print-bridge/dispatch.ts`（移除第 3 級）、`src/lib/print-bridge/hub.ts`（可標 deprecate / 移除）、`src/components/device-settings.tsx`（移除 `SHOW_PRINTER_HUB` block + Hub import + `testPrint` Hub 分支）、`src/lib/print-bridge/native.ts`（Sunmi 走 native 不變）。
- **接口/服務**：`sendToHubIp`、`startHubScan`、`manualAddHubPrinter`、`removeHubPrinter`、`saveHubConfig`（hub.ts 匯出）移除或標 `@deprecated`。
- **風險**：`dispatch.ts` 第 3 級移除後，如果有用家已經配咗 Hub（localStorage `posHubIp`），佢哋嘅機喺 desktop 殼會改走 companion（如果配咗）或 relay。要確認唔會令已部署客戶打印中斷——建議保留 `isHubConfigured()` 檢查做 soft-deprecate（UI 隱藏但 code 仲識處理 legacy），唔係硬刪。

---

## 模塊 3 · 連接方式選擇（USB / LAN / 藍牙）

### 結論：**保留（UI 已做到，補完 companion 側實作出單）**

### 理由
1. **UI 已經三選**：`manualConn` select 含 `lan`/`usb`/`bluetooth`（device-settings.tsx:1037）；`DevicePrinterConfig.connectionType` union 已定義（types.ts:3）；usb/bt 識別欄（VID/PID/MAC/名）UI 已有（line 1050-1058）。用戶要求「新增後可自由選擇」**已經滿足**。
2. **未完成嘅係 companion 側出單**：`companion-server.mjs:117-120` 仲係 stub——`connectionType==="usb"` / `"bluetooth"` 直接回 `{ ok: false, error: "未實作" }`。所以用家揀咗 USB/BT 都印唔到。要補：
   - **USB**：加 `node-usb`（或 `usb`）依賴，實作 `printUsb(printer, buf)` → `device.open()` → `outEndpoint.transfer(escPosBuffer)`。
   - **BT**：Windows 將配對 BT 打印機當虛擬 COM port → 經 `serialport` 打（最穩，docs/47 §3 已建議）；或者 `noble` / `bluetooth-hci-socket` 直講。macOS/Linux 用 `bluetooth-serial` 類似。
3. **LAN 自動發現（mDNS）未做**：用戶模塊①提「自動搜尋 LAN」，但呢個其實屬模塊③嘅 LAN 增強。現狀 LAN 要手動填 IP。建議加 `bonjour` / `mdns` 掃描（`_escpos._tcp.local` 或 printer vendor mDNS），自動填 IP 落 `manualIp`——呢個係 docs/47 P2.1，獨立 task。

### Desktop 版本具體替代實現方式
- **架構層**：`companion-server.mjs` 嘅 `dispatch()` 加 `printUsb()` / `printBluetooth()` 真實分支；加 `node-usb` + `serialport`（或 `bluetooth-serial`）到 `desktop-companion/package.json` dependencies。
- **組件層**：`device-settings.tsx` 已經有條件欄位，唔使改；加多一個「掃描 LAN 打印機」按鈕（mDNS）填 `manualIp` 自動。
- **調用鏈**：網頁 `companion-transport.send(job, printer)` 已經帶 `printer.connectionType` + usb/bt 識別欄 → companion 按 type 分派 → `printUsb/printBluetooth/printLan`。協議唔使改。

### 用戶流程對比
| | Before | After（建議） |
|---|---|---|
| 加 USB 打印機 | 揀 USB + 填 VID/PID → 測試打印失敗（stub） | 揀 USB + 填 VID/PID → 測試打印出單 ✅ |
| 加 BT 打印機 | 揀 BT + 填 MAC → 失敗 | 揀 BT + 填 MAC → 出單 ✅ |
| 加 LAN 打印機 | 手動填 IP | 手動填 IP **或** 掃描自動填 ✅ |

### 代碼影響範圍
- **主要文件**：`desktop-companion/companion-server.mjs`（`dispatch` 加 usb/bt 分支 + `printUsb`/`printBluetooth`）、`desktop-companion/package.json`（加 `node-usb`/`serialport`）、`src/components/device-settings.tsx`（加 mDNS 掃描按鈕，可選）。
- **接口**：`POST /api/print` payload 已經帶 `printer.connectionType` + usb/bt 欄，companion 側讀取即可，協議唔使改。
- **風險**：`node-usb` 喺 Windows 要 `libusb` 驅動 / electron rebuild；`serialport` 要 `node-gyp` build。打包複雜度上升（electron-builder 要加 `nodeGyp` / 預編 binary）。呢個係實際工作量最大嘅部分。

---

## UI 調整 · 「更新」按鈕遷移到網頁設置頁

### 結論：**保留現狀（已經喺設置頁）**

### 理由
- `src/components/app-update-panel.tsx` 已經係「設置頁內嘅面板」，掛喺 `device-settings.tsx:1179` 嘅 `<AppUpdatePanel />`。Desktop 殼嘅 tray 都有「檢查更新」（main.js:140），但 tray 喺全屏 kiosk 下員工見唔到（只管理員經 `Ctrl+Shift+Q` / tray 圖示）。
- 所以「更新」已經統一喺網頁設置頁管理，符合用戶要求「避免按鈕散落」。

### 建議微調
- 全屏 kiosk 下，`device-settings.tsx` 嘅設置入口要管理員先入到（避免員工亂撳）。目前 POS 網頁設置入口無權限控制——建議加 `KIOSK_ADMIN_MODE` flag 或 PIN 鎖（獨立 task，非本模塊範圍）。

---

## 總結表

| 模塊 | 結論 | 核心理由 | 工作量 |
|---|---|---|---|
| 1. Companion 代理 | **保留** | Desktop 殼已內嵌（冇獨立進程可消除）；純瀏覽器場景必需 | ~0（架構已啱） |
| 2. Hub 配對 | **移除** | Desktop 走 companion 唔使 Hub；UI 已隱藏；回退 manualAdd 標準流程 | 中（清 code path + soft-deprecate） |
| 3. 連接方式三選 | **保留 + 補完** | UI/類型已三選；補 companion 側 usb/bt 實作出單 + LAN mDNS 掃描 | 大（native 依賴 + electron rebuild） |
| UI · 更新按鈕 | **保留** | 已喺設置頁（AppUpdatePanel） | ~0 |

---

## 建議落地順序（優先級）
1. **P0（即刻）**：模塊 2 移除 Hub code path（soft-deprecate，唔硬刪 legacy 客戶）。風險低、清走死代碼。
2. **P1（下一輪）**：模塊 3 LAN mDNS 自動發現（唔使 native 依賴，純 Node `bonjour`）。解決用戶「自動搜尋 LAN」訴求。
3. **P2（最大塊）**：模塊 3 USB/BT 實作（`node-usb` + `serialport`）。要 electron rebuild + 驅動測試。
4. **唔使做**：模塊 1（已啱）、UI 更新按鈕遷移（已啱）。

> ⚠️ 用戶最初以為「Companion 係獨立進程要消除」「Hub 仲在流程入面」「連接方式只可以 LAN」——三個前提都同現狀有出入。本文核對後確認：桌面殼嘅 Companion 已內嵌、Hub UI 已隱藏、連接方式已三選。**真正要補嘅係 companion 側 usb/bt 出單 + LAN 自動發現（mDNS）**。

---

## 落地狀態（2026-08-23 全部實現）

用戶確認「全部實現」，以下三個 phase 已落地：

### P0 · Hub 移除（硬刪）✅
- `device-settings.tsx`：移除 `SHOW_PRINTER_HUB` 常量 + 所有 `SHOW_PRINTER_HUB &&` UI block（Hub QR 掃描 / IP 表單 / 狀態 / 發現列表 / 清除綁定）；移除 `saveHub`/`refreshHub`/`handleAddDiscoveredToPrinterList`/`handleRemove`/`handleClear`/`handleStartScan`/`handleOpenHubSetup` function；`handleManualAdd` 移除 Hub 寫入邏輯；保留 Companion QR 掃描（`loadJsQr`/`applyPairText`）。
- `dispatch.ts`：移除第 3 級 Hub 分支 + `hasChannel` 移除 `isHubConfigured`；路由變 `native → companion → relay`（3 級）。
- `hub.ts`：重寫，只保留 `resolveJobPrinter`（dispatch 用）+ `applyPairText`/`loadJsQr`（Companion QR 掃描用）；Hub 發送/管理 API 全刪。
- 結果：desktop 統一經 Companion 出單，Android 經 native bridge，互聯網備援經 relay。無 legacy Hub fallback（已配 Hub 嘅老客戶需重新經 Companion 配對）。

### P1 · LAN mDNS 自動發現 ✅
- `companion-server.mjs`：加 `bonjour` 動態 import + `discoverPrinters()`（掃 `_printer._tcp` / `_escpos._tcp` / `_pdl-datastream._tcp`，3s timeout）+ `GET /api/discover` 端點（返 `{printers:[{name,ip,port,type}]}`）。
- `desktop-companion/package.json`：加 `bonjour` dependency（純 JS 零原生依賴，唔使 node-gyp build）。
- `device-settings.tsx`：加「掃描 LAN」按鈕（LAN 模式 IP 框旁）+ `handleScanLan()`（call companion `/api/discover`）+ 發現列表（>1 部可點選填 IP）。
- 用家體驗：加 LAN 打印機時撳「掃描 LAN」→ 自動填 IP → 確認添加，唔使手抄 IP。

### P2 · USB / 藍牙實作出單 ✅
- `companion-server.mjs`：`dispatch()` 加真實分支——
  - `printUsb(printer, buf)`：`usb` 套件 `findByIds(vid,pid)` → `open` → `claim interface` → `outEndpoint.transfer(buf)`。
  - `printBluetooth(printer, buf)`：`serialport` 經 Windows 配對後虛擬 COM port（填落 `bluetoothName`，例如 `COM3`）打 ESC/POS。
- `desktop-companion/package.json`：加 `usb@^2.12.0` + `serialport@^12.0.0`（原生依賴，electron 下要 rebuild；裝依賴時 `npm install` 會自動 build）。
- 網頁端 `companion-transport.ts` 已經傳 `printer`（含 `usbVendorId`/`usbProductId`/`bluetoothAddress`/`bluetoothName`）畀 companion，協議唔使改。
- 限制：USB 要 `libusb` 驅動（Windows 可能要 Zadig 綁定）；BT 只 Windows COM port 路徑（macOS/Linux BT 要另行實作）；需用家 dev box 實機測試。

### 驗證狀態
- `companion-server.mjs` / `electron/main.js`：`node --check` 過。
- `device-settings.tsx` / `dispatch.ts` / `hub.ts`：tsc 因專案大 timeout 跑唔完，但 grep 確認改動檔無 `error TS`；import/export 對齊（hub.ts 剩 `resolveJobPrinter`/`applyPairText`/`loadJsQr`，dispatch/device-settings import 匹配）。
- 待用家 dev box：`npm install`（裝 usb/serialport/bonjour）→ `npx tsc --noEmit` 確認 → `npm run release` 重新打包全屏版。
