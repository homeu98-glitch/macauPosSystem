# 專案長期記憶（macauPos / macauPosSystem）

> 對話日誌見 `.workbuddy/memory/YYYY-MM-DD.md`。

## 打印模板（print-center.tsx 設計頁）
- **二維碼網址/大小**：`ReceiptTemplate.qrUrl?` + `qrSize?`（default "m"）收據/自助點餐機各自存。**`normalizePosLocalSettings` 一定要帶返 `qrUrl`/`qrSize`**（試過漏咗 → reload 剷走網址）。設計頁即時預覽 call `renderEscPosLines` 收據分支**必須傳 `{ qr, qrSize }`**，否則二維碼唔顯示。
- **二維碼大小**：`EscPosLine.qr` 帶 `size`；預覽用 `QR_SIZE_FRACTION`（s/m/l=紙闊 40%/55%/80%）。⚠️ 真實出紙物理大細由 Companion/APK `qrModuleScale()` 決定（跨 repo），呢 repo 只做設計==預覽==存檔。
- **標籤模板鎖定**：`LABEL_STANDARD_WIDTH_MM=62`（沿用本系統標籤卷，唔好隨意改 60）。Label 區塊字型 size 鎖死，用 `withLabelFixedSizes()` 強制返 `LABEL_BLOCK_DEFAULTS`（buildSnapshot("label") + readTemplate("label") 都用）→ 舊 localStorage 存咗唔同 size 都無效。UI 唔畀改 label 字型檔位（仍可調對齊/粗體/可見/順序）。

## 報表模塊（restaurant-daily-report.tsx）
- **收入認列口徑**：`isSaleCountable(o)` 只計 `settled`（線下）／帶 `onlineOrderId` 嘅 `paid`；`refunded`/`partially_refunded`/`sent_to_kitchen` 一律唔計（未收款唔計營業額係啱）。有單但全未結帳 → 顯示琥珀提示條 +「未結帳訂單」KPI，**唔好**改口徑去包未結帳。
- **菜品排行快照聚合**：key = `menuItemId|訂單內菜品名`，金額用 `it.price`（快照）。改名/改價後舊單各自成行。**唔好**改返大類聚合或強對當前餐牌。`buildMenuMeta()` 只供診斷。
- **尖峰時段**：`combinedByHour = agg.byHour + onlineByHour`；線上單 cursor 分頁 `listMerchantOrders`（PAGE=500、MAX=8），拒 `paymentStatus!=="paid"` 同含 cancel。
- **線上單防雙計**：`posOnlineIds`（POS `onlineOrderId` Set）；`footfallTotal = posFootfall + countableOnlineOrders.length`。線上菜品排行用 `onlineDishSource`；effect 觸發 key 用 `onlineDishKey`，且必須喺 `countableOnlineOrders` 之後宣告（TDZ）。
- **營運指標**：只保留 4 行（營業額7日均/線上佔比7日均/會員充值7日均/售出份數），POS vs Ledger 對比已刪。
- 數據來源：POS 單雲端 `/api/pos/state?storeId&ordersOnly=1&start&end` 分頁（MAX_PAGES=10）；雲端空+成功=空狀態，唔 fallback 本機。Ledger 總值以 `getMerchantReportSummary`（orderCount/orderPaidMop）為權威，POS 補差。日期一律 Macau 邊界 ISO（`ledger/report-period.ts`），禁用 UTC-naive 86400000 寫法。

## MerchantId / store 隔離（嚴）
- `merchantId = staff_accounts.merchant_id`（UUID）；DB 用 `store_id`。報表用 `useReportMerchantId()` 訂閱 `pos-auth-changed`。
- 讀取端 strict：`belongsToStore() = o.storeId === merchantId`；undefined legacy row 寧棄。初始 orders 空防 hydration 錯 scope。寫入端：Kiosk/QR 綁定錯店（`60000003` 係真實 merchant UUID，唔係 mock）先會寫錯店；讀取已隔離，要改寫入就重綁 `macau-pos-kiosk-device`／`?store=`。
- **`dataReady = backfillDone && ledgerDone`**；admin 模式 `loadOnlineByHour` early return **必須 setLedgerDone(true)**（否則永遠 skeleton）。切店/切帳號即重置 dataReady。
- `getMerchantReportSummary` 回傳強型別：topup{`topupMop`(=paid+gift)/`topupPaidMop`/`topupGiftMop`}、deduct{同構}、order{`orderCount`/`orderPaidMop`(=balance+in_store)/`orderBalancePaidMop`/`orderInStorePaidMop`}；加 `rawAvos` module-level 一次性 console.log（禁 `console.table` Record → TS2769）；可選 count 欄位 probe `*_count`。
- Admin 模式 Ledger 讀取行 service-role 通道（`/api/admin/ledger/orders`，route 喺 `app/api/admin/ledger/orders`）；會員充值/扣點 RPC 需商戶 JWT → admin 仍空（已知限制）。

