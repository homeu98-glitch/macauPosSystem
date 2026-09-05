# 專案長期記憶（macauPos / macauPosSystem）

> 對話日誌見 `.workbuddy/memory/YYYY-MM-DD.md`。

## 報表模塊（`restaurant-daily-report.tsx`）嘅關鍵約定

- **狀態篩選 helper**：用 `isSaleCountable(o)`（已落地）取代舊嘅 inline `o.status === "settled" || ...`，統一口徑：線下 POS 只計 `settled`；帶 `onlineOrderId` 嘅單 `settled` 或 `paid` 都計；`refunded` / `partially_refunded` 一律唔計。
- **快照聚合（2026-09-04 定案）**：菜品銷售排行按「下單當時快照」聚合 —— key = `menuItemId|訂單內菜品名`，金額用訂單內快照價 `it.price`。快閃餐改名／改價（Ledger 菜品 ID 不變）時唔同名稱各自一行，歷史訂單唔會因改名對唔上當前餐牌。**唔好**改返用大類聚合或者強制對應當前餐牌名（已試過、用戶否決）。`buildMenuMeta()` / `resolveMenuMetaItem()` 而家只剩診斷面板用。
- **診斷匹配統計**：診斷面板嘅菜品配對統計只計 `isSaleCountable` 嘅訂單 —— cancelled 測試單嘅孤兒菜品（舊 Ledger UUID）唔計入去，否則「未匹配名單」會出現髒資料假象。
- **尖峰時段**：POS 線下單 `agg.byHour` + Ledger 線上單 `onlineByHour` 疊加成 `combinedByHour`。`onlineByHour` 由 `useEffect([merchantId, range])` 用 `listMerchantOrders` cursor pagination 抓，按「下單時間」createdAt 入帳。
- **線上單明細併入菜品排行**：`onlineDishSource: {order, items}[]`（逐張 `getOrderDetail()`，MAX_DETAILS=200）；`aggregate()` 第三參數 `onlineWithItems`，明細以「線上」渠道併 dishMap + 時長估算。用 `onlineDishKey`（訂單 ID join）做 effect 穩定觸發；effect 必須放喺 `countableOnlineOrders` 宣告之後（否則 render TDZ ReferenceError）。防雙計：`posOnlineIds`（POS `onlineOrderId` Set）剔除已同步單。
- **營運指標（2026-09-04 移除對比）**：「營運指標·同環比」已移除 POS vs Ledger 對比 row（`rev7dAvg`/`ledgerRev7dAvg`/`rev7dGap` 等變數已刪），只保留「營業額(7日均)/線上渠道佔比(7日均)/會員充值(7日均)/總售出份數」4 行，數據混亂無參考價值故移除。
- **人流 / 時長同線上單**：`computeFootfallFromOrders()`（`src/lib/restaurant-footfall.ts`）計 settled/paid（同 `isSaleCountable` 一致）；`footfallTotal = posFootfall + countableOnlineOrders.length`，後者用 POS `onlineOrderId` Set 剔除已同步單避免雙計。時長統計：`aggregate(orders, range, onlineOrders?)` 對 Ledger 純線上單用「createdAt → updatedAt」估算整體（estimated），依 fulfillmentType 分堂食／快餐桶；只有主 `agg` 傳線上單，aggYest/agg7d 唔傳。

## 報表數據來源嘅口徑

- **POS 訂單**：雲端補載 `/api/pos/state?storeId=<merchantId>&limit=2000&offset=...&ordersOnly=1&start=...&end=...`，分頁拉齊（MAX_PAGES=10）；雲端失敗先 fallback 本機 `loadOrders()`；雲端空 + 成功 → 顯示空狀態（**唔可以** fallback 本機，可能係舊 store 殘留）。
- **Ledger 線上單**：`listMerchantOrders` 用 cursor `since` + `sinceId` 分頁（PAGE=500、MAX_PAGES=8）。`paymentStatus !== "paid"` 或 status 含 "cancel" 一律跳過。
- **Ledger 總值**：`getMerchantReportSummary(r)` 涵蓋全渠道，orderCount / orderPaidMop 為權威值；KPI 大數優先用 Ledger，POS DB 補差額算線上部分。
- **日期邊界**：`macau{...}Range()`（`src/lib/ledger/report-period.ts`）統一用 Macau 邊界 ISO 字串，淘汰 `now.getTime() - 86400000` UTC-naive 寫法，消除凌晨跨午夜嘅 off-by-one。

## MerchantId / storeId

