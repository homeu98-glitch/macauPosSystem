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
  守護投影+日期下限+每日 120 次上限；`?skipQueue=1`；`pos_orders_page` RPC；
  `fetchOrdersInRange` 預設投影；頻率（TTL 60min／報表 10min／打印中心 30s／badge 5min／班次 180s）；
  `[egress]` log。驗證：tsc 0 error、**892 test 全綠**、eslint 0 新增。**已 push（`9d8e1d5`）＋ Vercel Production 已上線**。
- **Migration 狀態（2026-09-21 更新）**：**已全部跑齊＝0036 / 0042 / 0043 / 0044 / 0045 / 0046**。
  ⇒ 0046 生效後**三條時間腿已完全消失**（實測：守護 limit=5000 三腿 10→**0**、
  state limit=200 三腿 44→**0**、報表 limit=2000 三腿 2→**0**、`rpc/pos_orders_page` **0→65**）。
  ⇒ 0036 生效後，`online_order_settings` 4 欄 legacy 重試由 55→23 並於 13:34 後歸零。
  ⚠️ **仍有裝置跑舊 bundle**（未 reload）⇒ 全量拉取仍然連 queue 一齊拉（`queue GET limit=300` 60 次／6 分鐘）。
  叫商家 reload／重啟 POS APP 之後該項應歸零。
- 🔴🔴 **日誌解讀陷阱**：Supabase log 記嘅係 **PostgREST** URL，**唔會**出現我哋自己嘅
  `ordersOnly` / `skipQueue` / `fields` 參數 ⇒ 喺 Supabase log 搜呢啲字串必然係 0，
  **唔代表冇生效**。要驗 `skipQueue`：① Vercel log 嘅 `[egress] pos/state`（會印 `skipQueue=`／`queue=`／`ip=`）；
  ② 睇 `queue GET limit=300` 有冇變 0（間接）。`limit(0)` 版本 **就係** skipQueue/冇 storeId 嘅路徑。
- 🔎 **before/after 對比工具**：`tools/compare-egress-logs.cjs <before.csv> <after.csv>`
  （逐項核對：守護 limit=5000 三腿／state limit=200 三腿／RPC 有冇出現／queue 白拉／
  online_order_settings legacy 重試／print_jobs），全部換算「每小時次數」以抵銷窗口長度差異。
- 🔎 部署驗證工具：`tools/verify-deployed-bundle.cjs`（掃線上 chunk 找版本標記字串）。
  ⚠️ lazy chunk（AuthGuard 後面嘅 `pos-app`）唔會出現喺 HTML，掃唔到**唔等於**未部署；
  server-only 改動更加唔會出 bundle ⇒ 只可以用 commit／deployment sha 對照（GitHub API）。
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
- 🔴 `pos_queue_events` upsert 曾係**逐事件**做（`sync/route.ts` 個 `for` 之內）⇒ N 事件 = N POST。
  ✅ **2026-09-21 已修**：loop 內只收集，loop 完**先去重再分批**（`QUEUE_EVENTS_UPSERT_CHUNK=100`）
  一次過寫 ⇒ 日常 N→**1**。實作／測試喺 `src/lib/pos/queue-event-batch.ts`（零 import、
  client 由參數注入 ⇒ 可用假 client 測「25 事件 → 1 請求」）。
  🔴 兩個死穴：① **一定要去重**（同批重複 id → Postgres **21000** → **整批**審計行靜默寫唔入）；
  ② **一定要 `await`**（Vercel function return 後凍結，fire-and-forget write 會消失）。
  失敗只 push `warnings`，**唔可以**入 `infraErrors`（否則成批回 500 → client 重推已成功事件）。
  ✅ **上線驗證（commit `48b7571`，2026-09-21 14:28）**：`queue_events` POST
  150 次/20.7min → **28 次/15.3min（−81%）**；`online_order_settings` legacy 4 欄 23 → **0**。
