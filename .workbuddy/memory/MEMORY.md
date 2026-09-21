# macauPos 記憶（2026-09-19）

> 🔴 詳細逐條已移入 `docs/113-agent-gotchas.md`（**開工前必讀**）。本檔只留最高頻陷阱。
> POS=`iyrywzormzisyppkokbi`、Ledger=`zymdemjflsckicwcinxl`。已跑 0043，**未跑 0042**。
> ⚠️ 新增 `0044_pos_orders_range_indexes.sql`（未跑，見 §1）。

## 0. 🔴🔴 訂單「算邊日」＝ 唯一口徑 `orderEventInstant()`（2026-09-19 已修）
**唔准再直接讀 `order.createdAt` 或 `order.updatedAt` 判斷「呢張單屬唔屬於今日」。**
- 唯一真源：`src/lib/pos/order-event-time.ts` → `orderEventInstant()` / `orderEventISO()`。
  優先序 **`reopenedAt` → `originalSettledAt` → `updatedAt` → `createdAt`**（最後一次成為「生意」嗰刻）。
- 兩個 predicate（`orderMatchesReportRange` / `orderMatchesDateFilter`）**已一齊委派去佢**；
  顯示亦改讀 `orderEventISO()`（以往「顯示 `updatedAt`、篩選 `createdAt`」正係土壤）。
- 🔴 `fetchOrdersInRange()` 已加**第三條腿 `reopened_at`**（返結唔一定刷新 `updated_at`，
  兩腿版本會令「昨日開、今日返結」嘅單靜默消失）。索引見 migration 0044。
- 🔴 **`node --test` 唔認 extensionless import**：要跑單元測試嘅模組，整條 import 鏈都要
  **相對路徑 + 顯式 `.ts`**（`from "./date-range.ts"`）。Next/Turbopack/tsc 全部收。
- ⚠️ 已知未統一：`7d`/`30d` **邊界算法**兩邊仍唔同（訂單頁滾動毫秒、報表 Macau 日曆）。

## 1. 數字夾唔埋（最高頻誤判）
**四條載體、三種合併**：訂單（下單機）＝本機優先；訂單（第二台）＝`/api/pos/state` 純雲端；
交班＝本機+雲端 **LWW**（`mergeByUpdatedAt`，雲端 `>=` 贏）；**報表＝純雲端，永不 merge 本機**（對帳用）。
⇒ 報表 = 雲端真值，**唔可以**改佢 merge 本機。判別：報表 == 第二台機 ⇒ 兩者皆雲端真值。

**✅ 已修（2026-09-19）：報表 vs 訂單頁 double count**
- 病徵：`orderMatchesDateFilter` 讀 `createdAt`、`orderMatchesReportRange` 讀 `updatedAt`
  ⇒ 同一筆錢計兩次（實案 10 單 512 vs 實際 9 單 474、客單價 51 vs 52.67）。
- 修法：兩者一齊委派去 `orderEventInstant()`（見 §0）。迴歸測試
  `src/lib/ledger/report-range-criterion.test.ts` 核心＝「兩個 predicate 對同一張單必須畀同一答案」。
- ⚠️ 兩次誤判教訓：**唔可以憑「差額 = 某個看似合理嘅數」下結論**（先後誤判為退款、
  再誤判為 Ledger ghost）。**必須用真實 data 逐張加總，再對照 UI 實際顯示嘅時間欄位。**

**✅ 已修（2026-09-19）：KPI 帶混用毛／淨**
- 商家口徑：「實收＝實際收到嘅錢」＝**毛**。以往實收卡綁 `agg.netRevenue`（毛 − 退款），
  而營業額／客單價／毛利／應收／明細加總**全部係毛** ⇒ 有退款就夾唔到數。
- 修法：實收卡**改綁 `agg.paidTotal`（毛）**；退款摘要橫幅由 `refundCount > 0` 改**無條件顯示**；
  交班頁「淨實收」區塊同步改無條件顯示。
- ⚠️ 兩頁「淨」**方向相反**：交班 `netPaidTotal = 毛 + 退款單未退部分`（加）；
  報表 `netRevenue = 毛 − 退款總額`（減）。**唔可以互抄**。
- 資產 `src/lib/refund-net.ts`（可測）。

**返結時間口徑**：`settledAt = o.reopenedAt ?? o.originalSettledAt ?? o.updatedAt`
（三處：`shift-page.tsx:662`／`restaurant-daily-report.tsx:488`／`pos-app.tsx:5279`）。
`originalSettledAt`＝首次結帳、永不改，**唔可以**當「最後結帳時間」。

