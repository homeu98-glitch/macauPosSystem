# macauPos 記憶（2026-09-21 整理版）

> 🔴 詳細逐條：`docs/113-agent-gotchas.md`（**開工前必讀**）。
> POS=`iyrywzormzisyppkokbi`、Ledger=`zymdemjflsckicwcinxl`。
> Migration **0036 / 0042 / 0043 / 0044 / 0045 / 0046 全部已跑齊**。

## 0. 訂單「算邊日」＝唯一口徑 `orderEventInstant()`
- 真源 `src/lib/pos/order-event-time.ts`；優先序 **`reopenedAt` → `originalSettledAt` → `updatedAt` → `createdAt`**。
- 兩個 predicate（`orderMatchesReportRange` / `orderMatchesDateFilter`）＋顯示**已全部委派去佢**。
  「顯示 `updatedAt`、篩選 `createdAt`」曾令同一筆錢計兩次（實案 10 單 512 vs 9 單 474）。
- `fetchOrdersInRange()` 有**三條腿**（`created_at`/`updated_at`/`reopened_at`），索引見 0044。
- ⚠️ `7d`/`30d` 邊界算法兩邊仍未統一（訂單頁滾動毫秒、報表 Macau 日曆）。

## 1. 數字夾唔埋（最高頻誤判）
**四條載體、三種合併**：訂單（下單機）＝本機優先；訂單（第二台）＝`/api/pos/state` 純雲端；
交班＝本機+雲端 **LWW**（雲端 `>=` 贏）；**報表＝純雲端、永不 merge 本機**（對帳用，唔可以改）。
- 商家口徑「實收」＝**毛** ⇒ 實收卡綁 `agg.paidTotal`（非 `netRevenue`）。
- 🔴 兩頁「淨」**方向相反**：交班 `netPaidTotal`＝毛＋未退部分（加）；報表 `netRevenue`＝毛−退款（減）。**唔可互抄**。
- `settledAt = o.reopenedAt ?? o.originalSettledAt ?? o.updatedAt`（3 處）。
  `originalSettledAt`＝首次結帳、永不改，**唔可**當「最後結帳時間」。
- ⚠️ 教訓：**唔可以憑「差額＝某個看似合理嘅數」下結論**，要用真實 data 逐張加總再對照 UI 顯示欄位。

## 2. 返結（反結賬）四條鐵律
1. **同機顯示正常 ≠ 已上雲** ⇒ 必查雲端 `reopen_count`。
2. 狀態必須維持 **`reopened`**（`isPaidDowngrade` 放行；帶成 `paid` 反而危險）。
   `upsertCurrentOrder` 嘅 `keepPaidStatus` 必須同認 `paid` **同** `reopened`，否則加菜變
   `sent_to_kitchen` ⇒ 付款閘拒收 ⇒ **items 永不上雲**。
3. `reopen_count`/`reopened_at`/`reopen_reason` **單調遞增、重結唔清零**。
4. 🔴🔴 **加 `pos_orders` 欄位要改四條讀取路徑**：`pos-order-mapper.ts`（realtime/KDS）／
   `pos-order-row.ts`（state）／`/api/pos/orders` 內聯 mapper（報表）／`sync/route.ts` `baseRecord`。漏一條＝靜默唔出。
- 標籤 `reopen-badge.ts`（零 import）；**只看 `reopenCount`，唔看 `status`**；indigo。
⚠️ `reopenedBy`/`originalSettledAt` 冇上雲；歷史單 `reopen_count` 仍 0 ⇒ 標籤唔出。

