# Macau POS System — 專案記憶

## 結構概要

`macauPosSystem` 澳門 Web POS。前台 v0.1 已上線生產（macau-pos-system.vercel.app）。

技術：Next.js 16.3 App Router + React 19 + TypeScript 5 + Tailwind 4 + Supabase 雙寫（Ledger 必配 / POS 可選）+ PWA + LocalStorage 離線優先 + 本地 print-bridge。

## 關鍵目錄

- `src/app/` — 路由（餐飲 v1 + salon v1+）
- `src/components/` — pos-app.tsx 是核心、print-center、online-orders、device-settings
- `src/lib/types.ts` — **只讀權威**，所有類型定義
- `src/lib/storage.ts` — localStorage 包裝
- `src/lib/ledger/` — Ledger Supabase 整合
- `src/lib/print-bridge/` — 列印橋接（`client.ts` HTTP bridge + `native.ts` Android JS bridge + `dispatch.ts` 統一路由）
- `print-agent-android/` — Native Android Print Agent（WebView shell + PosNative JS bridge，取代 Tunnel/cert）
- `docs/` — 編號文檔（01 全局設計...25 review）

## 業務定位

- 目標客群：澳門餐飲（飲品、炸雞、輕堂食）+ 美容院（v1+）
- 與 [Macau-Ledger](https://github.com/EricChang1015/Macau-Ledger) 共用 Supabase Auth + 線上訂單 Realtime
- 不做：藍牙打印、大中餐酒樓複雜工位、平台託管金流

## Salon 縱向擴展（2026-08-14 啟動）

詳細見 `docs/26-beauty-salon-vertical.md`。核心：

- **行業分流**：store.industry = `restaurant | salon`
- **不動餐飲**：salon 模組全部新建（`src/app/salon/`、`src/components/salon/`、`src/lib/salon/`）
- **共用基建**：auth、storage 框架、sync-queue、print-bridge、backoffice、admin
- **核心差別**：預約 vs 點單、staff label-only 不登入、Ledger 餘額替代次卡、無庫存無退款
- **Ledger 主導**：線上預約渠道、會員餘額、會員積分、定金扣款
- **6 個 phase 約 9–10 週**：P1 分流骨架（1.5w）✅ → P2 預約+walk-in（2w）✅ → P3 服務執行+加項+收據列印（2w；已移除崗位單列印與多人接力）→ P4 客戶檔案+積分（1w）✅ → P5 結帳+小費+定金+收據列印（2w）✅ → P6 報表+硬化（1.5w）✅
- **Phase 7 硬化與跨行業整合（2026-08-14）✅**：A 錯誤邊界（`src/app/salon/error.tsx`）+ 提示音（`src/lib/salon/sound.ts`，接結帳/列印）；B Backoffice 跨行業（`AccountStore.industry` + salon 併入 mock 列表 + 篩選/徽章/統計）；C IndexedDB 離線硬化（`src/lib/salon/idb.ts` kv 鏡像 + sync-queue，重連 flush；熱路徑零改動）。真後端 / Ledger push 留 seam。

### Phase 1 已完成（2026-08-14）

骨架檔案已落地，預設店家「示範美容院」/MOP 在 `ensureSalonBootstrap()` 首次啟動時種入。登入頁已加「美容」模式按鈕（唯一動到的餐飲檔案 `login-screen.tsx`），選美容後寫 `terminal-industry=salon` 再跳 `/salon`；salon 側有獨立 `SalonSidebar`（72px 可滾動左欄）。詳見 `.workbuddy-ai/memory/2026-08-14.md`。

### Phase 2 已完成（2026-08-14）

預約看板（日/週）、walk-in/電話開單表單、預約詳情/服務執行頁、Mock Realtime 層（5 筆假資料 seed）、工作台即時更新。全部走 Mock Realtime，Ledger 到位後切換 channel 即可。詳見 `.workbuddy-ai/memory/2026-08-14.md`。

### Salon 會員忠誠度 3 功能（2026-08-17 ✅）

用戶要求加 3 個會員功能，設計經確認後全落地，詳見 `docs/30-salon-loyalty-referral-birthday.md`：

- **① 推薦獎勵**：被推薦人**首次結帳**才發（防刷分），**只有推薦人得分**。客戶檔案設 `referrerId`；結帳時 `applyMockLedgerBonus(referrer, {points: referralPoints})` 並標 `referralRewarded`。
- **② 生日彈性優惠**：商家自定窗口（當月 `month` / 當週 `week`）+ 折扣% 與積分倍率**各自獨立**（填 0 關閉）；結帳命中窗口自動套用，店員可逐單關掉。
- **③ 每店積分配比 `pointsPerDollar`**（預設 1）；結帳賺分 = `floor(grandTotal / pointsPerDollar)` ×（生日窗口內倍率）。

落點：`types.ts`（`SalonLoyaltySettings` + `SalonBootstrap.loyalty?` + `SalonCustomerProfile.referrerId/referralRewarded` + `SalonPosOrder.pointsEarned/birthdayDiscount`）、`mock-data.ts`（`DEFAULT_SALON_LOYALTY` seed）、`storage.ts`（`ensureSalonBootstrap` 舊店補預設遷移）、`settings.tsx`（「會員優惠」tab）、`checkout.tsx`（生日折扣 + 賺分 + 推薦獎勵整合）、`customer-profile.tsx`（推薦人下拉）、`print.ts`（收據加「本次賺分 / 生日折扣」）。`tsc --noEmit` 零錯誤（僅 `layout.tsx` LayoutProps 誤報），待用戶 build + push。

### 沙盒 node_modules / build

檢出內已自帶 `node_modules`，本地可直接 `npx tsc --noEmit` 同 `npx eslint <file>` 驗證零迴歸（已確認可用）。`npm install` 喺沙盒可能 EPERM，但一般唔需要重裝。真正 `next build` 仍建議用戶 dev box 跑一次確認（standalone tsc 會有 `layout.tsx` LayoutProps 誤報，Vercel build 無礙）。

## Native Print Agent（2026-08-19 ✅）

取代 Node print-bridge + Cloudflare Tunnel + 自管證書。POS 跑喺 Android WebView 外殼，注入 `window.PosNative` JS bridge，POS call `PosNative.printJob(json)` → Kotlin raw socket `IP:9100` ESC/POS。無 mixed content、無 Tunnel、無 cert、斷網照印。

- `print-agent-android/` — Kotlin app（`com.macau.pos.printagent`）；WebView 載 `BuildConfig.POS_URL`（`https://macau-pos-system.vercel.app`）
- `src/lib/print-bridge/native.ts` — `isNativeBridgeAvailable()` + `dispatchJobToNative()` + `testPrintNative()` + `fetchNativeHealth()`
- `dispatch.ts` + `salon/print.ts` — native 優先 → fallback HTTP bridge
- `DevicePrinterConfig.charset` — 每台可配 ESC/POS encoding（預設 GB18030，支援 gbk/big5/utf-8）
- **完全取代策略**：只有 Android 裝置能打印；非 Android fallback 走舊 HTTP bridge（如有設 URL）
- 詳見 `docs/36-native-print-agent.md`；沙盒無 Android SDK，APK build 待用戶 dev box

## 重要約定

- 餐飲用 `macau-pos/*` localStorage 鍵；salon 用 `macau-pos-salon/*`
- PrintJob 模型共用；列印分區前綴區分行業
- Ledger 介面層不可繞過（不走 Vercel HTTP，已 410）
- 不引入新依賴；沿用 React 19 + Next.js 16 + Supabase JS

### Kiosk 客人 QR 嘅 storeId 必讀設備綁店（唔讀 auth session）

- kiosk 登入（`login-screen.tsx` mode=kiosk）只 `saveKioskDeviceBinding(...)` 然後 `return`，**唔 `saveAuthSession`**（設計上「唔留 staff session」）。
- 所以「掃碼點餐」tab 度 `loadAuthSession()` 係 null；生成枱 QR 要用 `loadKioskDeviceBinding()?.storeId / storeName` 做 URL 參數，唔好用 `loadAuthSession()?.merchantId`（會變空 → 客人手機 fallback 去 `DEFAULT_KIOSK_STORE_ID = macau-store-a` demo 店）。
- 客人手機 `/menu` + `/order` 經 `useKioskOrder()` 讀 `?store=` / `?storeName=` → `displayStoreName = binding?.storeName ?? scanStoreName ?? bootstrap.storeName`。
- **客人手機餐牌 = 商家點餐機嘅真 menu（per-store）**：`useKioskOrder()` 當 `scanStoreId` 有值會 `GET /api/pos/bootstrap?storeId=<scanStoreId>` 攞 `pos_bootstrap_config`（與 pos-app 員工端同一份，已由商家點餐機從 Ledger sync 落 DB）。`bootstrap = fetchedBootstrap ?? loadBootstrapCache() ?? mockBootstrap`；`menuLoading` 期間 `/menu` 顯示「載入中」避免 flash demo 餐牌。kiosk 路徑（無 scanStoreId）唔變，照用本地 cache。
- 落單 `storeId` 經 `binding?.storeId ?? scanStoreId ?? DEFAULT_KIOSK_STORE_ID` 決定，確保落到正確店。

### 客人掃碼落單架構（kiosk /order + 手機 /menu 分家）

- 共用邏輯抽去 `src/lib/use-kiosk-order.ts`（cart/realtime/resume/落單）；`/order` 係 3 欄平板（UI 唔變），`/menu` 係手機外賣 App 風（單欄 + 底 bar + bottom sheet）。
- 枱 QR（`kiosk-qr-panel.tsx`）指去 `/menu?tableId=&store=&storeName=`；`login-screen.tsx:87` 仍 `router.replace("/order")` 係 kiosk 登入後去向。
- **落單號碼跟店內線下序號**：kiosk/掃碼落單前經 `/api/pos/sequence`（`kind: dine_in→pos / pickup→pickup / delivery→delivery`，`storeId` 用所屬店）攞同日序號，同店內線下單共用 `next_daily_sequence` 同一日序列表；`buildKioskOrder` 收 `localOrderNo?` 參數，fetch 失敗先 fallback timestamp 後綴。
- **收銀見單機制**：kiosk 單寫 `pos_orders`（store_id = 所屬店），收銀側靠 realtime（`use-pos-realtime.ts`，filter `store_id=eq.<merchantId>`）+ 15s 週期 `/api/pos/orders?storeId=<merchantId>` pull fallback（`pos-app.tsx` 內）合併入 localStorage 並顯示。storeId 必須＝收銀 `authSession.merchantId` 先見到（上一輪 storeId 修正已處理 QR/手機）。
- **全局 `body{overflow:hidden}`**（`globals.css`）：手機 `/menu` 唔好靠整頁滾動，必須 `main h-[100dvh] overflow-hidden` + 菜單 `section flex-1 overflow-y-auto` + 頂欄/底 bar `shrink-0`，內部自滾。
- 菜品圖片：`MenuItem.image?` 由 Ledger（`list_merchant_order_menu` RPC）同步，經 `pos_bootstrap_config.menu_items` 落到手機；前端有圖先 render（`<img>` arbitrary 外部域名，唔用 next/image）。
- `tsc --noEmit` 唯一已知誤報：`layout.tsx(37) LayoutProps`（Next build 先生成 `.next/types`，standalone tsc 見唔到，唔影響 Vercel build）。

## 用戶偏好

- 語言：繁體中文（廣東話風味）
- 工作流：先討論確定方向 → 寫正式文檔 → 上 GitHub
- 偏好「不動現有」增量擴展
- 重要決定會要求整理成文檔存檔（防遺忘 + 對接用）