## 2. 返結（反結賬）四條鐵律
1. **同機顯示正常 ≠ 已上雲** ⇒ 返結後必查雲端 `reopen_count`。
2. 狀態必須維持 **`reopened`**（唔喺任何狀態集合 ⇒ `isPaidDowngrade` 放行；帶成 `paid` 反而危險）。
   `upsertCurrentOrder` 嘅 `keepPaidStatus` 必須同認 `paid` **同** `reopened`（`pos-app.tsx:2406`），
   否則加菜變 `sent_to_kitchen` ⇒ 付款閘拒收 ⇒ **items 永不上雲**（雲端「舊數量＋新金額」）。
3. 審計三欄 `reopen_count`/`reopened_at`/`reopen_reason` **單調遞增、重結唔清零**。
4. 🔴🔴 **加 pos_orders 欄位要改「四條讀取路徑」**：`pos-order-mapper.ts`（realtime/KDS）／
   `pos-order-row.ts`（`/api/pos/state`）／`/api/pos/orders` **內聯 mapper**（報表）／
   `sync/route.ts` `baseRecord`。漏一條＝靜默唔出。
- 已修：`reopenPosOrder()` 從不推播上雲；`ORDER_SETTLED` payload 冇帶 `reopenCount`（server **讀頂層**）。
- 標籤＝`reopen-badge.ts`（**零 import**，6 test）；**只看 `reopenCount`，唔看 `status`**；色＝indigo。
- ⚠️ `reopenedBy`/`originalSettledAt` **冇上雲**；歷史單 `reopen_count` 仍 0 ⇒ 標籤唔出。

## 3. API 鑑權
- 加閘 `posRouteAuthGuard(request, storeId, tag)`，放喺「未配置 Supabase／缺 storeId」early-return **之後**；
  客戶端 `posDeviceAuthHeadersFresh()`。09-17 實測**閘已 enforcing**。
