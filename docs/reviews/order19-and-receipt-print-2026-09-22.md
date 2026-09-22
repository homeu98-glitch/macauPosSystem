# 訂單19「搜尋唔到」＋ 收據印唔出 —— 取證與修復（2026-09-22 19:40）

> 取證工具（唯讀，anon 直讀 PostgREST）：`tools/_probe-order19-20260922.cjs`、
> `_probe-order19b-20260922.cjs`、`_probe-order19c-20260922.cjs`、
> `_probe-printjobs-all-20260922.cjs`（輸出 `.out.txt` 為原始證據）。
> 店鋪 `storeId = 8291f843-9def-4956-9d0b-1cfef2598306`（表嫂美食）。

---

## 0 一句話結論

| 問題 | 結論 |
|---|---|
| 19 號訂單搵唔到 | **冇消失、冇漏單**。雲端確實有：`order-8317dc18 / 訂單19 / A01 / MOP 99`，但狀態係 **`sent_to_kitchen`（未結帳）** ⇒ 報表／交班（只計已收款）永遠唔會列；而收銀終端當時**根本唔知有呢張單**（A01 被另一張單佔住）。**嗰 99 蚊一直未收。** |
| 所有收據印唔出 | **收據嘅打印任務從來冇成功上雲**。收據行走 `pos-app.tsx` 自製嘅第二條入隊路徑（base 用 stale React state），廚房單走標準路徑 ⇒ 生產實測 kitchen **35/35** 上雲、receipt 只 **3 張且全部係人手補打**。中繼機 claim 唔到 ⇒ 零出紙；打印中心照顯示綠色「已發送」⇒ 完全誤導。 |

---

## 1 問題一：19 號訂單

### 1.1 資料庫實查（存在，但係「未結帳」）

```
id=order-8317dc18  單號=訂單19  status=sent_to_kitchen  台=A01  total=99
payment_method=NULL   source=pos   online_order_id=NULL
created_at = 2026-09-22 17:33:11 (+08)   ← 對得住廚房紙「單號19 / A01 / 17:33」
updated_at = 2026-09-22 18:00:06 (+08)
sent_to_kitchen_at = 17:33:11    served_at = NULL   reopen_count = 0
```

對照廚房紙：`pos_print_jobs` 有一行 `order_no=訂單19 / kitchen / printer / status=printed / 17:33:12`
⇒ **落單成功、廚房紙印出、單亦已上雲**，只係由頭到尾**冇結過帳**。

另外 `local_order_no = 訂單19` 在 9/21 都有一張（`order-7679e0eb / A02 / 119 / 會員餘額 / settled`）。
單號按日歸零 ⇒ **跨日重用係正常**，唔係重複。

### 1.2 為何「無論如何搜尋都找不到」—— 四個獨立原因

1. **狀態係「未結帳」，報表／交班設計上唔會列。**
   報表用 `isSaleCountable()`（只計 `settled` / 帶 `onlineOrderId` 嘅 `paid`）⇒ 在報表／交班
   點搜都唔會出現。**呢個唔係 bug，但係店員最常去搵單嘅兩個地方。**

2. **收銀終端當時唔知有呢張單（最嚴重）。**
   18:38 嘅桌台總覽顯示 **A01 = 「已下單 應收 MOP 46」**，而 46 係 **訂單24**（A01、18:31:51 開單）
   嘅金額 —— 即係部機將 A01 嘅未結單認成 訂單24，**完全唔知 訂單19（99）存在**。
   其後同一張 A01 又再開咗 **訂單29（19:33:30、98）**。
   ⇒ 一張 99 蚊嘅未結帳單就此「人間蒸發」，而且枱面睇落一切正常。

3. **本機清單只讀 localStorage，而增量拉取會永久漏單。**
   `local-orders-panel` 嘅資料源係 `loadOrders()`（本機）。跨機補單只有兩條路：
   Realtime（只推**變更**）+ `/api/pos/state`。
   而 2026-09-22 嘅增量優化係單腿 `updated_at > since`：
   **水位一旦被推過（該機離線一輪、或事件 flush 完之後水位已 commit），
   一張未結帳單就永遠跌出窗口，之後每次拉都唔會再見到佢** ——
   而且**唔會觸發 `truncated`**（行數根本冇撞 `limit`）⇒ 連「清水位走全量」嘅兜底都唔會發生。