- `merchantId = staff_accounts.merchant_id`（UUID），唔係 `macau-store-a` mock。
- POS DB 用 `store_id`（FK to Ledger merchants.id），前端對應 `PosOrder.storeId`。
- 報表頁用 `useReportMerchantId()` 訂閱 `pos-auth-changed` event，切店即時更新；listener 觸發 `setOrders([]) + setBackfillSeq++` 強制重跑 backfill。
- 雙重保險：API `eq("store_id", storeId)` SQL 過濾 + 前端 `o.storeId === merchantId` 再核一次。
- **讀取端嚴格隔離（2026-09-04）**：`loadOrders(merchantId)` / `loadBootstrapCache(merchantId)` 按 store scope 精確讀；`belongsToStore()` 現為 **strict** `o.storeId === merchantId`（undefined storeId 嘅 legacy row 寧願丟棄，唔可以顯示喺錯店）。初始 orders 設空，避免 hydration 讀錯 scope。
- **載入門檻 `dataReady`**：POS 補載（`backfillDone`）+ Ledger 彙總（`ledgerDone`）都完成過先 `setDataReady(true)`；全部 section（`Card` 11 個 + KPI 帶 **7 格**（2026-09-05 由 6 升 7：加「會員扣點」）+ 模塊 9 自動化建議）套 `loading={!dataReady}` 顯示 `SectionSkeleton`（灰 block `animate-pulse` + 中間 `animate-spin` 轉圈）。切店 / 切帳號（`pos-auth-changed`）即時 `setDataReady(false)` 重置，避免閃現舊店資料。
- **Ledger 欄位分類（2026-09-05 完整對齊）**：`getMerchantReportSummary` 返回 5 大類強型別欄位 ——
  - topup：`topupMop` (= paid + gift) / `topupPaidMop` / `topupGiftMop`，對應 Ledger UI「實際充值 / 贈送入帳」
  - deduct：`deductMop` (= paid + gift) / `deductPaidMop` / `deductGiftMop`，對應 Ledger UI「扣點」
  - order：`orderCount` / `orderPaidMop` (= balance + in_store) / `orderBalancePaidMop` / `orderInStorePaidMop`，對應 Ledger UI「訂單數 / 訂單已收款 / 訂單餘額扣點 / 訂單到店付款」
  - 額外暴露 `rawAvos: Record<string, number>` + **一次性 module-level** `console.log` payload dump（每次 page load 只 dump 一次），用嚟搵 UI 未對應字段（例如「筆數」可能係 `topup_count` / `deduct_count`）。
  - 寫法：`normalizeAvosPayload()` 過濾出**數值**欄位（RPC 可能帶 `merchant_id` 等非數字），避免 console 噪音。
  - 注意 `console.table(label, record)` 撞 TS2769（`Record<string,number>` 唔合 overload），統一用 `console.log(label, rawAvos)`。
- **`60000003` 舊 demo 店（根因）**：`60000003` 係真實 merchant UUID（**唔係** hardcode、唔係 `macau-store-a`）。落單 `storeId` 來源 = Kiosk `binding.storeId`（localStorage `macau-pos-kiosk-device`）或掃碼 `?store=`；若呢啲被綁成 60000003，訂單就寫落 60000003（合法 merchant，寫入防護唔會擋）。讀取端已嚴格按 `store_id` 隔離，無「跨店串資料」bug；要修正寫入端就喺 A 店後台重新綁 Kiosk device（覆寫 `macau-pos-kiosk-device` 成 A 店 merchantId）／重新生成 `?store=<A店merchantId>` 掃碼 QR／確認 `loadAuthSession().merchantId` 係 A 店 UUID。

## 執行環境判斷（原生殼 vs 純 website/PWA）

- **判斷依據係原生殼注入嘅 bridge 標記，唔好用 userAgent sniff**：Android APK WebView → `window.PosNative.printJob`；PC Electron 殼 → `window.companionShell`（見 `pwa-install-button.tsx` 嘅 `isRunningInNativeShell()`）。
- `src/lib/print-bridge/companion.ts` 三層 gate，由嚴到寬，**唔好混淆**：
  - `shouldUseCompanionChannel()` = 淨原生殼（gate print dispatch 通道）。
  - `shouldKeepCompanionAlive()` = 原生殼 OR `?companion=` 參數（gate 輪詢 / 健康檢查，純 website 零 `/api/health` 請求）。
  - `shouldAutoDiscoverCompanion()` = 原生殼 OR localhost（gate 值唔值得探一次 loopback）。
  - `shouldShowCompanionUi()`（2026-09-05 新增）= `shouldAutoDiscoverCompanion() || hasCompanionUrlParam()`，gate 「桌面 Companion 代理」卡嘅顯示；純 website / Vercel HTTPS / PWA standalone 一律 false → 成張卡隱藏。UI 要包埋 localhost（輪詢唔使），否則本機 dev 測唔到。
- client component 讀 `window` 做環境判斷，一律用 mount-gated state（`useState<boolean|null>(null)` + `useEffect` 設值 + `if (!x) return null`），初始 null 保證 SSR HTML 同 client 首次 render 一致，否則 hydration mismatch。

## 開發注意事項

- JSDoc 註解入面唔好直接寫 `macau-pos/stores/*/orders`，`*/` 會被 TypeScript parser 當成 comment 結尾導致後續 syntax errors；用 `macau-pos/stores/&#123;storeId&#125;/orders`（HTML entity）繞過。
- `restaurant-daily-report.tsx` 入面 `agg` 由下方 `useMemo` 計算；喺 backfill effect 內唔可以引用（hooks 順序違規）。需要診斷菜品命中要直接用 `final` 訂單 + `buildMenuMeta()` 計算。
- `PosOrder.storeId` 喺 migration 唔齊時可能係 undefined；現行 `belongsToStore()` 已改 strict（見上方「讀取端嚴格隔離」），legacy undefined row 唔顯示喺錯店。
- `next build` 報 `LayoutProps` 錯誤通常係 `.next` 內 generated types 過期，刪掉 `rm -rf .next`（或 PowerShell `Remove-Item -Recurse -Force .next`）重 build 就得。

## 環境

- Node 22.22.2-2（managed）、Python 3.13.12（managed）
- 詳細工具說明見 `AGENTS.md`（Next.js 16.3.0 + Turbopack + Tailwind 4）