- 🔴 `POS_REQUIRE_DEVICE_AUTH` **冇設＝開閘**（空值回 true）。「冇設」≠「關閉」。
- **匿名端點（唔可加閘）**：bootstrap GET、sequence、sync 匿名通道、ledger/member-login、
  order-lookup、kds/*、print-agent/pair。
- 🔴 開閘擋唔到 DB：anon key 係公開變數 ⇒ 直打 PostgREST 讀到 pos_orders 近 14 日明細。
  根治＝per-store token（0041§3 未做）。探測：`tools/_probe-*-20260917.cjs`。

## 4. 打印／中繼
- 建單/接單後必須 `appendPrintJobsWithSync()`；淨 `savePrintJobs()`＝零出紙。
- 出紙只喺**內容事件**；轉換/採納/排位唔出紙。
- 🔴🔴 **同一張單重複出紙（2026-09-21 實案：4 張收據）＝ 內容唯一鍵 `onceKey`**：
  `PrintJob.id` 係 randomUUID ⇒ `mergePrintJobs` 只按 id **永遠攔唔到**；唯一守衛（60s in-memory Set）
  係 **per 瀏覽器 realm**（開兩個視窗各自放行）。已加 `src/lib/pos/print-dedupe.ts`（零 import）
  ＋帳本 `printedOnceKeys`（跨視窗）＋雲端 `pos_print_jobs.once_key` 唯一索引（**migration 0045 未跑**）。
  收口＝`claimOncePrintJobs()`；⚠️ `pos-app.tsx` 有 3 處繞過收口（`enqueuePrintJobs`、落單 `persistPrintJobs`）。
  自動路徑 onceKey 必帶世代（`reopenCount`）；廚房單必帶內容簽名；手動／加菜／退菜／返結／標籤**唔帶**。
  「排位」會經 Ledger echo 間接出收據（`syncOnlineDineInCompletion` → completed）。
  取證：`tools/_probe-dup-receipt*.cjs`（唯讀查 `pos_print_jobs`）。
- 🔴 判失敗真因睇 `last_error`：`failed to connect to /<印表機IP> from /<中繼IP>` ⇒ 網段不通；
  `dispatch failed` ⇒ 跑 `macau-ledger-merchant`（源碼 `C:\dev\_ref-macau-ledger-merchant`）。
  中繼機同印表機須同網段（192.168.31.x／10.61.x／172.20.10.x）。
- 🔴 **`paired:true` ＝ DB 有 agent 列 ＝ 歷史事實，唔等於在線**；在線睇 `last_seen_at`（~30s）。
- 🔴 「配對失敗：POS 雲端未設定」＝**垃圾桶文案**（三種無關原因同一句）。真兇＝
  `PosPairingManager.kt:65-68` restorePairing 要求 `status=="paired"`，agent 被撤銷⇒永遠 pending。
  **唔使改 Vercel／唔使重裝 APK**。
- 🔴 判死活要打 `GET /api/pos/print-agent/pair-status?storeId=` 讀 lastSeenAt 對照最後 claimed_at；
  唔可睇 `/prints` 嗰句「N 分鐘前」（前端計算、會膨脹）。
- 🔴 爆紙：先 `select pos_void_stale_print_jobs('<storeId>')`。回 0 ≠ 清乾淨（`ttl IS NULL` 永遠掃唔到）。
- ⚠️ `print-relay` `fetchDeviceConfig()`（`RelayApi.kt:221`）**冇帶憑證**（定時炸彈）。
- ⚠️ 「堂食測試印」繞過 runner 直接 sendRaw ⇒ 出紙 ≠ 配對正常。

## 5. 訂單／交班
- 結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱），唔准全店 find()。
- 已收款單加菜必須保留 `paid`。🔴 孤兒單號 `print-xxxxxxxx`＝本機 localStorage，
  **從未上雲**（雲端掃 `print-%` 必然 0 rows）；「還原」係陷阱 ⇒ 應「永久刪除」。
- 🔴 **交班三條互不相干軌道**：`pos_shifts`（班次，只擋收銀台）／`pos_store_status.is_open`（線下接單）／
  Ledger `merchant_enabled`（線上接單）。`closeShift()` 唔碰任何接單開關。
- 關店總掣＝`close-gate.ts`（純決策，零 import）＋`close-gate-run.ts`：先線下後線上／
  線下失敗**唔 return**／`null`＝`skipped`／永遠唔 throw；必須排喺 `closeShift()` 兩個 early return **之前**。
- 🔴 `pos_store_status` 冇 row＝**營業中**；`pos_shifts` 冇 open row＝**未開工**（方向相反）。
  兩者都係「**查詢失敗**」才 fail-open。`shop-closed` 同 `shift-closed` 文案**唔可撈埋**。
- 🔴 殘留警示 `residual-channel.ts`：**`null`（未讀到）永遠唔觸發**（否則斷網出假警報）。

## 6. UI／環境（硬性）
- 🔴 KPI 帶**固定 5 欄、格數必須係 5 嘅倍數** ⇒ 新指標寫入既有格 subtitle，唔可另開卡片。
- 🔴 `button { font: inherit }`（globals.css 無 layer）壓過 `text-*` ⇒ 按鈕字級寫喺仔元素。
- 🔴🔴 `npm test` ＝ `node --test`，**唔認 `@/` 別名、唔行 bundler、唔支援 `.tsx`**。
  可測模組必須**零 import**；純邏輯同「有 import 嘅執行層」**一定要分檔**。
  跑全測試：`node --test "src/**/*.test.ts"`。
- npm/npx 跑唔到；冇 coreutils ⇒ 用 Read/Glob/Grep 或 node fs；複雜 JS 寫 `.cjs`。
- git 全路徑 `…/PortableGit/versions/1.2.0/cmd/git.exe`；push 加 `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never`。
- 🔴 Vercel 改 env 要 Redeploy 才生效。⚠️ eslint 本機極慢 → `run_in_background`。
- 同檔唔可同一 message 發多個 Edit。Glob 唔索引工作區外。

## 7. 判別／取證
- 收入 `isSaleCountable()`：只計 settled／帶 onlineOrderId 嘅 paid；日期用 Macau 邊界。
- 雲端讀到＝唯一可信源；store 隔離 `o.storeId === merchantId`。
- 線上接單＝Ledger `merchant_enabled`／線下＝`pos_store_status.is_open`，唔准同名同色。
- 🔴 訂單 id 前綴＝邊個程式建單：`order-`＝收銀台/快餐／`staff-`＝店員手機／`kiosk-`＝自助機／
  `ledger-<id>`＝線上鏡像。收銀台永遠唔出「自助點餐機」徽章。
- 🔴 訂單列表顯示時間＝**最後更新**，非建立時間；判建立睇 `pos_orders.created_at`。
- 🔴 事件 payload 兩形狀；拆解唯用 `src/lib/pos/sync-order-payload.ts`，唔准 route 內再寫一份。
- 🔴 `storeId` 係公開值（枱 QR `?store=`）⇒ kiosk 手動輸入＝**無密碼落單入口**；
  關「自助點餐機」模組擋唔到嘢（allowedModules 純 UI 導覽）。