4. **同日出現重複單號（另一個獨立缺陷）。**
   今日 `local_order_no` 重複：**`訂單27` ×2** ——
   `order-8c3fbd01 / MFOOD5 / MOP 70 / 19:03:47` 與
   `order-c4da9e79 / 澳覓4 / MOP 103 / 19:15:19`。
   ⇒ 任何「以單號搜尋／以單號對帳」嘅流程都會撞車（`daily-order-seq.ts` 開頭就係為咗防呢件事而寫）。

### 1.3 已修（程式碼）

**`src/app/api/pos/state/route.ts`** —— 增量之下加「未結帳單兜底腿」：

```ts
const OPEN_ORDER_STATUSES = ["draft", "sent_to_kitchen", "paid", "reopened"] as const;

// 只在 incremental 時開：額外拉一次「本店全部未結帳單」（通常 0–5 張，投影不變）
supabase.from("pos_orders")
  .select(POS_ORDER_DB_COLUMNS.join(","))
  .eq("store_id", storeId)
  .in("status", [...OPEN_ORDER_STATUSES])
  .order("created_at", { ascending: false })
  .limit(100)
```

* 兩條增量出口（`ordersOnly=1&since=` 同全量 state 嘅增量分支）都按 `id` 去重合併。
* ⚠️ `truncated` 判準改用 **未合併之前**嘅行數 `incrementalRawOrderCount` ——
  否則兜底腿多回嘅行會被誤判成「撞 limit」，令 client 每次都被迫走全量。
* 成本：正常 0–5 行 ≈ 1–3 KB。**「未結帳單」係唯一會漏錢嘅類別，唔可以靠增量。**

> 終態單唔使兜底：本機唔見都唔影響收錢，而報表本身係純雲端、永不 merge。

### 1.4 仍需人手處理（現場）

```sql
-- ① 確認訂單19 狀態（應該係 sent_to_kitchen、served_at 為 NULL）
select id, local_order_no, status, table_name, total, payment_method,
       (created_at at time zone 'Asia/Macau') as 落單澳門,
       (sent_to_kitchen_at at time zone 'Asia/Macau') as 落廚澳門, served_at
from public.pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306' and local_order_no = '訂單19'
order by created_at;

-- ② 今日「枱面仲未結帳」嘅單（呢批就係會漏錢嘅）
select local_order_no, table_name, total, status,
       (created_at at time zone 'Asia/Macau') as 落單澳門
from public.pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and status in ('draft','sent_to_kitchen','paid','reopened')
order by created_at;
-- 2026-09-22 19:40 實測：訂單19(A01, 99)、訂單25(A03, 41)、訂單29(A01, 98)
```

* 客人已走、錢冇收 ⇒ 用**返結／作廢**流程收口（唔可以直接改 DB 狀態，否則報表口徑會亂）。
* 客人已付款但漏記（例如現金） ⇒ 走正常補結帳，令 `payment_method` 有值。
* 部署新版之後，叫收銀台**重新載入**；之後未結帳單即使本機漏過都會被兜底補返。
* 順手檢查 `訂單27` 重複單號係邊條建單路徑造成（`MFOOD5` 收銀台 vs `澳覓4` 交付平台），
  呢個係另一條獨立線，**未修**。

---

## 2 問題二：所有收據都印唔出

### 2.1 生產證據（今日 `pos_print_jobs` 全量 38 行）

| printer_group | 張數 | status |
|---|---|---|
| kitchen | 35 | 全部 `printed` ✅ |
| receipt | 3 | 訂單07 12:37、訂單15 14:01、訂單26 19:16，全部 `printed` ✅ |

* 今日有 **28 張已結帳單**，但 receipt 只有 3 張 ⇒ **自動結帳收據幾乎完全冇上雲**。
* 更關鍵：**呢 3 張嘅 `once_key` 全部係 `NULL`**。
  自動結帳路徑（`printReceipt()`）一定會寫 `onceKey = receipt:${reopenCount}`
  ⇒ **冇 once_key 就代表佢哋全部係「人手補打」**（`reprintReceiptForOrder` /
  點餐頁「打印收據」/ 線上單補打）。
  ⇒ **自動結帳收據今日一次都冇成功過。**

打印中心截圖（19:24）嘅實況完全對得上：

