# macauPos 記憶（2026-09-22 收斂版）

> 開工前必讀 `docs/113-agent-gotchas.md`；流程已成 skills：`pos-egress-call-forensics`／
> `pos-order-sync-triage`／`pos-close-gate-feature`／`pos-api-auth-hardening`／`pos-ui-live-verify`。
> POS=`iyrywzormzisyppkokbi`；Ledger=`zymdemjflsckicwcinxl`。Migration 至 0047 已跑齊。
> 📄 最新個案：`docs/reviews/order19-and-receipt-print-2026-09-22.md`。

## 0 訂單時間（唯一真源）
`src/lib/pos/order-event-time.ts` `orderEventInstant()`：reopenedAt → originalSettledAt → updatedAt → createdAt。
predicate ＋ 顯示全委派它（「顯示 updatedAt／篩選 createdAt」曾令同一筆錢計兩次）。
`fetchOrdersInRange()` 三腿（0044 索引）；⚠️ 7d/30d 邊界兩邊未統一。

## 1 數字夾唔埋
四載體：訂單（下單機）＝本機優先；訂單（第二台）＝純雲端 `/api/pos/state`；交班＝LWW；
**報表＝純雲端永不 merge**。商家「實收」＝毛 ⇒ `agg.paidTotal`。
🔴 兩頁「淨」反向：交班 `netPaidTotal`（＋未退）vs 報表 `netRevenue`（−退款），唔可互抄。
`originalSettledAt`＝首次結帳永不改。唔可憑「差額合理」落結論，要逐張加總對 UI。

## 2 返結四鐵律
①同機正常≠已上雲（必查 `reopen_count`）②狀態須維持 `reopened`、`keepPaidStatus` 要認 `paid`+`reopened`
（否則加菜變 `sent_to_kitchen` ⇒ 付款閘拒收 ⇒ items 永不上雲）③reopen_count/at/reason 單調遞增
④🔴 加 `pos_orders` 欄位要改四條讀取路徑：`pos-order-mapper.ts`／`pos-order-row.ts`／
`/api/pos/orders` 內聯 mapper／`sync/route.ts` `baseRecord`（漏一條＝靜默唔出）。
`reopen-badge.ts` 零 import、只看 `reopenCount`；`reopenedBy`／`originalSettledAt` 冇上雲。

## 3 鑑權
閘＝`posRouteAuthGuard(request, storeId, tag)`，須放喺 early-return **之後**。
🔴 `POS_REQUIRE_DEVICE_AUTH` **冇設＝開閘**（「冇設」≠「關閉」）。
anon key 公開 ⇒ 可直讀近 14 日明細（連 `pos_print_jobs` 都讀到；`pos_queue_events` 係 42501
→ 要 service role）。根治＝per-store token（未做）。憑證 TTL：POS token／admin session 皆 12h。

## 4 打印／中繼
🔴🔴 **入隊只准一條路徑 `appendPrintJobsWithSync()`**（2026-09-22 收口）。`pos-app.tsx` 曾有
自製 `enqueuePrintJobs()`（base 用 React state `queue`）⇒ **收據 job 從未上雲**（實測 kitchen
35/35 `printed` vs receipt 只 3 張、`once_key` 全 NULL＝全人手補打），打印中心仍顯示綠色
「已發送」＝零出紙零紅標。守衛 `pos-app-queue-base.test.ts`。
🔴 `pushEvents()` base **一定要 `loadQueue()`**；同一 handler 兩次呼叫會用 stale state 冚走前一批
（同 `syncNow()` 同病根）⇒ 雲端單永遠停 `sent_to_kitchen`。
`appendPrintJobs()` 同名反轉語義（2026-09-11 `1e08343`）：新版**只寫本機**；唯一合法用法
＝`printKioskReceiptForOrder()`。去重靠 `onceKey`＋`claimOncePrintJobs()`（id 係 randomUUID，
按 id merge 攔唔到）；自動路徑必帶世代（收據 `receipt:${reopenCount}`）。
🔴 `paired:true`＝歷史事實，唔等於在線（看在線用 `last_seen_at`／`pair-status`）。
爆紙：`select pos_void_stale_print_jobs('<storeId>')`（回 0 ≠ 清乾淨）。
APK：TICK 60s；獨立心跳已刪；claim 由 `nextPollMs` 控（60→180s，上限 180s）。
出紙慢三源：`SUGGESTED_CLAIM_MS=180s`／claim 一次最多 5 張／結果回填 8s→30s；叫醒通＝1–3 秒。
🔴 落結論前用**生產 log／DB**核對，唔好憑本機 Kotlin 副本斷定。

