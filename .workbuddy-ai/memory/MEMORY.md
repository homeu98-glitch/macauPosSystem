# Macau POS System — 專案記憶

## 結構概要

`macauPosSystem` 澳門 Web POS。前台已上線生產（macau-pos-system.vercel.app）。
技術：Next.js 16.3 App Router + React 19 + TS 5 + Tailwind 4 + Supabase 雙寫（Ledger 必配 / POS 可選）+ PWA + LocalStorage 離線優先 + print-bridge。

## 關鍵目錄

- `src/app/` — 路由（餐飲 v1 + salon v1+）
- `src/components/` — `pos-app.tsx` 核心（fast-food 與堂食**共用**，都掛在 `/`）、`online-orders.tsx`（`/orders`）、`device-settings.tsx`、`print-center.tsx`
- `src/lib/types.ts` — **只讀權威**；`src/lib/storage.ts` — localStorage 包裝
- `src/lib/ledger/` — Ledger Supabase 整合；`src/lib/print-bridge/` — `client.ts` HTTP / `native.ts` Android JS bridge / `dispatch.ts` 統一路由
- `print-agent-android/` — Native Android Print Agent（WebView shell + `window.PosNative`）
- `docs/` — 編號文檔（01 全局設計…82）

## 業務定位

- 澳門餐飲（飲品、炸雞、輕堂食）+ 美容院（salon v1+）
- 與 [Macau-Ledger](https://github.com/EricChang1015/Macau-Ledger) 共用 Supabase Auth + 線上訂單 Realtime
- 不做：藍牙打印、大中餐酒樓複雜工位、平台託管金流

## 重要約定

- 餐飲 localStorage 鍵 `macau-pos/*`；salon `macau-pos-salon/*`
- PrintJob 模型共用；列印分區前綴區分行業
- Ledger 介面層不可繞過（不走 Vercel HTTP，已 410）
- 不引入新依賴
- **設定真源規律**：per-terminal 設定（floors 枱、printTemplates、`onlineOrderSettings` 自動接單）本地 localStorage 優先，唔畀 server 蓋；其餘 field 先係 server 優先。因為 `pos_device_configs` GET 係 `.order(updated_at desc).limit(1)` = **全店最新一條（任何 terminal）**，本來就唔可信。

## 線上訂單

### 自動接單被 server 同步覆蓋（2026-08-31 ✅ 已修）

現象：熄咗「自動接單」，新單仍即刻變 accepted。
根因：`pos-app.tsx loadRuntimeState()` 同步 `/api/pos/state` 時 `merged = {...payload.localSettings, floors: local.floors, printTemplates: local.printTemplates}` —— 只保護咗 floors / printTemplates，**`onlineOrderSettings` 冇保護**，被 server 份（含 `autoAccept:true`）蓋走 → `savePosLocalSettings` → dispatch `pos-local-settings-changed` → React state `autoAcceptOnlineOrders=true` → auto-accept effect 繞過 guard → `acceptLedgerOrder` → DB 真變 accepted。
前置條件（點解 server 有 true）：`device-settings.tsx syncConfig()` POST `/api/pos/device-config` 會寫**成份 localSettings**（含 autoAccept）。
已修：① `pos-app.tsx` merged 加 `onlineOrderSettings: local.onlineOrderSettings`；② `/api/online-order-settings` 加 store 隔離（GET filter `store_id`、POST 由 client 帶 `storeId`），4 個 call site（online-orders / pos-app / device-settings GET+POST）全部改帶 `loadAuthSession()?.merchantId`；③ 早一輪已加 POST `.catch()`（失敗唔打擾）＋ device-settings GET 改 local-only（唔用 `local || server`）。
排除了：Ledger 後台自動接單、樂觀更新假象、realtime handleInsert 改狀態、預設值為 true、排程任務。
**遺留（未做，待決定）**：`syncConfig()` 仍把 autoAccept 寫上 server，全新 terminal 首次同步會讀到舊 true。要根治可喺 POST `/api/pos/device-config` 前剝走 `onlineOrderSettings`（會令 server 一律讀到 false）。

### Print Center 冇 entry（2026-08-31 ✅ 已修）

根因：`pos-app.tsx onPrintJobUpsert` 用 React state `current` 做 `savePrintJobs` 基底，而 `bridgeLedgerOrderToPos` / `printKitchenForLedgerOrder` 直接寫 localStorage 唔更新 React state → 下一次 realtime upsert 沖走線上訂單 print jobs。
已修：`onPrintJobUpsert` 改以 `loadPrintJobs()` 為基底；`persistPrintJobs` / `printReceipt` 補 dispatch `pos-print-jobs-changed`（print-center 靠呢個 event 刷新）；`appendPrintJobs` / `bridgeLedgerOrderToPos` / `printKitchenForLedgerOrder` 統一改用 `mergePrintJobs()`（去重 + tombstone 過濾），唔再用 spread 合併。

### 狀態顯示差異

- `normalizeLedgerStatus()`（`order-mapper.ts`）把 `accepted` + `preparing` 都摺成 `preparing` → `/orders` 堂食頁一律顯示「製作中」。
- `ledgerStatusBadgeLabel()`（`online-order-actions.ts`）先會出「已接單」，只喺 `quick-online-orders-panel.tsx` 用。

## Kiosk / 客人掃碼落單

- 共用邏輯喺 `src/lib/use-kiosk-order.ts`；`/order` 三欄平板，`/menu` 手機外賣 App 風（單欄 + 底 bar + bottom sheet）。
- **storeId 必讀設備綁店，唔讀 auth session**：kiosk 登入（`login-screen.tsx` mode=kiosk）只 `saveKioskDeviceBinding()` 唔 `saveAuthSession`。生成枱 QR 要用 `loadKioskDeviceBinding()?.storeId/storeName`，唔好用 `loadAuthSession()?.merchantId`（會空 → fallback 去 `DEFAULT_KIOSK_STORE_ID = macau-store-a` demo 店）。
- 客人餐牌 = 商家真 menu（per-store）：`useKioskOrder()` 當 `scanStoreId` 有值會 `GET /api/pos/bootstrap?storeId=<scanStoreId>`；`bootstrap = fetchedBootstrap ?? loadBootstrapCache() ?? mockBootstrap`。
- 落單號碼跟店內線下序號：`/api/pos/sequence`（`dine_in→pos / pickup / delivery`），同店共用 `next_daily_sequence`。
- 收銀見單靠 realtime（filter `store_id=eq.<merchantId>`）+ 15s pull fallback；storeId 必須＝收銀 `authSession.merchantId`。
- 全局 `body{overflow:hidden}`：手機頁要 `main h-[100dvh] overflow-hidden` + 內部 `section flex-1 overflow-y-auto` + 頂/底 `shrink-0`。

## Salon 縱向擴展（2026-08-14 ✅ 全 7 phase 完成）

`store.industry = restaurant | salon`；salon 全部新建（`src/app/salon/` 等），唔動餐飲。共用 auth / storage / sync-queue / print-bridge / backoffice。核心差別：預約 vs 點單、staff label-only 唔登入、Ledger 餘額替代次卡、無庫存無退款。
詳見 `docs/26-beauty-salon-vertical.md`；會員忠誠度 3 功能詳見 `docs/30-salon-loyalty-referral-birthday.md`。

## 打印

### Native Print Agent（2026-08-19 ✅）

Android WebView 外殼注入 `window.PosNative`，`PosNative.printJob(json)` → Kotlin raw socket `IP:9100` ESC/POS。無 mixed content / Tunnel / cert，斷網照印。非 Android fallback 走舊 HTTP bridge。詳見 `docs/36-native-print-agent.md`（沙盒無 Android SDK，APK build 待 dev box）。

### ESC/POS 放大指令真相表（2026-08-30，Companion 0.1.15）

- `ESC ! n`（1B 21）只管 ASCII；`0x20`=闊 `0x10`=高 → 大字 l=`0x30`
- `FS ! n`（1C 21）只管 Kanji；`0x04`=闊 `0x08`=高 → l=`0x0C`
- `GS ! n`（1D 21）管 ASCII+Kanji；**nibble** `(h-1)<<4|(w-1)` → l=`0x11`（**唔係 0x30**）

舊 bug：`setStyle` 發 `ESC!0x30` + CJK 行再發 `GS!0x30` → Epson/Gprinter 相乘（4×4）= 版面撕裂。
已修（`C:\dev\desktop-companion\companion-server.mjs`）：CJK 行 `ESC!` 降 `0x00` 靠 `GS!` 放大；`GS_SIZE_BYTE={s:0x00,m:0x01,l:0x11}`；結尾 `resetMagnify()`。
**待用家**：`npm run dist` 打包 0.1.15 → 印 A/B 測試紙（V-A 應正常 2×、V-D 應重現 4×4）驗收。詳見 `docs/81`。

## 開發環境

- sandbox 內已自帶 `node_modules`，可直接 `npx tsc --noEmit` / `npx eslint <file>` 驗證（`npm install` 可能 EPERM，通常唔需要）。
- `tsc --noEmit` 唯一已知誤報：`src/app/layout.tsx(37) LayoutProps`（standalone tsc 見唔到 `.next/types`，唔影響 Vercel build）。
- 真正 `next build` 建議 dev box 跑一次。

## 用戶偏好

- 語言：繁體中文（廣東話風味）
- 工作流：先討論確定方向 → 寫正式文檔 → 上 GitHub；重要決定要整理成文檔存檔
- 偏好「不動現有」增量擴展
- 排查時**要求先徹底查根因再動手**，唔接受憑猜測俾修法
- 桌面 app 更新規約：每次更新 desktop companion 需重 build，並**主動告知新版本號**（區分「source 已修」vs「已打包 exe 生效」）