## 3. API 鑑權
- 加閘 `posRouteAuthGuard(request, storeId, tag)`，放喺「未配置 Supabase／缺 storeId」early-return **之後**。
- 🔴 `POS_REQUIRE_DEVICE_AUTH` **冇設＝開閘**（空值回 true）。「冇設」≠「關閉」。
- **匿名端點（唔可加閘）**：bootstrap GET、sequence、sync 匿名通道、ledger/member-login、order-lookup、kds/*、print-agent/pair。
- 🔴 開閘擋唔到 DB：anon key 公開 ⇒ 直打 PostgREST 讀得到近 14 日明細。根治＝per-store token（0041§3 未做）。

## 4. 打印／中繼
- 建單/接單後必須 `appendPrintJobsWithSync()`；淨 `savePrintJobs()`＝零出紙。出紙只喺**內容事件**。
- 🔴🔴 **重複出紙＝內容唯一鍵 `onceKey`**：`PrintJob.id` 係 randomUUID ⇒ 只按 id merge **永遠攔唔到**。
  收口＝`claimOncePrintJobs()`；⚠️ `pos-app.tsx` 仍有 3 處繞過。自動路徑必帶世代（`reopenCount`）。
- 🔴 失敗真因睇 `last_error`：`failed to connect to /<印表機IP> from /<中繼IP>` ⇒ 網段不通；
  `dispatch failed` ⇒ 跑 `macau-ledger-merchant`（源碼 `C:\dev\_ref-macau-ledger-merchant`）。
- 🔴 **`paired:true` ＝ DB 有列 ＝ 歷史事實，唔等於在線**；在線睇 `last_seen_at`（~30s）。
- 🔴 「配對失敗：POS 雲端未設定」＝**垃圾桶文案**（三種無關原因同一句）。真兇＝
  `PosPairingManager.kt:65-68` restorePairing 要求 `status=="paired"`。**唔使改 Vercel／唔使重裝 APK**。
- 🔴 判死活要打 `GET /api/pos/print-agent/pair-status?storeId=`；唔可睇 `/prints` 嗰句「N 分鐘前」（前端計算會膨脹）。
- 🔴 爆紙：先 `select pos_void_stale_print_jobs('<storeId>')`。回 0 ≠ 清乾淨（`ttl IS NULL` 掃唔到）。
- ⚠️ APK `RelayApi.kt:221` `fetchDeviceConfig()` **冇帶憑證**；「堂食測試印」繞過 runner 直接 sendRaw。
  🔴 **2026-09-21 修正**：三個本機副本（`_ref-macau-ledger-merchant` / `print-relay` /
  `print-agent-android`）**都係舊版**，但**生產 log 已見**
  `[pos/device-config] 中繼機憑證通道（agent=…）` ⇒ 線上版本應該已修好。
  落結論前**一定用生產 log 核對**，唔好憑本機副本斷定。
- 🔴 **APK 心跳真相（2026-09-21 查證）**：`PosJobRunner.kt:301-303`
  ＝ `TICK_MS=60_000` / `HEARTBEAT_MS=30_000` / `DEVICE_CONFIG_EVERY_TICKS=5`；
  `heartbeatJob`（60-73）同 `tickJob`（74-95）係**兩個獨立迴圈**。
  `heartbeat/route.ts` **從來冇讀過** APK 送嘅 `ipAddress`/`ipAddresses`（全 repo 冇 IP 欄位）
  ⇒ **刪獨立心跳唔會失去伺服器可見資料**；而 `claim`（每 60s、`recordActivity: true`）
  已蓋 `last_seen_at` ⇒ **成功嘅 claim 本身就係心跳**。
  交接文件：**`docs/integration/apk-optimization-handover-2026-09-21.md`**（含 Kotlin diff、回滾、唔可以改嘅嘢）。
  守衛：`src/app/api/pos/print-agent/heartbeat/heartbeat-contract.test.ts`（`nextPollMs` 必須存在且落 5s~180s）。

## 5. 訂單／交班
- 結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱），唔准全店 find()。
- 孤兒單號 `print-xxxxxxxx`＝本機 localStorage，**從未上雲**；「還原」係陷阱 ⇒ 應「永久刪除」。
- 🔴 **交班三條互不相干軌道**：`pos_shifts`（班次，只擋收銀台）／`pos_store_status.is_open`（線下接單）／
  Ledger `merchant_enabled`（線上接單）。`closeShift()` 唔碰任何接單開關。
- 關店總掣＝`close-gate.ts`（純決策）＋`close-gate-run.ts`：先線下後線上／線下失敗**唔 return**／
  `null`＝`skipped`／永遠唔 throw；必須排喺 `closeShift()` 兩個 early return **之前**。
- 🔴 `pos_store_status` 冇 row＝**營業中**；`pos_shifts` 冇 open row＝**未開工**（方向相反）。
  兩者都係「查詢失敗」才 fail-open。`shop-closed` 同 `shift-closed` 文案**唔可撈埋**。
- 🔴 殘留警示 `residual-channel.ts`：**`null`（未讀到）永遠唔觸發**（否則斷網出假警報）。

## 6. UI／環境（硬性）
- 🔴 KPI 帶**固定 5 欄、格數必須係 5 嘅倍數** ⇒ 新指標寫入既有格 subtitle，唔可另開卡片。
- 🔴 `button { font: inherit }`（globals.css 無 layer）壓過 `text-*` ⇒ 按鈕字級寫喺仔元素。
- 🔴🔴 `npm test` ＝ `node --test`，**唔認 `@/` 別名、唔行 bundler、唔支援 `.tsx`** ⇒
  可測模組必須**零 import**；純邏輯同執行層**一定要分檔**。跑全測試 `node --test "src/**/*.test.ts"`。
  ⚠️ 要跑單測嘅模組，import 鏈要**相對路徑 + 顯式 `.ts`**（`from "./date-range.ts"`）。