- 🔴🔴 **頭號 egress 來源（2026-09-21 Vercel log 實測）：`/api/pos/state` 全量拉取
  （`mode=full`，一次打 6~8 條 PostgREST）＝ 計 103 次／9 分鐘、平均 857 KB/次 ⇒ 80 MB
  （佔該窗口全部 egress 96%）。**
  🔎 **觸發來源已鎖定＝realtime 重連補拉**（`usePosRealtime` `onResubscribed` → `loadRuntimeState()`）。
  證據：全量請求嘅**秒級間隔中位 4.47 秒**（3–4s ×33、4–6s ×44、6–10s ×19）、持續 9 分鐘、
  **冇任何兩次喺同一秒** ⇒ **timer-like 循環，唔係人手點**。
  成因：channel 反覆「訂上→即斷」（**Safari 背景分頁會殺 WebSocket**），
  而每次成功訂上都 reset `reconnectAttempt` ⇒ 重連永遠 3 秒；配合
  `RESUBSCRIBE_DEBOUNCE_MS = 3000` 就形成穩定 3~4.5 秒循環。
  ✅ **2026-09-21 已修**：新檔 `src/lib/pos/resubscribe-guard.ts`（零 import、12 條單測，
  含「背景 103 次重連 → 0 次拉取」模擬）＋ `pos-app.tsx` 喺 `onResubscribed` 加兩道閘：
  ① **分頁隱藏唔拉** ② **距上次全量拉取 <30s 唔拉**（`RESUBSCRIBE_BACKFILL_MIN_GAP_MS`）。
  🔴 **唔可以漏嘅論證**：返前景 → `visibilitychange` → `subscribe()` → `SUBSCRIBED` →
  callback 再跑（此時 visible 且已隔足）⇒ **一定補到**，唔會漏事件。
  🔴 **守衛只可放 `onResubscribed`**，唔可以放 `loadRuntimeState()` 內 ——
  mount／手動更新／`backToTables()` 都係刻意即時刷新，加節流＝功能問題。
  ⚠️ 仍未做：`backToTables()`（人手步速，非循環）、`usePosRealtime` 嘅
  `visibilitychange → subscribe()` 會拆掉再建 channel（WebSocket churn，Realtime 只佔 ~1%）、
  `/api/online-order-settings` thundering herd（實測 3 分鐘 53 次）。
- 🔴 **舊 bundle 裝置**：Vercel log 顯示 **Mac Safari 111/113 次請求冇 `skipQueue`**
  （Windows Chrome 8/18 有）⇒ 嗰部 Mac 仍跑舊 JS。reload 後 **857 KB → 424 KB（−50%，實測）**。
- 🔴 **關店後仍然持續嘅呼叫盤點（2026-09-21 實測，詳見 `docs/reviews/always-on-calls-inventory-2026-09-21.md`）**
  · **全量 state 拉取仍然係最大項**：35~40 次／24 分鐘（每 ~36 秒），
    指紋 `queue GET ≈ printJobs GET ≈ device_configs ≈ templates ≈ note_presets ≈ orders RPC`。
  · **`print-agent` 相關（APK okhttp）**：`pos_print_agents` GET 70（`verifyAgent`）＋ PATCH 44（心跳）
    ＝ **每 33 秒一次心跳**（設計文件 `docs/97:123` 寫 60s ⇒ 實測係兩倍頻率）；
    `rpc/pos_claim_print_jobs` 22 ＝ **每 65 秒 claim 一次**。
  · `pos_print_jobs` PATCH 28（sync 寫狀態）、POST 14（新 print job）。
  · `pos_shifts` GET 5（180 秒班次同步）。
