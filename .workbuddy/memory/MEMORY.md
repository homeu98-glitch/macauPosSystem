# macauPos 記憶（2026-09-24 · 壓縮）

> 開工前必讀 `docs/113-agent-gotchas.md`；流程已成 `pos-*` skills。
> **細節／數據／時間線 → `DETAIL-2026-09.md` §A–§H**；本檔只放「唔可以違反嘅規則」。
> POS=`iyrywzormzisyppkokbi`；Ledger=`zymdemjflsckicwcinxl`。0050 已跑；**0051–0053 已寫未部署**。
> 09-24 營業中 egress 覆核（0.06／250 GB）→ §G；下載入口／版本控制 → §H。

## 0 訂單時間（唯一真源）
`order-event-time.ts` `orderEventInstant()`：reopenedAt→originalSettledAt→updatedAt→createdAt；篩選＋顯示全委派它。雲端冇 `original_settled_at` ⇒ 靠 `updated_at` ⇒ 🔴 週期性推前 `updated_at` 會令單**跨日漂移**（DETAIL §G.1）。`fetchOrdersInRange()` 三腿（0044）。

## 1 數字夾唔埋
下單機＝本機優先／第二台＝純雲端 state／交班＝LWW／**報表＝純雲端永不 merge**。實收＝毛＝`agg.paidTotal`。🔴 交班 `netPaidTotal`（＋未退）vs 報表 `netRevenue`（−退款）方向相反，唔可互抄。要逐張加總對 UI，唔可憑「差額合理」落結論。

## 2 返結四鐵律
①同機正常≠已上雲（查 `reopen_count`）②維持 `reopened`＋`keepPaidStatus` 認 `paid`/`reopened`（否則 items 永不上雲）③reopen_count/at/reason 單調遞增 ④🔴 加 `pos_orders` 欄位要改**四條**讀取路徑：`pos-order-mapper`／`pos-order-row`／`/api/pos/orders` 內聯 mapper／`sync` `baseRecord`。

## 3 鑑權
閘＝`posRouteAuthGuard()`，須放喺 early-return **之後**。🔴 `POS_REQUIRE_DEVICE_AUTH` **冇設＝開閘**。TTL 12h。🔴🔴 anon 讀 `pos_orders`(72h/0041)、`pos_print_jobs`(24h/0021) 係**刻意時間窗 RLS**，唔可移除或收短（三個 Realtime 消費者靠 anon 訂 `postgres_changes`；收緊＝零事件但照 `SUBSCRIBED`）⇒ 出紙 1–3 秒變最長 180 秒。守衛 `print-and-order-realtime-guard.test.ts`（25 條）。per-store token 見 DETAIL §A（自簽已否決：ECC P-256 私鑰取唔到）。

## 4 打印／中繼
🔴🔴 入隊只准 `appendPrintJobsWithSync()`；`appendPrintJobs()` **只寫本機**（唯一用途 `printKioskReceiptForOrder()`）。`pushEvents()` base 一定要 `loadQueue()`。去重靠 `onceKey`（id 係 randomUUID ⇒ 按 id merge 攔唔到）。`paired:true`≠在線。爆紙用 `pos_void_stale_print_jobs()`。claim 60s（有 job）／180s 封頂（idle）。🔴 落結論前用生產 log／DB 核對。

## 5 訂單／交班
結帳/免單/完成一律 `resolveSettleTargetOrder()`（只限當前枱）。`print-xxxxxxxx`＝PrintJob 漏入 orders，已由 `order-id-guard` 擋住。🔴 三軌互不相干：`pos_shifts`（擋收銀台）／`pos_store_status.is_open`（線下）／Ledger `merchant_enabled`（線上）。總掣 `close-gate.ts`＋`close-gate-run.ts`：先線下後線上／線下失敗唔 return／null＝skipped／永不 throw；須排喺 `closeShift()` early return **之前**。🔴 `pos_store_status` 冇 row＝營業中；`pos_shifts` 冇 open row＝未開工（**方向相反**）。

## 6 UI／環境
收銀台＝`/pos`；`/`＝工作台選擇。深連結一律 `/pos?tableId=&orderId=`，**唔准推 `/`**；清 query 用 `replaceState(null,"",location.pathname)`（守衛 `pos-deeplink-path.test.ts`）。KPI 帶固定 5 欄。`button{font:inherit}` 壓過 `text-*` ⇒ 字級寫仔元素。🔴 `npm test`＝`node --test`：唔認 `@/`／`.tsx` ⇒ 可測模組零 import、邏輯與執行分檔。

## 7 判別／取證
`isSaleCountable()`：只計 settled／帶 `onlineOrderId` 嘅 paid，Macau 日界 ⇒ 未結帳單永不入報表。id 前綴＝建單程式。`storeId` 係公開值。⭐ `tools/log-recheck.cjs --both`、`probe-anon-exposure.cjs`（DETAIL §F）。🔴 量度陷阱：Vercel 一行 log＝一行 CSV 且倍數**可變** ⇒ 按 `requestId` 去重；兩份 log 窗口通常唔重疊，只比速率；CSV 有引號內換行。多部中繼機混算 claim 會被腰斬 ⇒ **逐 `agent_id` 拆**。

## 8 Egress／版本／同步
最大來源＝舊分頁跑舊 bundle（`limit=300`）⇒ 要「少拉」唔係「拉細」。🔴🔴 唔可用 partial payload 保護舊 client：凡可能令 `orders` 變空嘅回應，**要麼回真資料、要麼唔回 200**。🔴 水位只可喺 `Array.isArray(payload.orders)` 時推進；增量拉取保持**單腿**。`orders` store 只准放訂單 id（`order-id-guard`）。🔴 版本偵測**唔可以加請求** ⇒ 搭 `state`／`sync`(30s)／`shift`(180s) 回應標頭（`buildJson()` 包裝），守衛 `build-header-contract.test.ts`；橫幅只喺 `/pos` 頁頂 in-flow。

## 9 POS 工作階段
`pos_sessions`(0047)；續期搭 `sync`(60s)＋`state`(5 分，GET 只續期)；標頭 `x-pos-session`／`x-pos-build`；key 存 `sessionStorage`。🔴 `account` **唔可以**傳空/null（`verifyPosDeviceToken` 拒收 ⇒ 全店 401）。