- npm/npx 跑唔到；冇 coreutils ⇒ 用 Read/Glob/Grep 或 node fs；複雜 JS 寫 `.cjs`。
- git 全路徑 `…/PortableGit/versions/1.2.0/cmd/git.exe`；push 加 `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never`。
- 🔴 Vercel 改 env 要 **Redeploy** 才生效。⚠️ eslint 本機極慢 ⇒ `run_in_background`。
- 同檔唔可同一 message 發多個 Edit。Glob 唔索引工作區外。

## 7. 判別／取證
- 收入 `isSaleCountable()`：只計 settled／帶 onlineOrderId 嘅 paid；日期用 Macau 邊界。
- 🔴 訂單 id 前綴＝邊個程式建單：`order-`＝收銀台/快餐／`staff-`＝店員手機／`kiosk-`＝自助機／
  `ledger-<id>`＝線上鏡像。收銀台永遠唔出「自助點餐機」徽章。
- 🔴 訂單列表顯示時間＝**最後更新**；判建立睇 `pos_orders.created_at`。
- 🔴 事件 payload 兩形狀；拆解唯用 `src/lib/pos/sync-order-payload.ts`。
- 🔴 `storeId` 係公開值（枱 QR `?store=`）⇒ kiosk 手動輸入＝**無密碼落單入口**；
  關「自助點餐機」模組擋唔到嘢（allowedModules 純 UI 導覽）。
- 🔴 Vercel log CSV 冇 IP 欄 ⇒ 靠 route 內 `console.info(ip=…)`。時間軸一律換算 Macau(+8)。
- 🔎 **對照工具**：`tools/analyze-vercel-log.cjs`（**必須按 `requestId` 去重** —— 每個請求 **3 行**，只 1 行有 message）、
  `tools/compare-egress-logs.cjs <before> <after>`（換算「每小時次數」抵銷窗口差異）、
  `tools/verify-deployed-bundle.cjs`（掃線上 chunk 找版本標記；server-only 改動唔會出 bundle）、
  `tools/verify-pos-flows-live.cjs`（真瀏覽器 17 路由）、`tools/verify-pos-api-contract.cjs`、
  `tools/verify-pos-request-count.cjs`。
  ⚠️ 一定要用 `localhost`（**唔可以 `127.0.0.1`**）；API 契約要 `POS_REQUIRE_DEVICE_AUTH=0`；
  殺 dev server 後要刪 `.next/dev/types/validator.ts`（否則假 tsc error）。