- 🔴🔴 **`claim` 其實已經係 heartbeat**：`claim` route 每次都 `verifyAgent()` → `loadPairedAgent()`
  → **SELECT `pos_print_agents`（驗存在／未 revoke／token 正確）**；而 `heartbeat` 唯一多做嘅係
  `update last_seen_at`（`heartbeat/route.ts:24-27`）。⇒ 用戶直覺正確：**claim 成功已構成心跳**。
  · 服務端可做（**零 APK 改動**）：① 把 `last_seen_at` 蓋章搬入 `pos_claim_print_jobs` RPC（零額外 round trip）
    ② 或 `loadPairedAgent()` 由 `select` 改 `update(...).select(...)`（順手蓋章，每次由 2 query 變 1）。
    ⚠️ ② 係「讀換寫」trade-off，唔係純賺。**要真正省請求就要改 APK**（停止獨立 heartbeat）＝ −77%。
    ✅ **2026-09-21 已實作（② 嘅限定版）**：`loadPairedAgent(agentId, { recordActivity })` / `verifyAgent(..., options)`
    —— **預設純讀**，只有 **POST 路由**（heartbeat / claim / result）傳 `true`。
    heartbeat 由 **2 query 變 1 query**（`update … returning` 同時驗證＋蓋章，原本嘅獨立 UPDATE 已移除）；
    claim / result 順手蓋章（query 數不變）⇒ **成功嘅 claim 正式兼任心跳**。
    🔴🔴 **原版「改 `loadPairedAgent` 本身」做唔得**：`device-config` 同 `print-agent/pair` **都有 GET 路由**
    用同一個 helper ⇒ 會令 GET 寫入（違反 HTTP 語義；預取／重試／爬蟲會意外改寫 `last_seen_at`）。
    由 `src/lib/print-agent-server.test.ts`（source 掃描）守住：GET 路由唔可以出現 `recordActivity`。
    🔴 **一定要保留降級**：蓋章失敗**唔可以**當「驗證失敗」（驗證失敗回 401 ⇒ **APK 清配對、返配對畫面**！
    一次 UPDATE 鎖超時就會令收銀機要重新配對）⇒ update 失敗即退回純讀再驗一次。
- 🔴 **心跳頻率硬約束**：`last_seen_at` **只用於顯示**（全 repo 只有 print-center 讀、冇 server 邏輯靠佢撤銷），
  但 `print-center.tsx:1789` 寫死 **`minutesAgo >= 5` 就標「疑似離線」**
  ⇒ **心跳放慢上限 2~3 分鐘**；要 5 分鐘以上必須同時改呢個 UI 閾值。
- 🟠 其他可收口（未做）：`online-order-settings` thundering herd（實測 3 分鐘 53 次，多 hook 各自 mount）、
  `pair-status` 已配對後可停輪詢、`topup/pending-count` 可再放慢（純 badge）、
  `pos/shift` 關店後可停。**唔可以動**：`POST /api/pos/sync`、`/api/pos/store-status`、Realtime。
- 🔎🔎 **Vercel log 匯出＝最強驗收工具**（`tools/analyze-vercel-log.cjs`）：
  有 `requestQueryString`（睇得到 `skipQueue`／`ordersOnly`／`fields`，Supabase log 冇）、
  `requestUserAgent`（分裝置）、同我加嘅 `[egress] … bytes=N`（實際 bytes，可直接加總）。
  🔴 **一定要按 `requestId` 去重**：Vercel 匯出**每個請求 3 行**（只 1 行有 message）
  ⇒ 唔去重會報大 3 倍，並製造「無 query string」嘅假分組。
  📐 實測單次 bytes：全量無 skipQueue **857 KB**／全量有 skipQueue **424 KB**／
  報表 ordersOnly **266 KB**／**守護 `ordersOnly+fields` 20 KB**（修前 ~7 MB ⇒ **−99.7%**）。
- 🔴 **幻影欄位**：`pos_orders` 嘅 `refund_records`／`refunded_amount`／`voided_items` ——
  **44 條 migration 全部冇定義、全 codebase 冇任何寫入**（camelCase 版 `refundRecords` 等係 `PosOrder` 欄，
  但 server 從不寫入 snake_case 欄）。`sync/route.ts:575` 每次試 9 欄 → 42703 → fallback 6 欄
  （`isMissingColumnError` 已處理，**功能正常**），但每個 sync 請求白打一次註定失敗嘅查詢
  ＋ 產生一條 Error 級 Postgres log（dashboard 嘅「Error 7」就係呢類）。
  ⚠️ **唔好加 migration 補欄**（加咗都永遠 null，因為冇人寫入）——
  正解係**移除嗰 3 欄**（fallback 本來就用 6 欄 ⇒ **行為完全等價**）。
  若真要做退貨審計，要當一個完整 feature（加欄 + 寫入 + 讀取）去做。
