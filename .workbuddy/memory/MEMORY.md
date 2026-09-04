# 專案長期記憶（macauPos / macauPosSystem）

> 對話日誌見 `.workbuddy/memory/YYYY-MM-DD.md`。

## 報表模塊（`restaurant-daily-report.tsx`）嘅關鍵約定

- **狀態篩選 helper**：用 `isSaleCountable(o)`（已落地）取代舊嘅 inline `o.status === "settled" || ...`，統一口徑：線下 POS 只計 `settled`；帶 `onlineOrderId` 嘅單 `settled` 或 `paid` 都計；`refunded` / `partially_refunded` 一律唔計。
- **大類聚合**：菜品銷售排行已改為按 `MenuItem.categoryId → MenuCategory.name` 聚合（`MenuMeta` + `buildMenuMeta()`）。對照唔到嘅菜品 fallback 用菜品 ID 當 key，UI 用「未匹配當前菜單」badge 提示用戶（用嚟搵 60000003 等外店污染）。
- **尖峰時段**：POS 線下單 `agg.byHour` + Ledger 線上單 `onlineByHour` 疊加成 `combinedByHour`。`onlineByHour` 由 `useEffect([merchantId, range])` 用 `listMerchantOrders` cursor pagination 抓，按「下單時間」createdAt 入帳。
- **營運指標方案 B**：同時顯示 POS 7 日均（`rev7dAvg`）同 Ledger RPC 7 日均（`ledgerRev7dAvg = ledger.d7.orderPaidMop / 7`），並加 `POS vs Ledger 差距` row（正數 = POS 漏計線上單）。

## 報表數據來源嘅口徑

- **POS 訂單**：雲端補載 `/api/pos/state?storeId=<merchantId>&limit=2000&offset=...&ordersOnly=1&start=...&end=...`，分頁拉齊（MAX_PAGES=10）；雲端失敗先 fallback 本機 `loadOrders()`；雲端空 + 成功 → 顯示空狀態（**唔可以** fallback 本機，可能係舊 store 殘留）。
- **Ledger 線上單**：`listMerchantOrders` 用 cursor `since` + `sinceId` 分頁（PAGE=500、MAX_PAGES=8）。`paymentStatus !== "paid"` 或 status 含 "cancel" 一律跳過。
- **Ledger 總值**：`getMerchantReportSummary(r)` 涵蓋全渠道，orderCount / orderPaidMop 為權威值；KPI 大數優先用 Ledger，POS DB 補差額算線上部分。
- **日期邊界**：`macau{...}Range()`（`src/lib/ledger/report-period.ts`）統一用 Macau 邊界 ISO 字串，淘汰 `now.getTime() - 86400000` UTC-naive 寫法，消除凌晨跨午夜嘅 off-by-one。

## MerchantId / storeId

- `merchantId = staff_accounts.merchant_id`（UUID），唔係 `macau-store-a` mock。
- POS DB 用 `store_id`（FK to Ledger merchants.id），前端對應 `PosOrder.storeId`。
- 報表頁用 `useReportMerchantId()` 訂閱 `pos-auth-changed` event，切店即時更新；listener 觸發 `setOrders([]) + setBackfillSeq++` 強制重跑 backfill。
- 雙重保險：API `eq("store_id", storeId)` SQL 過濾 + 前端 `o.storeId === merchantId` 再核一次（legacy row 冇 storeId 保留）。

## 開發注意事項

- JSDoc 註解入面唔好直接寫 `macau-pos/stores/*/orders`，`*/` 會被 TypeScript parser 當成 comment 結尾導致後續 syntax errors；用 `macau-pos/stores/&#123;storeId&#125;/orders`（HTML entity）繞過。
- `restaurant-daily-report.tsx` 入面 `agg` 由下方 `useMemo` 計算；喺 backfill effect 內唔可以引用（hooks 順序違規）。需要診斷菜品命中要直接用 `final` 訂單 + `buildMenuMeta()` 計算。
- `PosOrder.storeId` 喺 migration 唔齊時可能係 undefined；`belongsToStore()` 保留 legacy row（唔可以 strict equal merchantId）。
- `next build` 報 `LayoutProps` 錯誤通常係 `.next` 內 generated types 過期，刪掉 `rm -rf .next`（或 PowerShell `Remove-Item -Recurse -Force .next`）重 build 就得。

## 環境

- Node 22.22.2-2（managed）、Python 3.13.12（managed）
- 詳細工具說明見 `AGENTS.md`（Next.js 16.3.0 + Turbopack + Tailwind 4）