- 🔴 Vercel log CSV 冇 IP 欄 ⇒ 靠 `sync/route.ts:375` `console.info(ip=…)`（只在 auth 開著時執行）。
- 時間軸一律換算 Macau(+8)。

## 8. 🔴🔴 Supabase Egress（2026-09-21：一間店用爆 5 GB 免費額度）
- 實測：**PostgREST 98.8~99.3%**／Realtime 0.7~1.2%／Auth ~0／Storage+Edge = 0。
  ⇒ **唔可以為省流量關 Realtime**（只佔 1%，關咗即時性全失）。
- 🔴 計費口徑：PostgREST egress ＝ **Supabase → Vercel Function** 嗰段，**唔係** → 瀏覽器。
  改 route response／壓縮**對帳單零幫助**；只可以「令 PostgREST 回少啲 bytes、回少幾次」。
- per-row 實測（`tools/_egen-estimate-20260921.cjs`）：`pos_orders` 帶 items **1 469 B**；
  `pos_queue_events` **1 668 B**；`pos_print_jobs` **1 165 B**；只投影 `id,status,updated_at` ＝ **91 B（16×）**。
  單次：全量 state **0.98 MB**／守護全店拉 **7 MB**／報表一頁(2000×3腿) **8.4 MB**／KDS 板 **0.42 MB**。
- 四大元兇（頻率 × 大小）：
  ① 對賬守護 `fetchServerOrders(storeId, **null**)`（`sync-reconcile-daemon.ts:207`）＝ 冇日期下限 + limit 5000，
     而 `RECONCILE_ACK_TTL_MS=10min` ＋ `MAX_ORDERS_PER_ROUND=100` ⇒ ⌈N/100⌉ 輪**每輪都再拉 7 MB**。
     ⚠️ 已有 `computeServerRangeStart()` 但守護冇用。504 MB~2.5 GB／日。
  ② ⚠️ **KDS 睇門狗唔係「未用都跑」**：`useKdsBoard` 只喺 `app/kitchen`、`app/expo` 兩個 page 渲染 ⇒
     **route-scoped，冇開頁就零拉取**（2026-09-21 商家已停用 KDS ⇒ 成本 0）。佢 15s tick、靜 60s 就拉，
     `refresh()` 自己更新 lastEventAt ⇒ 開住時實際每 60s 拉全板 ≈0.42 MB（302 MB／日）。重開 KDS 前要改。
     🔴 對比：**真正「唔用都照燒」嘅只有對賬守護** —— `PosSyncFlushWorker` 掛 `app/layout.tsx:70`（root layout），
     `installSyncReconcileDaemon()` 零條件，任何頁面都裝。其他都係「開住某頁先燒」：
     打印中心 `/prints` **每 8 秒**（≈40 KB／次，長開一晚 ≈0.4 GB）、報表 **每 3 分鐘**。
  ③ 報表 3 分鐘自動刷新 × `PAGE=2000`×10 頁 × **三條時間腿**（`pos-orders-range.ts:85-96`）。
  ④ 全量 state 每次都查 300 條 queue（≈500 KB）**而 v2 之下 client 根本唔用**（`pos-app.tsx:1209`）；
     `local-orders-panel.tsx:239` 拉 state **漏帶 `ordersOnly=1`**，且每張單 enqueue 都 fire queue-changed → 佢就拉。
- 🔴 修正後排名（2026-09-21，商家確認停用 KDS）：**對賬守護 75~95% ≫ 報表／全量 state／打印中心**。
  估算：一日 30 單 → 7 日窗口 ≈210 張終態單 → 每 10 分鐘 3 輪 × 7 MB ⇒ 126 MB／hour ⇒ 開 10h ≈1.26 GB／日，
  同實測 1.29 / 1.47 GB 吻合 ⇒ **守護單獨就解釋得晒**。
- 🔴 睇用量圖**一定要先睇右上 filter**：`All projects` ＝ 整個 org（POS ＋ Ledger 兩個專案）總和，
  要逐個專案切換睇。POS app 亦會讀 Ledger（`list_merchant_orders` RPC：`paid-orders.ts` 最多 8×200 行、
  報表 `restaurant-daily-report.tsx:1694` 最多 8×500 行／每 3 分鐘）。
- 判別：`pg_stat_statements` 按 **rows** 排序（rows 大＝egress 大）＋ Vercel log 數 `/api/pos/state`
  （`limit=5000` 且冇 `start=` ＝ 守護）。報告：`docs/reviews/supabase-egress-root-cause-2026-09-21.md`。