## 5 訂單／交班
結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱）。
孤兒單號 `print-xxxxxxxx`＝localStorage、從未上雲 ⇒ 永久刪除（「還原」係陷阱）。
🔴 三條互不相干軌道：`pos_shifts`（只擋收銀台）／`pos_store_status.is_open`（線下接單）／
Ledger `merchant_enabled`（線上接單）；`closeShift()` 唔碰任何接單開關。
總掣＝`close-gate.ts`＋`close-gate-run.ts`：先線下後線上／線下失敗唔 return／null＝skipped／永不 throw；
須排喺 `closeShift()` 兩個 early return **之前**。
🔴 `pos_store_status` 冇 row＝營業中；`pos_shifts` 冇 open row＝未開工（方向相反）。
`residual-channel.ts`：`null`（未讀到）永不觸發。

## 6 UI／環境（硬性）
🔴 **路由**：`/` ＝統一入口「選擇工作台」（2026-09-17 起）；**收銀台係 `/pos`**；`/orders`＝訂單頁。
深連結（查看未結堂食單／返結後跳枱面）一律 `/pos?tableId=…&orderId=…`，**唔准推 `/`**；
清 query 用 `history.replaceState(null,"",window.location.pathname)`（唔可以寫死 `"/"`，否則 reload 會跌返選擇頁）。
守衛 `src/lib/pos/pos-deeplink-path.test.ts`。
🔴 `local-orders-panel` 嘅「查看」設計（唔好亂改）：`settled`→收據預覽；冇枱／counter→小窗唯讀；
**未結堂食單→直接跳枱面編輯**。
🔴 KPI 帶固定 5 欄、格數須為 5 倍數 ⇒ 新指標寫入既有格 subtitle。
🔴 `button { font: inherit }` 壓過 `text-*` ⇒ 字級寫喺仔元素。
🔴🔴 `npm test`＝`node --test`：唔認 `@/` 別名、唔支援 `.tsx` ⇒ 可測模組零 import、邏輯/執行分檔；
import 鏈用相對路徑＋顯式 `.ts`。跑法：`node node_modules/typescript/bin/tsc --noEmit`、`node --test`。
npm/npx 跑唔到；冇 coreutils（用 Read/Glob/Grep）；複雜 JS 寫 `.cjs`；
⚠️ 改 memory／報告唔好經 `node -e`（反引號被命令替換、靜默食內容）。
git 用全路徑 PortableGit；push 前 export PATH；Vercel 改 env 要 **Redeploy**。

## 7 判別／取證
`isSaleCountable()`：只計 settled／帶 onlineOrderId 嘅 paid，日期用 Macau 邊界
⇒ **未結帳單永遠唔會出現喺報表／交班**（「搵唔到單」最常見嘅誤判）。
id 前綴＝建單程式：`order-` 收銀台/快餐／`staff-` 店員手機／`kiosk-` 自助機／`ledger-` 線上鏡像。
列表顯示時間＝最後更新；建立睇 `pos_orders.created_at`。事件 payload 兩形狀 ⇒ `sync-order-payload.ts`。
`storeId` 係公開值（枱 QR `?store=`）⇒ kiosk 手動輸入＝無密碼落單入口。
⭐ 生產取證最有效：`tools/_probe-*.cjs`（由 deployed bundle 抽 anon key 直讀 PostgREST，唯讀）
＋ `analyze-vercel-log.cjs`（按 `requestId` 去重）。Vercel log 冇 IP ⇒ route 內 `console.info(ip=…)`；
時間一律換 Macau(+8)。真瀏覽器驗證用 `localhost`（唔可 127.0.0.1）。