## 打印任務兩級狀態（2026-09-07 已實作）
- `pending`=待派發；`sent`=POS 已交付打印通道（relay 只代表入雲端隊列）；`printed`=通道回報真實出紙；`failed`。
- 已改：`status` route 唔再降格 `printed`→`sent`；print-center 回填 printed +「打印成功」filter/badge +「清除已成功」；`clearSentPrintJobs` 只清 sent；pos-app `onPrintJobUpsert` 容許 sent→printed/failed 升級。DB 生命週期 `pending→printing→printed/failed`；claim RPC 只揀 pending/failed → 天然防重印。relay 團隊交接見 `docs/handoff-print-relay-printed-status.md`（agent 真實出紙先報 printed、失敗必報 failed）。

## 執行環境判斷（原生殼 vs web/PWA）
- 唔用 UA sniff：Android APK → `window.PosNative.printJob`；PC 殼 → `window.companionShell`。
- companion 三層 gate 由嚴到寬：`shouldUseCompanionChannel`（淨原生殼）/ `shouldKeepCompanionAlive`（原生殼 OR `?companion=`，純 website 零 /api/health）/ `shouldAutoDiscoverCompanion`（原生殼 OR localhost）；`shouldShowCompanionUi` = autoDiscover || urlParam（純 web/PWA 隱藏成張卡）。UI 一定要包 localhost。
- client 讀 `window` 一律 mount-gated state（`null` 初始 + effect 設值），保 SSR=client 首 render。

## 全域滾動（body overflow hidden 鎖死，勿刪）
- `globals.css body{overflow:hidden}` 係 POS 內部 scroll 嘅前提。Admin 用 AdminShell `h-[100dvh] overflow-y-auto` 自做容器。**Shared 組件（restaurant-daily-report）要按模式分流**：admin → 內容 `block`（AdminShell 滾）；POS `/reports` → `min-h-0 flex-1 overflow-y-auto`（main 係 `h-[100dvh] flex flex-col overflow-hidden`）。反面教材：f1cc8ad 一刀切 block 令 POS /reports 滾唔到（已修返）。

## 開工/收工班次（2026-09-07 上雲，migration 0023）
- **真源 = `pos_shifts`**（一表一班次；active=`closed_at IS NULL`；每店一 active 由 partial unique index 保證；service_role only）。API `/api/pos/shift`：GET→{active,serverNow}；POST open（已有 active→conflict 以現有為準）/close/ackOvertime。
- 前端 `src/lib/shift-sync.ts reconcileLocalShift` 六場景（改前必讀）：①server active+本地無/時間唔同→adopt server；②server active+本地收工且 closedAt>=openedAt→補 close；③一致→只 sync ack；④server 無+本地開工中且 `serverSynced=false`→補 open（離線開工）；⑤**server 無+本地 serverSynced=true→人哋已收工，本地 reset（唔可以補 open，會死灰復燃）**；⑥其他 no-op。
- OT 提醒 `isShiftOvertimeDue(openedAt,ackedAt,serverNow)`：`now-opened≥10h && (ack null || now-ack≥10h)`，全用 server 時鐘；取消=ackOvertime（server `overtime_acked_at`），確認→router.push('/shift')。POS app 每 60s+網絡恢復+focus reconcile。
- `ShiftState` 已加 employeeAccount/employeeName/overtimeAckedAt/serverSynced。方案/驗證見 `docs/109-shift-sync-overtime-plan.md`。

## 開發注意事項
- JSDoc 內唔好寫 `macau-pos/stores/*/orders`（`*/` 提早結束 comment）；用 `&#123;storeId&#125;`。
- 報表組件 `agg` 喺 useMemo 下方；backfill effect 內唔可引用。
- `next build` 報 LayoutProps = `.next` generated types 過期，`rm -rf .next` 重 build。

## 環境
- Node 22.22.2-2（managed）、Python 3.13.12（managed）；Next.js 16.3.0 + Turbopack + Tailwind 4，詳見 AGENTS.md。
