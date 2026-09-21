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
- per-row 實測：`pos_orders`（帶 items）1 469 B／`pos_queue_events` 1 668 B／`pos_print_jobs` 1 165 B；
  只投影 `id,status,updated_at` ＝ 91 B（16×）。
- 📐 單次 bytes：全量 **857 KB**（無 skipQueue）／**424 KB**（有 skipQueue）／
  報表 ordersOnly 266 KB／**守護 ordersOnly+fields 20 KB**（修前 ~7 MB ⇒ −99.7%）。
- ✅ **已落實（`9d8e1d5` → `c5db7a0`，Production 已上線）**：守護投影 + 日期下限 + 每日 120 次上限／
  `?skipQueue=1`／`pos_orders_page` RPC（0046，三條時間腿**歸零**）／頻率（TTL 60min、報表 10min、
  打印中心 30s、badge 5min、班次 180s）／`[egress]` log／`queue_events` 批次 upsert（POST 150→28）／
  `print-agent` GET 唔寫 DB（`recordActivity` 預設 false）。
  報告：`docs/reviews/supabase-egress-root-cause-2026-09-21.md`、
  `egress-optimization-implemented-2026-09-21.md`、`page-load-calls-and-herd-2026-09-21.md`、
  `always-on-calls-inventory-2026-09-21.md`、**`errwarn-and-call-audit-2026-09-21.md`（最新）**。
- ✅ 實測成效：egress **92.47 MB/29.8min → 0.45 MB/38.8min（−99.6%）**，推算 ~6 MB/日。
- 🔴🔴 **`loadPairedAgent(agentId, { recordActivity })`**：**預設純讀**，只 POST 路由傳 `true`。
  ⚠️ 「改 `loadPairedAgent` 本身」做唔得 —— `device-config`、`print-agent/pair` 都有 **GET** 路由用同一 helper
  ⇒ 會令 GET 寫 DB（違反 HTTP 語義）。由 `src/lib/print-agent-server.test.ts` 守住。
  🔴 **蓋章失敗唔可以當驗證失敗**（失敗回 401 ⇒ APK 清配對）⇒ update 失敗即退回純讀再驗。
- ✅ **2026-09-21 已修：`queue` 依賴自激迴圈（全量拉取 424 KB × 每 4.49 秒）**
  · 病根：`pos-app.tsx` 嗰個 `useEffect(..., [offlineMode, runtimeRefreshTick, queue])` 認嘅係
    **array 身分**，而三個入口用 `setQueue(loadQueue())`（`POS_SYNC_FAILED_EVENT` /
    `SyncHealthModal onMutated` / 重試掣）**就算內容一樣都換身分** ⇒ 連鎖再拉一次全量 state。
  · 修法：`src/lib/pos/queue-signature.ts`（零 import）＋ `queueSignatureRef` ＋
    `replaceQueueFromStorage()`；backfill 嗰處內聯簽名**併入同一 ref**（`lastLoadedQueueRef` 已刪）。
    🔴 簽名**唔可以**用 `id:status` 直接串（`{id:"a:b",status:"c"}` 會同 `{id:"a",status:"b:c"}` 撞）
    —— 用 `JSON.stringify([id,status])` 排序後 `\n` join。
  · 另加 `loadRuntimeState()` single-flight（key ＝ `resolveStoreId()`）。
  · 守衛：`src/components/pos-app-queue-identity.test.ts`。
    🔴 掃 `.tsx` source 前**一定要剝註釋行**，否則自己嘅解釋性註釋會令 `setQueue(loadQueue())`
    誤報（本檔註釋刻意引用舊寫法）。
  · ⏸️ 刻意**唔做** dep 收窄（`queue` → `hasPendingEvents`）：有語義差異，唔符合「零行為改動」。
  · 取證/收口全流程已收錄成 skill **`pos-egress-call-forensics`**（用戶級）。
- ⚠️ **仍有裝置跑舊 bundle（未 reload）** ⇒ 會見到「冇 skipQueue」嘅全量拉取。
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
- 🔴 **現時最大請求來源**：`print-agent/heartbeat` 每 ~32 秒（APK 寫死 `HEARTBEAT_MS=30_000`；
  web 已回 `nextPollMs: 60_000` 但 **APK 未讀**）／`online-order-settings` 開頁 ×5（herd，**已修 →1**）／
  `store-status` ×3（**已修 →1**）／`claim` 每 ~70 秒／`pos/shift` 180 秒／`topup/pending-count`。
- 🔴 心跳放慢上限：`print-center.tsx` 寫死 `minutesAgo >= 5` 就標「疑似離線」⇒ **最多 2~3 分鐘**。
- ⏸️ 刻意未做（都有功能影響）：`topup/pending-count` 改按需（紅點唔自動更新）、
  `pos/shift` 關店唔拉（開工閘延遲解鎖）、`kiosk-settings` 延後。
  **唔可以動**：`POST /api/pos/sync`、`/api/pos/store-status`、Realtime。
- 🔴 睇用量圖**一定要先睇右上 filter**（`All projects` ＝ org 總和）。
  另：`/api/topup/*` 打 **Ledger** ⇒ 唔計 macauPos egress，但**計** Vercel invocations。
