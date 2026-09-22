# macauPos 記憶（2026-09-22 精簡版）

> 🔴 詳細逐條**開工前必讀**：`docs/113-agent-gotchas.md`。
> 取證／流程已收錄成 skills：`pos-egress-call-forensics`／`pos-order-sync-triage`／
> `pos-close-gate-feature`／`pos-api-auth-hardening`／`pos-ui-live-verify`。
> POS=`iyrywzormzisyppkokbi`；Ledger=`zymdemjflsckicwcinxl`。Migration 0036／0042–0046 已跑齊。

## 0 訂單時間口徑
- 唯一真源 `src/lib/pos/order-event-time.ts` `orderEventInstant()`：
  `reopenedAt → originalSettledAt → updatedAt → createdAt`；兩個 predicate ＋ 顯示已全委派。
- 「顯示 updatedAt、篩選 createdAt」曾令同一筆錢計兩次（實案 10 單 512 vs 9 單 474）。
- `fetchOrdersInRange()` 三條腿（0404 索引見 0044）。⚠️ 7d/30d 邊界算法兩邊未統一。

## 1 數字夾唔埋（最高頻誤判）
- 四載體三合併：訂單（下單機）＝本機優先；訂單（第二台）＝純雲端 `/api/pos/state`；
  交班＝本機+雲端 LWW；**報表＝純雲端、永不 merge**（對帳用）。
- 商家「實收」＝**毛** ⇒ 綁 `agg.paidTotal`。🔴 兩頁「淨」方向相反：
  交班 `netPaidTotal`（毛＋未退，加）vs 報表 `netRevenue`（毛−退款，減）——**唔可互抄**。
- `originalSettledAt`＝首次結帳、永不改。⚠️ 教訓：唔可以憑「差額看似合理」落結論，要逐張加總對 UI。

## 2 返結（反結賬）四鐵律
1. 同機顯示正常 ≠ 已上雲 ⇒ 必查雲端 `reopen_count`。
2. 狀態須維持 `reopened`；`upsertCurrentOrder` 嘅 `keepPaidStatus` 要同認 `paid`＋`reopened`，
   否則加菜變 `sent_to_kitchen` ⇒ 付款閘拒收 ⇒ **items 永不上雲**。
3. `reopen_count`／`reopened_at`／`reopen_reason` 單調遞增、重結唔清零。
4. 🔴 加 `pos_orders` 欄位要改**四條讀取路徑**：`pos-order-mapper.ts`／`pos-order-row.ts`／
   `/api/pos/orders` 內聯 mapper／`sync/route.ts` `baseRecord`（漏一條＝靜默唔出）。
- `reopen-badge.ts` 零 import、只看 `reopenCount`、indigo；`reopenedBy`／`originalSettledAt` 冇上雲。