| 打印中心顯示 | 雲端 `pos_print_jobs` |
|---|---|
| 訂單22 A02 小票機 18:56 **已發送** | **冇呢一行** |
| 訂單24 A01 小票機 18:56 **已發送** | **冇呢一行** |
| 訂單27 MFOOD5 小票機 19:03 **已發送** | **冇呢一行** |
| 訂單27 MFOOD4 小票機 19:15 **已發送** | **冇呢一行** |
| 訂單26 A04 小票機 19:18 打印成功 | 有（19:16:36、`printed`）✅ |
| 各張「printer」（廚房機） | 有 ✅ |

⇒ 實體出紙通道係「雲端 `pos_print_jobs` → 中繼 APK claim 出紙」，
   **雲端冇 job = 一張紙都唔會出**；而本機 dispatch 嘅 relay 分支係 no-op 但樂觀回
   `{ ok: true }` ⇒ 本機被標成「已發送」⇒ **打印中心綠色、底部零紅標、店員零線索**。

### 2.2 根因（程式碼）

`src/components/pos-app.tsx` 存在**第二套**打印入隊實作：

```ts
// 舊寫法（已移除）
function enqueuePrintJobs(jobs: PrintJob[]): number {
  const kept = claimOncePrintJobs(jobs);
  persistPrintJobs([...kept, ...printJobs]);          // 帶住 stale React state 陣列
  pushEvents(kept.map(/* PRINT_JOB_CREATED */));      // ← pushEvents 用 React state `queue` 做 base
}
```

對比標準路徑 `appendPrintJobsWithSync()`（`@/lib/pos/print-job-enqueue`）：

```ts
persistMergedPrintJobs(kept);                 // 以 localStorage 為真源 + tombstone 過濾
enqueuePrintJobCreatedEvents(kept);           // enqueueEvents(loadQueue(), withStoreScope(...))
```

兩個實質差異：

1. **base 用 React state `queue` 而唔係 `loadQueue()`。**
   結帳 handler 同一個 tick 內 `pushEvents()` 會被呼叫**兩次**：
   ① `pushEvents([paymentEvent])`（`ORDER_SETTLED`）
   ② `printReceipt()` → `enqueuePrintJobs()` → `pushEvents([...PRINT_JOB_CREATED])`
   兩次都讀**同一個 render 嘅 `queue` 快照**（`setQueue` 要等 handler 完結先 flush），
   第二次用舊快照重建整條隊列再 `saveQueue()` ⇒ **第一次啱啱入隊嘅事件被靜默冚走**。
   ⇒ 呢個亦解釋咗另一批症狀：雲端有 3 張單**永遠停在 `sent_to_kitchen`**（結帳事件丟失）。
   **同 3602 行 `syncNow()` 嘅註釋係同一個病根**（當年已修過一次，呢處係漏咗嘅第二處）。
2. **兩套「落本機」語義**（`persistPrintJobs` vs `persistMergedPrintJobs`）⇒ 日後加欄位
   極容易只改一邊（同「加 `pos_orders` 欄位要改四條讀取路徑」同一類陷阱）。

### 2.3 已修（程式碼）

| 檔案 | 改動 |
|---|---|
| `src/components/pos-app.tsx` | `pushEvents()` base 由 `queue` → **`loadQueue()`**（唯一真源） |
| `src/components/pos-app.tsx` | `enqueuePrintJobs()` 改為**委派 `appendPrintJobsWithSync()`**（只補 `setPrintJobs(loadPrintJobs())` 令同 tick 畫面一致） |
| `src/components/pos-app.tsx` | `printReceipt()` 兩個 early return（總開關關咗 / 冇收據機）由 dev-only `console.warn` 改為**出 toast 講清楚** |
| `src/lib/pos/pos-app-queue-base.test.ts` | 新增源碼契約守衛（5 個 assertion） |

### 2.4 仍需人手核對（部署後）

1. **設備設置 → 打印開關設置**：確認「結帳收據」係**開**。
2. **設備設置 → 打印機**：至少一台 `role = 小票機(receipt)` 且**已啟用**、紙闊 80mm。
3. **重新部署**（Vercel 改完 env/代碼要 Redeploy），收銀台見到版本過期橫幅就撳「立即重新載入」。
4. 實測一單：結帳 → 同時核對三處
   * 實體出紙；
   * 打印中心狀態（應該由「已發送」變「打印成功」）；
   * 雲端有冇一行 `printer_group = 'receipt'` 且 `once_key = order-xxxxxxxx|receipt:0|<printerId>`：

```sql
select order_no, printer_name, status, once_key, attempts, last_error,
       (created_at at time zone 'Asia/Macau') as 建job澳門,
       (finished_at at time zone 'Asia/Macau') as 完成澳門
from public.pos_print_jobs
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and printer_group = 'receipt'
order by created_at desc limit 20;
```