## 8. Supabase Egress / 請求數（2026-09-21）
- 🔴 計費口徑：PostgREST egress ＝ **Supabase → Vercel Function** 嗰段，**唔係** → 瀏覽器 ⇒
  改 route response／壓縮**對帳單零幫助**。實測 PostgREST **98.8~99.3%**／Realtime 0.7~1.2%
  ⇒ **唔可以為省流量關 Realtime**。
- 📐 per-row：`pos_orders`（帶 items）1 469 B／`pos_queue_events` 1 668 B／`pos_print_jobs` 1 165 B；
  只投影 `id,status,updated_at` ＝ 91 B（16×）。單次：全量 **857 KB**（無 skipQueue）／**424 KB**（有）／
  報表 ordersOnly 266 KB／守護 `ordersOnly+fields` **20 KB**（修前 ~7 MB）。
- ✅ **已落實（`9d8e1d5`→`c5db7a0`，Production）**：守護投影＋日期下限＋每日 120 次上限／`?skipQueue=1`／
  `pos_orders_page` RPC（0046，三條時間腿**歸零**）／頻率（TTL 60min、報表 10min、打印中心 30s、
  badge 5min、班次 180s）／`[egress]` log／`queue_events` 批次 upsert（POST 150→28）／
  `print-agent` GET 唔寫 DB。**成效：92.47 MB/29.8min → 0.45 MB/38.8min（−99.6%）**。
- 🔴🔴 **`loadPairedAgent(agentId, { recordActivity })`**：**預設純讀**，只 POST 路由傳 `true`。
  ⚠️「改 helper 本身」做唔得 —— `device-config`、`print-agent/pair` 都有 **GET** 路由用同一 helper
  ⇒ 會令 GET 寫 DB（違反 HTTP 語義），由 `print-agent-server.test.ts` 守住。
  🔴 **蓋章失敗唔可以當驗證失敗**（失敗回 401 ⇒ APK 清配對）⇒ update 失敗即退回純讀再驗。
- ✅ **`queue` 身分自激迴圈**（已修）：`useEffect(..., [.., queue])` 認 array 身分，而三個入口用
  `setQueue(loadQueue())` ⇒ 內容一樣都換身分 ⇒ 連鎖再拉 424 KB。修法＝`src/lib/pos/queue-signature.ts`
  （零 import）＋ `replaceQueueFromStorage()`（`lastLoadedQueueRef` 已刪）＋ `loadRuntimeState()` single-flight。
  🔴 簽名用 `JSON.stringify([id,status])` 排序後 `\n` join（**唔可以**用 `id:status` 直接串，會撞簽名）。
  守衛 `pos-app-queue-identity.test.ts` —— 🔴 掃 `.tsx` 前**一定要剝註釋行**。
- 🔴🔴 **真兇：一部 Mac（Safari 17.14、`60.246.53.111`）開咗一整日冇 reload 嘅舊分頁**
  （2026-09-21 22:30 鎖定）。鐵證：149 次 / 29.6 分鐘 / **123 MB（佔 egress 97.2%）**、
  平均 865,924 B、`skipQueue=0 queue=300`。**成本 846 KB × 12.8/min ⇒ ≈650 MB/小時 ⇒ 10 小時 6.5 GB。**
  ⇒ 教訓：**「修正部署咗但症狀持續」→ 第一件事驗「客戶端係咪跑緊舊 bundle」**（睇 query string 有冇
  `skipQueue`），唔好即刻推翻自己嘅修正。診斷工具：`tools/_egress-aggregate-20260921.cjs`（加總 bytes、按 ip/mode 分組）、
  `tools/_egress-who-20260921.cjs`（反查 IP ＋ User-Agent ⇒ 邊部機邊個瀏覽器）。
  已加零風險診斷（**待部署**）：`x-pos-state-src` 標頭 ＋ **舊版 bundle 偵測**
  （`isLegacyFullState = !ordersOnly && !skipQueue` ⇒ warn，每 IP 每分鐘最多 1 條；守衛 `state-egress-src.test.ts`）。
  ⚠️ 本機 `next dev` **見到 `console.warn` 但見唔到 app 層 `console.info`** ⇒ `[egress]` 只可以喺生產 Vercel log 睇。