## 8 Egress／版本／同步
計費＝Supabase → Vercel Function（改 response 對帳單無幫助）。⭐ 最快取證＝解析 Vercel `[egress]` 行
（`tools/_egress-*.cjs`）。最大來源＝**舊分頁跑舊 bundle**（903KB ⇒ 690MB/h；新版 412KB）
⇒ 要「少拉」唔係「拉細」。指紋：`limit=300`＝舊、`limit=0`＝新。⚠️ Supabase CSV 匯出上限 1000 行。
✅ 2026-09-22 覆核：全清（0.7 次/分、心跳 0、claim 每 180s、904MB/日 → 估 10~20MB/日）。
🔴🔴 **伺服器唔可以用「partial payload ＋ 一個新欄位」去保護舊 client**（2026-09-22 P0b 迴歸）：
舊 client **唔會睇個新欄位**。凡係「可能令 `orders` 變空」嘅回應路徑，必須**要麼回真資料
（至少未結帳單），要麼唔回 200**。實案：`legacyThrottled` 回空骨架 → 舊 bundle 唔識
`incremental` → 照跑孤兒對賬 → **本機所有未結帳單被移入隔離區**（列表清空、每 3 秒重演）。
已修（節流骨架改回未結帳單）。**上游永遠係「仲有一部機跑舊 bundle」**：`[egress]` 見
`mode=legacyThrottled` 或 `[pos/state] 🔴 疑似舊版 bundle` ⇒ 即刻叫佢重新載入。
🔴 舊 bundle 亦冇 `skipped/server-newer` 終態 ⇒ 確定性拒收事件（stale／降級）**無限重推**
（實測 924 行 warn／45 秒、77 張單）＝ log 洗版 + 持續 egress。**唔好手動重跑 migration。**
🔴 **增量拉取（`since`）一定要兜底「未結帳單」**（`OPEN_ORDER_STATUSES` 一腿，2026-09-22 修）：
水位推過就**永久漏**且**唔觸發 `truncated`** ⇒ 連走全量嘅兜底都冇。
實案：訂單19（A01, 99）雲端 open、收銀機完全唔知 ⇒ 同枱再開新單，99 蚊冇人發現。
已落實：RPC `pos_orders_page`(0046)、`?skipQueue=1`、投影＋日期下限＋每日上限、
`poll-gate.ts`／`write-gate.ts`、queue 身分簽名、APK `nextPollMs`、`[egress]` log。
🔴 兩道 server 閘刻意 fail-open；`urgent:true` 唔可擋。版本：`build-info.ts`
（`NEXT_PUBLIC_BUILD_ID` 逐字面寫 `process.env.X`）；`x-pos-build` 標頭；只提示唔自動 reload。
✅ `build-stale-banner.tsx`（`/pos` 最頂 in-flow、有「立即重新載入」）：🔴 配套排版
外層 flex→flex-col、根 `h-[100dvh]`→`min-h-0 flex-1`（唔改底部被裁切）；守衛 `pos-app-stale-banner.test.ts`。
🔴 量度陷阱：唔可用全窗口平均（burst 會被稀釋）⇒ 用 gap>20s 分段。

## 9 POS 工作階段
表 `pos_sessions`（0047）／註冊 `/api/ledger/login`／續期搭既有請求（GET 只續期唔建立）／
client 標頭 `x-pos-session`＋`x-pos-build`。🔴 key 存 `sessionStorage`。
管理頁 `/admin/sessions`；強制關閉＝軟踢（只擋新生意、結帳放行）；門檻：使用中 ≤6 分／閒置 ≤30 分。
⏭️ 未做：`pos_shifts` Realtime 訂閱、print-agent 配對驗真補 env、per-store token、
`pos_print_jobs.kind`、同日重複單號（訂單27 ×2）、「同步健康」顯示舊 bundle 可見警告。