> 另註：今日全部 job 嘅 `kind` 欄都係 `NULL`（mapper 冇寫呢欄）。唔影響出紙
> （下游靠 `printer_group` + `template`），但屬同類「加欄位只改一條路徑」嘅味道，值得跟。

---

## 3 驗證清單

```bash
# 型別
node node_modules/typescript/bin/tsc --noEmit         # ✅ 0 error
# 單測（含新守衛）
node --test                                            # ✅ 1192 pass / 0 fail
# 只跑新守衛
node --test src/lib/pos/pos-app-queue-base.test.ts      # ✅ 5 pass
```

---

## 4 改動檔案一覽

| 檔案 | 類型 |
|---|---|
| `src/components/pos-app.tsx` | 修 `pushEvents()` base、`enqueuePrintJobs()` 委派、`printReceipt()` 出聲 |
| `src/app/api/pos/state/route.ts` | 增量之下加未結帳單兜底腿 + `mergeRowsById` + truncated 判準修正 |
| `src/lib/pos/pos-app-queue-base.test.ts` | 新增守衛測試 |
| `tools/_probe-order19{,-b,-c}-20260922.cjs`、`tools/_probe-printjobs-all-20260922.cjs` | 唯讀取證腳本（留住日後照跑） |
| `tools/diagnose-missing-orders-20260922.sql` | 今日較早時段嘅 SQL 診斷（沿用） |

**未修（已記錄，另一個獨立議題）**：同日重複單號（`訂單27` ×2）、
`pos_print_jobs.kind` 冇寫入、`pos_shifts` Realtime 訂閱、per-store token。

---

## 附錄 A（20:10 追加）：撳「查看」跳去「選擇工作台」—— 舊路徑未跟改

### 病徵

商家：「我一按訂單19嘅查看，就會跳到工作台的介面」——即係彈出
「請選擇要進入嘅工作台（堂食收銀台／快餐收銀台／…）」，入唔到枱面。

### 根因：2026-09-17「統一入口」改動漏改兩處深連結

`/` 自 2026-09-17 起由**收銀台**改成**統一入口／選擇工作台**頁（`src/app/page.tsx`），
收銀台搬去 `/pos`（`src/app/pos/page.tsx`）。但 `local-orders-panel.tsx` 兩處仍然推 `/?…`：

| 位置 | 情境 | 舊寫法 |
|---|---|---|
| 「查看」掣（非 settled、真枱號） | 未結堂食單 → 跳枱面編輯 | `router.push(\`/?tableId=…&orderId=…\`)` |
| 返結成功之後 | 跳去 temp 枱重結 | `router.push(\`/?tableId=…&orderId=…\`)` |

⇒ 一次過影響兩條重要流程（**睇單** 同 **返結後重結**）。

**更陰險嘅第二層**：`pos-app.tsx` deep-link 消費完 query 之後係
`window.history.replaceState(null, "", "/")` —— 連**路徑**都改走。
即係就算推嘅係 `/pos`，收銀員一 reload／一按返回／一分享，都會跌返選擇頁。

> 「查看」掣本身嘅**設計**係：`settled` → 收據預覽；冇枱號／counter → 小窗唯讀；
> **未結堂食單 → 直接跳枱面**（因為要加菜／結帳，唔係純睇）。呢個設計唔變。

### 已修

| 檔案 | 改動 |
|---|---|
| `src/components/local-orders-panel.tsx` | 「查看」＋返結後嘅 `router.push` → **`/pos?tableId=…&orderId=…`** |
| `src/components/pos-app.tsx` | deep-link 清 query 改用 `window.location.pathname`（保留路徑） |
| `src/lib/pos/pos-deeplink-path.test.ts` | 新增守衛：全 `src/` 唔准 router 推根路徑；`replaceState` 必須保留 pathname |

### 部署後驗證

1. 去 `/orders` → 未結嘅堂食單撳「查看」⇒ 應該直接入到**枱面**（見到該枱已載入），
   地址列係 `/pos?...`（消費完 query 會被清、但**路徑保持 `/pos`**）。
2. 撳「返結帳」完成之後 ⇒ 同樣應該落到 temp 枱可重結，唔會彈選擇工作台。
3. 隨手按瀏覽器 reload ⇒ 應該停留喺收銀台，唔會彈「請選擇要進入嘅工作台」。