- 🔴 **根治（未做）**：回應標頭帶 build id ⇒ client 出「請重新載入」提示（**唔好自動 reload**）。
  `public/sw.js` 對 `/_next/static/**` cache-first 本身安全，但 `CACHE_NAME` 寫死（`macau-pos-v20-7-31`）⇒ 建議建置注入。
- 🔴🔴 **量度口徑陷阱：唔可以用「全窗口平均」**。循環係 burst 形態
  ⇒ 平均會被 duty cycle 稀釋（11.24/min → 睇落 5.16/min，但**活躍段其實升到 13.1/min**）。
  一律用 `tools/_fullstate-bursts-20260921.cjs` 做**分段（gap > 20s 就切）**口徑。
- 🔴🔴 **Vercel log 匯出可能係舊檔，而且會落後**：① 先比 SHA-256（實例：兩次匯出**逐位元相同**）；
  ② **檔名時間 ≠ 內容時間**：`…T15-10-53.csv`（澳門 23:10）內容其實係 `12:52–13:21Z`（澳門 20:52–21:21）。
  ⇒ 一律用**內容**嘅 first/last `TimeUTC` 做窗口標籤。
- 🔴 **「兩個來源各打一次」型重複**（同一型係早前嘅 thundering herd）：
  `/api/pos/sync` 中位 **18.6s**（`sync-flush` 30s ＋ pos-app 批次 30s 交錯）；
  `/api/pos/shift` 中位 **48.3s** 且**有 0.0s 成對**（180s timer ＋ `window focus` listener）；
  `/api/topup/pending-count` 中位 **30.3s**（設計 60s/300s，⚠️ 剛好等於
  `VISIBILITY_REFRESH_MIN_GAP_MS = 30_000` ⇒ 反覆切前景就變隱形輪詢）。
- 🔴 **日誌解讀陷阱**：Supabase log 記嘅係 **PostgREST** URL，**唔會**出現 `ordersOnly`/`skipQueue`/`fields`
  ⇒ 喺 Supabase log 搜呢啲字串必然 0，**唔代表冇生效**。
- 🔴🔴 **最大單一 egress 來源＝「舊分頁跑舊 bundle」**（2026-09-21 實測鎖定）：
  冇 reload 嘅分頁唔識傳 `skipQueue=1` ⇒ 每次全量拉取由 **424 KB 變 846 KB**（多拉 300 條 queue），
  配合自激/重連循環 ⇒ **650 MB/小時**。**判斷方法**：Supabase log 睇唔到（只記 PostgREST URL），
  要喺 **Vercel log** 睇 `/api/pos/state` 嘅 `requestQueryString` 有冇 `skipQueue`，
  或者睇 `[egress] pos/state … skipQueue=` 同 `legacy=`。
  工具：`tools/_egress-aggregate-20260921.cjs`（加總 bytes、按 ip/mode/src 分組）、
  `tools/_egress-who-20260921.cjs`（反查 IP + User-Agent ⇒ 邊部機邊個瀏覽器）。
- 🔴 **日誌解讀陷阱**：Supabase log 記嘅係 **PostgREST** URL，**唔會**出現 `ordersOnly`/`skipQueue`/`fields`
  ⇒ 喺 Supabase log 搜呢啲字串必然 0，**唔代表冇生效**。要驗就睇 Vercel log 嘅 `[egress] pos/state` 行。
- 🔴 **幻影欄位**：`pos_orders` 嘅 `refund_records`／`refunded_amount`／`voided_items` ——
  **全部 migration 冇定義、全 codebase 冇寫入**。舊版 `sync/route.ts` 每次試 9 欄 → 42703 → 降 6 欄
  ⇒ 每個 sync 一個 400 + 一條 Error 級 Postgres log（實測每 30 秒一次）。
  ✅ 已修＝**試一次、記住結果**（`refundAuditColumnsAvailable`，守護測試 `sync-route-refund-columns.test.ts`）。
  ⚠️ **唔好加 migration 補欄**（加咗都永遠 null）；若真要做退貨審計，要當完整 feature 做。