- 🔴 **兩條軌要分開治**（2026-09-21 加 Vercel 數據後）：
  · **Supabase egress** ← 睇 **payload 大小** ⇒ 守護全店拉取 ／ 三腿 ×2000 ／ queue 白拉。
  · **Vercel invocations** ← 睇 **請求次數** ⇒ 🔴 **`/api/topup/pending-count` 每 30 秒**
    （側欄紅點！`app-sidebar.tsx:113` 掛 `pos-app.tsx:4716`，每次打 Ledger Auth + 2 select + **外部 topup 站 HTTP**）
    ≈1 440 次／日 ≈ 23% invocations；其次班次同步 60s（720／日）、打印中心 8s、報表 3min。
  · 交叉校準：Supabase PostgREST 回 6.07 GB vs Vercel Fast Origin Transfer 3 GB ⇒ 同批請求兩端，**診斷成立**。
- 🔴 **頂up 專案歸屬**：`/api/topup/*` 打 **Ledger**（`prepareLedgerServerClient`），
  所以 topup 輪詢**唔會**計入 macauPos egress，但**會**計 Vercel invocations。唔可以撈埋。
- 落實方案（含逐項 diff）：`docs/reviews/egress-optimization-plan-2026-09-21.md`。
- ✅ **2026-09-21 已落實**（詳見 `docs/reviews/egress-optimization-implemented-2026-09-21.md`）：
  守護投影+日期下限+每日 120 次上限；`?skipQueue=1`；`pos_orders_page` RPC（0046，未跑）；
  `fetchOrdersInRange` 預設投影；頻率（TTL 60min／報表 10min／打印中心 30s／badge 5min／班次 180s）；
  `[egress]` log。驗證：tsc 0 error、**892 test 全綠**、eslint 0 新增。
- 🔴🔴 **投影欄位清單必須同 `PosOrderDbRow` 由測試雙向焊死**（`pos-order-row.test.ts`）：
  漏欄 ＝ 靜默唔出（中過兩次：`discount_note`、`reopen_*`）；多欄 ＝ 42703 整個查詢失敗
  （已有自動降級 `select("*")`）。新增欄位只改 `PosOrderDbRow` ＋ `POS_ORDER_DB_COLUMNS` 兩處。
- 🔴 `pos-orders-range.ts` 有 `import "server-only"` ⇒ `node --test` **載入唔到**
  ⇒ 決策邏輯一定要抽去零 import 模組（`src/lib/pos/orders-range-shared.ts`），否則新邏輯零回歸保護。
- 🔴 降級鏈：RPC →（PGRST202/42883）三腿 →（42703/PGRST204）`select("*")`；
  **真 DB 錯誤（超時/權限）一律唔降級、如實上報** —— 否則會被靜默吞成「今日冇單」。
- 🔎 對帳捷徑：Supabase log CSV 冇 bytes 欄，但 `event_message` 有**完整 URL**
  ⇒ 用 `tools/_analyze-supabase-logs-20260921.cjs` 還原查詢形狀（`select=`／`limit=`／`order=`）。
  另：Supabase PostgREST 請求數 ÷ Vercel Function Invocations ≈ **8.7**（一次全量 state ＝ 7~8 條查詢）。
- ✅ **commit 前煙霧測試**（2026-09-21 新增，可重用）：
  · `tools/verify-pos-flows-live.cjs` — 真瀏覽器巡 17 條路由（點餐／打印／設置／報表／後廚…），
    檢查 http／pageerror／卡死標記；先開 `next dev -p 3017`。
  · `tools/verify-pos-api-contract.cjs` — API 契約回歸（新 query param 唔可以改舊回應）。
  ⚠️ 兩個都**唔可以**用 `127.0.0.1`（Next 16 封鎖跨來源 dev 資源），一定用 `localhost`；
  ⚠️ API 契約測試要 `POS_REQUIRE_DEVICE_AUTH=0`，否則一律 401 測唔到。
  ⚠️ 殺 dev server 後要刪 `.next/dev/types/validator.ts`（會被截斷 → 假 tsc error）。
- 🔴 改任何「週期常數」（刷新間隔／TTL）之後，**一定要 grep 用戶可見文案**：
  2026-09-21 就係改咗 `AUTO_REFRESH_INTERVAL_MS` 但報表標題仍然寫死「每 3 分鐘自動更新」。
  正解＝由常數推導（`Math.round(X / 60_000)`），唔好寫死。