## 3 鑑權
- 加閘 `posRouteAuthGuard(request, storeId, tag)`，放喺 early-return（未配 Supabase／缺 storeId）**之後**。
- 🔴 `POS_REQUIRE_DEVICE_AUTH` **冇設＝開閘**（「冇設」≠「關閉」）。
- 匿名端點：bootstrap GET／sequence／sync 匿名／ledger/member-login／order-lookup／kds/*／print-agent/pair。
- anon key 公開 ⇒ 直打 PostgREST 讀到近 14 日明細；根治＝per-store token（未做）。
- 憑證 TTL：POS 終端 token 同 admin session 都係 **12 小時**。

## 4 打印／中繼
- 建單/接單後必 `appendPrintJobsWithSync()`（淨 `savePrintJobs()`＝零出紙）。
- 🔴🔴 `appendPrintJobs()` 同名反轉語義（2026-09-11 `1e08343`）：舊版＝會上雲，新版＝**只寫本機**。
  5 處未搬 ⇒ 靜默零出紙（**返結單**、確認自助單、自助單 realtime 新單／加單／backfill）。
  唯一合法用法＝`printKioskReceiptForOrder()`（kiosk 本機小票）。詳見
  `docs/reviews/print-out-failure-and-latency-2026-09-22.md`。
- 重複出紙靠**內容唯一鍵 `onceKey`** ＋ `claimOncePrintJobs()`（`PrintJob.id` 係 randomUUID，
  按 id merge 永遠攔唔到）；⚠️ `pos-app.tsx` 仍有 3 處繞過；自動路徑必帶世代。
- 🔴 `paired:true`＝DB 有列＝歷史事實，**唔等於在線**；在線睇 `last_seen_at` 或打 `pair-status`。
- 爆紙先 `select pos_void_stale_print_jobs('<storeId>')`（回 0 ≠ 清乾淨）。
- APK：`PosJobRunner.kt` TICK 60s／DEVICE_CONFIG 每 5 tick；**獨立心跳已刪**（`claim` 已蓋
  `last_seen_at`，`heartbeat/route.ts` 從未讀 IP）⇒ claim 由 `nextPollMs` 控制（60→180s，
  🔴 上限 180s，因 POS 網頁 `>= 5 分鐘` 標「疑似離線」）。
- 🔴 出紙**慢**嘅三大來源（2026-09-22）：① `SUGGESTED_CLAIM_MS=180s`（實測 median 180.5s）
  ② APK `claim` **一次最多 5 張**（`p_limit`）＝高峰 1.7 張/分鐘 ③ 打印中心結果回填 8s→30s。
  叫醒路徑（`pos_print_jobs` INSERT → `onWake`）通＝1–3 秒、唔通＝等足 180 秒。
  建議自適應：`jobs.length >= limit` 回 `3_000`，否則 `180_000`。
- 🔴 落結論前一定用**生產 log** 核對，唔好憑本機 Kotlin 副本斷定（三個副本都係舊版；
  5 個副本全部無 `nextPollMs` 實作，但生產 log 證明現役 APK 有讀 ⇒ 現役源碼唔喺本機）。

## 5 訂單／交班
- 結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱），唔准全店 find()。
- 孤兒單號 `print-xxxxxxxx`＝本機 localStorage、從未上雲 ⇒ 應「永久刪除」（「還原」係陷阱）。
- 🔴 **三條互不相干軌道**：`pos_shifts`（班次，只擋收銀台）／`pos_store_status.is_open`（線下接單）／
  Ledger `merchant_enabled`（線上接單）。`closeShift()` 唔碰任何接單開關。
- 關店總掣＝`close-gate.ts`（零 import 決策）＋`close-gate-run.ts`：先線下後線上／線下失敗唔 return／
  `null`＝skipped／永遠唔 throw；必須排喺 `closeShift()` 兩個 early return **之前**。
- 🔴 `pos_store_status` 冇 row＝營業中；`pos_shifts` 冇 open row＝未開工（方向相反）。
  殘留警示 `residual-channel.ts`：**`null`（未讀到）永遠唔觸發**。

## 6 UI／環境（硬性）
- 🔴 KPI 帶固定 5 欄、格數必須係 5 嘅倍數 ⇒ 新指標寫入既有格 subtitle。
- 🔴 `button { font: inherit }` 壓過 `text-*` ⇒ 按鈕字級寫喺仔元素。
- 🔴🔴 `npm test` ＝ `node --test`：**唔認 `@/` 別名、唔支援 `.tsx`** ⇒ 可測模組**零 import**、
  邏輯同執行層**一定要分檔**；要跑單測嘅模組 import 鏈用**相對路徑＋顯式 `.ts`**。
- npm/npx 跑唔到；冇 coreutils（用 Read/Glob/Grep）；複雜 JS 寫 `.cjs`。
  ⚠️ 改 memory／報告**唔好經 `node -e`**（反引號被 shell 當命令替換，靜默食內容）。
- git 全路徑 PortableGit；push 前 export PATH（cmd＋mingw64/bin）；仍卡就用內聯 credential helper。
- Vercel 改 env 要 **Redeploy**。同檔唔可同一 message 發多個 Edit。

## 7 判別／取證
- `isSaleCountable()`：只計 settled／帶 onlineOrderId 嘅 paid，日期用 Macau 邊界。
- 訂單 id 前綴＝邊個程式建單：`order-` 收銀台/快餐／`staff-` 店員手機／`kiosk-` 自助機／
  `ledger-` 線上鏡像。訂單列表顯示時間＝**最後更新**；建立睇 `pos_orders.created_at`。
- 事件 payload 兩形狀 ⇒ 拆解唯用 `src/lib/pos/sync-order-payload.ts`。
- `storeId` 係公開值（枱 QR `?store=`）⇒ kiosk 手動輸入＝無密碼落單入口。
- Vercel log CSV 冇 IP ⇒ 靠 route 內 `console.info(ip=…)`；時間一律換算 Macau(+8)。
- 工具：`analyze-vercel-log.cjs`（**必須按 `requestId` 去重**，每請求 3 行）、
  `compare-egress-logs.cjs`、`verify-deployed-bundle.cjs`、`verify-pos-flows-live.cjs`、
  `analyze-sb-limit-fingerprint.cjs`。
- 真瀏覽器驗證一律用 `localhost`（**唔可以 `127.0.0.1`**）；殺 dev server 後刪 `.next/dev/types/validator.ts`。

## 8 Egress／版本（2026-09-22 收口）
- 計費口徑：PostgREST egress ＝ **Supabase → Vercel Function**，改 route response 對帳單零幫助。
- ⭐ **最快取證＝直接解析 Vercel 嘅 `[egress]` 行**（自帶 `bytes/mode/orders/queue/printJobs/
  skipQueue/legacy/ip/src`）⇒ 唔需要 Supabase log 就分得出「邊部機、幾大、幾密」。
  工具：`tools/_egress-byip-20260922.cjs`／`_egress-deep-20260922.cjs`／`_egress-recheck-20260922.cjs`。
- 🔴 最大單一來源**仍然係「舊分頁跑舊 bundle」**（2026-09-22 13:24 複發）：903 KB × 20 次 / 92 秒
  ⇒ **690 MB/小時**（＝商家口中 500 MB/日 ≈ 開 45 分鐘）；新版 412 KB（−54%）。
  ⇒ 唔可以只「拉細啲」，要**「少拉」**。
- ⚠️ **Supabase dashboard CSV 匯出上限 1000 行** ⇒ 高流量時窗口會被截到十幾分鐘（唔可以當一日）；
  一律用 `date` 欄（有 `Z`）解析，唔好用 `timestamp`（冇 `Z`、6 位微秒）。
- 最大單一來源＝**舊分頁跑舊 bundle**（冇傳 `skipQueue=1` ⇒ 846 KB vs 424 KB，650 MB/小時）。
- ⭐ 唔需 Vercel log 都判得到：`state/route.ts` 收唔到 skipQueue ⇒ 查 `limit=300`（舊）／
  收到 ⇒ `limit=0`（新）⇒ **Supabase log 嘅 `pos_queue_events` URL 就係 bundle 版本指紋**。
- ✅✅ **2026-09-22 11:13 最終複核：全清**（商家完全閂掉 Safari 之後）：
  Vercel **0.7 次/分鐘**（原 15.2，−95%），全部 200、零 error；
  **`heartbeat` = 0**、**`/api/pos/state` = 0**、`claim` 每 180s、`device-config` 每 360s；
  Supabase 側 `PATCH pos_print_agents` 9 : `claim` 9 ＝ **1:1** ⇒ **獨立心跳確證冇咗**
  （若仍在會係 52:9）；瀏覽器側**全部表 0 次**、零 409／零 once_key 重複。
  21 Sep **904 MB/日** → 估計 **10~20 MB/日（−98%）**。
  ⚠️ **仍未確認**：該窗口**冇開 POS 頁**（只有 `/login` ×3）⇒ 「零」同時代表「冇循環」＋
  「冇人開頁」；要一個**營業中、POS 開住**嘅窗口驗證先算完全收口。
  🔴 同日 11:15:48 有 `23505 schema_migrations_pkey`＝**重複執行已套用嘅 migration**
  （唔關 POS；手動跑無害，自動化重跑就要查）。
- 已落實：RPC `pos_orders_page`(0046)、`?skipQueue=1`、投影＋日期下限＋每日上限、
  輪詢閘 `poll-gate.ts`、寫入閘 `write-gate.ts`、queue 身分簽名、APK `nextPollMs`、`[egress]` log。
- 🔴 兩道 server 閘**刻意 fail-open**（一斷網全店落唔到單）；`kind:"triggered"` 只受
  「冇 session／分頁隱藏」限；`urgent:true`（推本機事件上雲）唔可被擋。
- 版本號：`src/lib/build-info.ts` —— `NEXT_PUBLIC_BUILD_ID` **內聯**入 bundle（必逐個字面寫
  `process.env.X`，唔可 destructure）；`x-pos-build` 標頭＝線上最新；只提示**唔自動 reload**。
- ✅ 收銀台**版本過期橫幅** `build-stale-banner.tsx`：`/pos` **最頂 in-flow**（推低內容、
  唔蓋住「開工／接單」），只喺 client≠server 出現；**有「立即重新載入」掣**（`min-h-[40px]`）。
  🔴 **有購物車／結帳畫面先確認**（`describeReloadRisk()`：講「會清空 X」＋
  「已落單／未上雲紀錄**會保留**」，**唔可以講「失去資料」**）。
  🔴 **配套排版（唔改會爛）**：外層 `flex`→`flex-col`；兩分支根 `h-[100dvh]`→`min-h-0 flex-1`
  （唔改 ⇒ 底部被 `overflow-hidden` 裁切）。守衛 `pos-app-stale-banner.test.ts`。
- ❌ **唔好做「版本唔正確就 block 請求」**：① 舊 bundle 唔會送 build id ⇒ 只可以「冇送就當舊」
  ⇒ **一改令所有舊裝置即刻死**（kiosk／店員手機／admin 頁）② **版本 ≠ 相容性** ⇒
  每個 deploy 都變 breaking change ⇒ 逼商家停業重啟 ③ 被擋嘅正正係你想救嘅收銀台
  （**冇單比多打幾個請求嚴重**）④ 部署／CDN 過渡期會「啱啱開頁就被擋」⑤ 改 header 就繞過
  ⑥ 運維成本轉嫁客人 ⇒ **用停業風險換 egress，唔值**。
  ✅ 建議替代（L3）：偵測**同一部機開咗多個 POS 視窗**（localStorage／BroadcastChannel 心跳）
  → 提示（**唔擋**）。**真正根源係「同一終端同時開新舊兩個視窗」**。
- ✅ 2026-09-22 早上實測：APK 180s 生效，`PATCH pos_print_agents`／`claim` 間隔中位
  180.5s／180.9s（−89%）；POS 網頁側請求乾淨。⚠️ 舊 bundle 循環仍偶發（開頁即爆幾分鐘）。
- 🔴 量度陷阱：唔可以用「全窗口平均」（循環係 burst，會被 duty cycle 稀釋）⇒ 用 gap>20s 分段。
  Vercel log 匯出可能係舊檔／落後 ⇒ 用**內容** first/last `TimeUTC` 做窗口標籤。
- 📚 `docs/reviews/`：`supabase-egress-root-cause`／`egress-optimization-implemented`／
  `page-load-calls-and-herd`／`always-on-calls-inventory`／`errwarn-and-call-audit`／
  `after-close-calls-audit`／`session-and-write-gate-design`（均 2026-09-21）。
  ⏭️ 未做：`pos_shifts` Realtime 訂閱、報表「自動更新已停用」文案、print-agent 配對驗真補 env
  （`LEDGER_SUPABASE_SERVICE_ROLE_KEY`）、per-store token。

## 9 POS 工作階段（2026-09-22）
- 表 `pos_sessions`（migration **0047**）／註冊點 `/api/ledger/login`／續期搭既有請求
  （POST 60s、GET state 5min；**GET 只續期、唔建立**）／client 標頭 `x-pos-session`＋`x-pos-build`。
- 🔴 key 存 **`sessionStorage`**（localStorage 會令多個分頁撞成同一行 ⇒ 測唔到「多開」）。
- 管理頁 `/admin/sessions`；強制關閉＝**軟踢**（`x-pos-session-closed:1` ⇒ 橫幅＋停輪詢，
  只擋新生意，結帳放行）；門檻：使用中 ≤6 分（輪詢閘 5 分＋1 分餘量）／閒置 ≤30 分。
- 詳細取捨同實作清單見 `.workbuddy/memory/2026-09-22.md` 11:00 段。