- 🔴 **投影欄位清單必須同 `PosOrderDbRow` 由測試雙向焊死**（`pos-order-row.test.ts`）：
  漏欄＝靜默唔出；多欄＝42703 整個查詢失敗。新增欄位只改兩處。
- 🔴 降級鏈：RPC →（PGRST202/42883）三腿 →（42703/PGRST204）`select("*")`；
  **真 DB 錯誤（超時/權限）一律唔降級、如實上報**。
- 🔴 `pos-orders-range.ts` 有 `import "server-only"` ⇒ `node --test` 載入唔到 ⇒ 決策邏輯要抽零 import 模組。
- 🔴 改任何「週期常數」之後**一定要 grep 用戶可見文案**（2026-09-21 改咗間隔但標題仍寫死「每 3 分鐘」）。
  正解＝由常數推導。
- 🔴 心跳放慢上限：`print-center.tsx` 寫死 `minutesAgo >= 5` 就標「疑似離線」⇒ **最多 2~3 分鐘**。
- 🔴 改任何「週期常數」之後**一定要 grep 用戶可見文案**（曾改咗間隔但標題仍寫死「每 3 分鐘」）。
  正解＝由常數推導（`Math.round(X / 60_000)`）。
- 🔴 睇用量圖**一定要先睇右上 filter**（`All projects` ＝ org 總和）。
  另：`/api/topup/*` 打 **Ledger** ⇒ 唔計 macauPos egress，但**計** Vercel invocations。
- 📚 相關報告：`docs/reviews/` 內 `supabase-egress-root-cause-2026-09-21.md`、
  `egress-optimization-implemented-2026-09-21.md`、`page-load-calls-and-herd-2026-09-21.md`、
  `always-on-calls-inventory-2026-09-21.md`、`errwarn-and-call-audit-2026-09-21.md`（附錄 A/B）、
  `after-close-calls-audit-2026-09-21.md`、`session-and-write-gate-design-2026-09-21.md`。
  取證/收口全流程已收錄成用戶級 skill **`pos-egress-call-forensics`**。

## 9. 寫入閘 / 輪詢閘 / 工作階段（2026-09-21 **已實作**）
- 🔴🔴 **原則：Push 優先，Polling 只做兜底**（J 拍板：「不應該不停的 polling」）。
  **你嘅系統已經有 push，唔需要新基建**：
  · POS 網頁 → Realtime 4 條 channel（orders / print_jobs / soldout / store_status）。
  · 🔴 **打印中繼 APK 亦有** —— `PosRealtimeSubscriber.kt:84-120` 訂 `pos_print_jobs` **INSERT**
    → `onWake()` → `PosJobRunner.onRealtimeWake()` → claim → 出紙。
    ⇒ APK 嘅 `claim`(60s) 同 `heartbeat`(30s) **本來就係兜底**，只係跑到太密。
- ⚠️ **唔可以真「零輪詢」**：`use-store-status.ts:38-43` 記錄「Realtime 靜默失效」
  （訂錯專案照 `SUBSCRIBED` 但永遠收唔到事件，Supabase 唔報錯）⇒ 保留 5 分鐘兜底，
  將最壞情況由「全日」壓到「5 分鐘」。
- ✅ 新檔：`src/lib/pos/poll-gate.ts`（零 import 純決策、24 單測）、
  `poll-gate-client.ts`（執行層）、`activity-tracker.ts`（真人互動追蹤、單一 listener、零網絡）。
  · 停：冇 session／分頁隱藏／**閒置 ≥5 分鐘**／兩條接單通路都關／已收工（無 pending）。
  · **最短間隔**：Realtime 通 → **5 分鐘**；唔通／未知 → 60 秒。
  · 🔴 `kind: "triggered"`（mount backfill／重連補拉／手勢）**只受「冇 session」「分頁隱藏」限制** ——
    唔可以用週期閘擋，否則「未開工嘅收銀台連今日訂單都拉唔到」。
  · 🔴 `urgent: true`（推本機事件上雲）**唔可以被閒置／關店擋**。
  · 🔴 報告 Realtime 健康一定要**同時**驗 `getPosRealtimeConfig()?.source === "pos"` ——
    單靠 `SUBSCRIBED` 會中「訂錯專案」嘅靜默失效。
- ✅ **寫入閘**：`src/lib/pos/write-gate.ts`（零 import、15 單測）。
  兩道 server 閘由「只查 `!authorized`」擴展到「含 `ORDER_CREATED`/`ORDER_UPDATED` 就查」，
  再加**授權通道**閘。口徑（J 拍板）：
  · **拒**：`ORDER_CREATED`、`ORDER_UPDATED` **帶 `addedItems`**（加菜）—— 舊 client 冇帶 → fail-open。
  · **准**：`ORDER_SETTLED`（結帳，**客人走唔到更嚴重**）／退菜／刪單／出紙／純狀態推進。
  · 🔴🔴 **`ledger-` 前綴線上鏡像一定要放行** —— 擋咗會令線上單喺 POS 雲端**永遠冇完整記錄**（靜默）。
  · 逃生門＝**重新開工**（有記錄、有意義）。
  · 收銀台加菜事件**有**帶 `addedItems`（`pos-app.tsx:3877`），所以攔得到。
  守衛：`src/app/api/pos/sync/sync-route-write-gate.test.ts`。
- 🔴 **兩道閘都係 fail-open**（查唔到就放行）——**刻意**，唔可以改 fail-closed
  （一斷網全店落唔到單）。補償＝client 層擋 + 側欄警示。
- 憑證 TTL：POS 終端 token／admin session 都係 **12 小時**（`pos-device-token.ts:31`）。
- ⏭️ 未做：`pos_shifts` Realtime 訂閱、報表「自動更新已停用」文案、APK 側改動（交 Ledger）。
- ✅ **G2／G3 已實作**（2026-09-21）：
  · **G2**＝`pos-app` 新 `ensureStoreOpenForNewBusiness()`（**fail-open：只有 `isOpen === false` 才擋**），
    掛喺 **4 個「開新生意」入口**（`selectTable` 空閒枱／`confirmOpenTable`／`addMenuItem`／`sendToKitchen`）。
    🔴 **明確唔掛喺結帳**（`openSettlementModal`／`confirmPayment`）—— J 拍板「客人走唔到更嚴重」。
    🔑 唔需要另開 hook：`pos-app` render `<AppSidebar>` → `useStoreOpenToggle()` → `useStoreStatus()`
    係 module singleton ⇒ `getStoreStatusSnapshot()` 已經有值。
  · **G3**＝`sync-flush.ts` 新增 `POS_SYNC_BLOCKED_EVENT`（**規則性拒收**，同 `POS_SYNC_FAILED_EVENT`
    「嘗試到頂」分開），喺**兩條回執路徑**（非 200 / 200）都 `notifyBlockedByGate()`；
    `pos-app` 收到 → toast 提示 ＋ 即刻 `syncOnce()` 由雲端重新對齊班次
    （否則舊分頁一路白試到 `failed`）。
  · 守衛：`src/components/pos-app-write-gate-client.test.ts`（7 條，含「結帳唔可以掛 G2」）。
- 📄 **Ledger 中繼 APK 文件（第 2 版）**：`docs/integration/apk-optimization-handover-2026-09-21.md`
  —— 核心＝**獨立心跳可以整個刪**（`claim` 已蓋 `last_seen_at`／心跳送嘅 IP server 從未讀過／
  APK 已有 `PosRealtimeSubscriber`），claim 由 **`nextPollMs`** 控制（60s → 180s）⇒
  **3.0 → 0.33 次/分鐘（−89%）**。🔴 上限 **180 秒**（POS 網頁 5 分鐘標「疑似離線」）。
  伺服器已配合：`claim` 回應加 `nextPollMs`。
- 🔴🔴 **關店後殘餘流量 ＝ 100% 中繼 APK**（2026-09-21 22:51–23:50 實測，59.3 分鐘）：
  `PATCH pos_print_agents` **208 次（3.3/min，間隔中位 18.24s）**／`rpc/pos_claim_print_jobs` 74
  （60.21s）／`GET pos_device_configs` 17（250s）／`GET pos_print_agents` 18（250s）；
  而 `pos_orders_page`／`pos_queue_events`／`pos_print_templates`／`pos_note_presets` **全部 0 次**
  ⇒ **瀏覽器側完全乾淨**，殘餘全部係 APK（其中約六成係心跳）。
- ✅ **配對驗真已修（2026-09-21，待補 env）**：`pair/route.ts` 嘅 `lookupMerchant()`
  以前用 **POS 專案 client** 查 `merchants`（Ledger 表）⇒ 404/`PGRST205` ⇒ fail-open
  ⇒ 驗真從未生效。已改用新 helper
  **`src/lib/ledger/supabase-ledger-service.ts`**（`getLedgerServiceClient()`；
  env ＝ `NEXT_PUBLIC_SUPABASE_URL`（Ledger URL）＋ **`LEDGER_SUPABASE_SERVICE_ROLE_KEY`**）。
  ⚠️ **未設 env → 回 `null` → 維持 fail-open**（行為同修復前一樣，只係唔再白打一個 404）
  ⇒ 可以先行上線，env 後補。**J 要喺 Vercel 加 env（Production scope）＋ Redeploy。**
  🔴 **權限取捨**：呢支 key ＝ POS 部署可完整讀寫整個 Ledger（service_role bypass RLS），
  由 anon 升級 ⇒ 影響面擴大。**更保守嘅替代**：請 Ledger 側開
  `GET /api/integration/pos/merchant-exists?storeId=`（走 `LEDGER_INTEGRATION_BASE_URL`
  ＋ `LEDGER_WEBHOOK_SECRET`，同 `ensure-customer` 同模式）⇒ POS 唔需要特權憑證。
  守衛：`pair-merchant-lookup.test.ts`（8 條，守住「唔可以 fallback 去 POS key/URL」、
  「null 要 fail-open 唔可以 throw」、「`22P02` 仍然要擋」）。
- 設計 + 實作全文：**`docs/reviews/session-and-write-gate-design-2026-09-21.md`**。
- 📌 **取證（2026-09-21 實查，做呢批改動嘅依據）**：
  · 兩道 server 閘原本係 `sync/route.ts:519-534`（店內營業 2.55）、`558-572`（班次 2.56），
    條件都係 `if (!authorized && …)`；`869`／`883` 一樣 ⇒
    **收銀台（帶 POS 憑證）完全冇「店已關」閘**，而 `useStoreStatus()` **冇被 `pos-app` 用過**
    （只用於 `app-sidebar`／`online-open-pill`／`shift-page`／`use-store-open-toggle`）。
  · 收銀台開工閘 `pos-app.tsx:949-953 ensureShiftOpened()` **只讀本機 `shift.openedAt`**
    ⇒ 另一部機交班後最長 180 秒才同步到；**舊分頁可以一直用過時狀態落單而 server 照收**。
  · 改動前**全系統冇任何 idle／active session 偵測**（grep ＝ 0 命中）。
  · ✅ 既有正確模式（照抄）：`pos-app.tsx:944-947` 已有「過閘／唔過閘」清單；
    `close-gate.ts`（**零 import** 純決策）＋ `close-gate-run.ts`（執行層）係正確分檔法。
  · 🔴 **Heartbeat 評估結論：唔適用**。① 推送式 ⇒ 關店／掛機照打，冇得暫停；
    ② 只有 `print-center` 顯示用，**冇 server 邏輯靠佢**；③ 佔關店時段請求 **12%**（單一最大）；
    ④ **完全冗餘** —— `claim`（60s、無條件）已經蓋同一個 `last_seen_at`；
    ⑤ 送嘅 `ipAddress(s)` **server 從未讀過**。
    ⇒ 刪獨立心跳迴圈，靠 `claim` 兼任（−100%）；保留 `nextPollMs` 作遠端旋鈕。
