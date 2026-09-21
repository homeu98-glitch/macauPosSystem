# 用量優化落實方案（Supabase macauPos ＋ Vercel）

> 日期：2026-09-21 ｜ 依據：Supabase filter＝`macauPos` 用量圖 ＋ Vercel `macau-pos-system` Usage 圖
> 配套分析：`docs/reviews/supabase-egress-root-cause-2026-09-21.md`
> **狀態：方案待你核准，未改任何生產程式碼。**

---

## 0. 兩張圖一齊睇，得出咩結論

### 0.1 Supabase（filter ＝ `macauPos`）→ 確認係 POS 專案

| 事實 | 數值 |
|---|---|
| 18 Sep 分項 | **PostgREST 1.4555 GB（99.3%）** ／ Realtime 9.925 MB（0.7%） |
| 帳期 | 02 Sep → 02 Oct，已用 **6.13 GB** / 5 GB ⇒ **超 1.13 GB** |
| 曲線形態 | 11 Sep 前近乎零 → 13 Sep 起**逐日爬升** → **17–19 Sep 尖峰（1.29 / 1.47 GB）** → 21 Sep 回落約 200 MB |

✅ 既然 filter 係 `macauPos`，就**排除 Ledger 專案**干擾 ⇒ 根因報告 §3 嗰四條路徑全部適用。
🔎 曲線「逐日爬升」呢個形態本身就是證據：**每次拉取都係拉「全店歷史」，而歷史逐日變大**（見 §1 A1）。

### 0.2 Vercel（`macau-pos-system`）→ 係另一個獨立問題：**請求次數太多**

| 指標 | 用量 | 收費 |
|---|---|---|
| Edge Requests | 157,030 | $0.00 |
| Edge Requests – Additional CPU | 23.68 秒 | $0.00 |
| **Fast Origin Transfer** | **3 GB** | **$0.71** |
| Fast Data Transfer | 1 GB / 1 TB | $0.00 |
| **Function Invocations** | **131,010** | $0.08 |
| Fluid Active CPU | 2 小時 | **$0.33** |
| Fluid Provisioned Memory | 24.6 GB Hrs | **$0.33** |
| ISR Reads | 5,930 | $0.00 |
| **合計** | | **≈ $1.45** |

**🔴 交叉校準（呢步好重要，證明診斷冇走錯方向）**

| | Supabase 側 | Vercel 側 |
|---|---|---|
| 同一批請求 | PostgREST 回咗 **6.07 GB** 入 function | function 對外送出 **3 GB** |
| 差距來源 | PostgREST 回 snake_case **全欄位（含 NULL）**；Vercel 對瀏覽器做壓縮 | |
| 解讀 | 兩邊「同一個量級、同一個趨勢」⇒ 描述嘅係同一件事，**診斷成立** | |

⇒ 附帶結論：**減少 PostgREST payload ＝ Vercel 傳輸同 Supabase egress 兩邊同時得益。**
反過來講，目前每 1 GB 有效資料背後都搬運了約 2 倍。

**131,010 invocations ≈ 每日 6,238 次**。按程式碼實據拆解（假設收銀台開 12 小時／日）：

| # | 來源 | 頻率（code） | 次／日 | 佔 invocations | 每次打咩 |
|---|---|---|---|---|---|
| **1** | 🔴 **`/api/topup/pending-count`**（側欄「充值待審」badge） | **30 秒** | ~1,440 | **~23%** | Ledger Auth + 2 次 select + 1 次外部站 HTTP |
| **2** | 🔴 **對賬守護 pull** | 60s 掃描 | 500–1,700 | 8–27% | `pos_orders` 全店歷史 |
| **3** | 🟠 `/api/pos/shift` 班次同步 | 60 秒 | 720 | ~12% | `pos_shifts` |
| 4 | 全量 state（`/api/pos/state`） | 事件驅動 | 200–500 | 3–8% | orders + queue + printJobs |
| 5 | `POST /api/pos/sync` | 每批 flush | 30–300 | 1–5% | 寫入 |
| 6 | 報表（3 分鐘）／打印中心（8 秒）／訂單頁／交班頁 | 開頁時 | 其餘 | | |

---

## 1. 🔴 新發現：為咗一個「紅點」而每 30 秒打 6 次上游

**證據鏈：**

```
pos-app.tsx:4716             <AppSidebar />            ← 收銀台無條件渲染
app-sidebar.tsx:113          useTopupPendingCount()    ← 預設 slow
use-topup-pending-count.ts:17  startTopupPendingPolling("slow")
pending-count-store.ts:31      fastPollers > 0 ? 12_000 : 30_000   ← 30 秒
```

而 `app/api/topup/pending-count/route.ts` **每一次**都做：

1. `supabase.auth.getUser(accessToken)`（Ledger Auth）
2. `merchant_staff` select（`:44`）
3. `merchants` select（`:55`）
4. `fetchTopupShopId()`（`:63`）
5. **對外部充值站 `fetch()`**（`:80`，連網外）
6. 才回一個 `pendingCount` 數字

⇒ 為咗側欄一個紅點，每日約 **1,440 次 × 5~6 個上游往返 ＋ 1,440 次外部站呼叫**。
`members-page.tsx:109` 更用 `{ fast: true }` ⇒ 12 秒。

**呢個唔係猜測**：131,010 ÷ 21 日 ≈ 6,238／日，單單呢一項就佔約 23%（若只計有開機嘅日子佔比更高）。

---

## 2. 優化清單（兩條獨立軌）

| 編號 | 改動 | 主要得益 | 預期降幅 | 風險 | 工作量 |
|---|---|---|---|---|---|
| **A1** | 對賬守護：投影 ＋ 日期下限 ＋ TTL | **Supabase egress（最大單一）** ＋ Vercel invocations | **PostgREST −90%+** | 低（有 fallback） | 1–2 h |
| **A2** | 三條時間腿 → 單一 RPC | Supabase egress（所有報表／state 讀取） | **每次 −67%** | 中（要跑 migration） | 2–3 h |
| **A3** | 全量 state 收身（唔查 queue、唔拉 200 條 printJobs） | Supabase egress | **每次 −50~70%** | 低 | 1 h |
| **A4** | 報表降頻（3 分鐘 → 10 分鐘）＋ PAGE 2000 → 500 | Supabase egress | −70%+ | 低 | 15 min |
| **B1** | 充值 badge 30 秒 → 5 分鐘（＋回到前景才拉） | **Vercel invocations（最大單一）** | **invocations −20%** | 低 | 30 min |
| **B2** | 班次同步 60 → 180 秒、只喺需要時 | Vercel invocations | −8% | 低 | 30 min |
| **B3** | 打印中心 8 → 30 秒 | Vercel invocations（開頁時） | −15%（該頁） | 低 | 10 min |
| A5 | 全域 `SELECT *` → 投影 | Supabase egress | −30% | 中 | 3–4 h |
| — | ~~KDS~~ | — | 0（已停用） | — | — |
| — | ~~閹 Realtime~~ | — | ❌ 唔好做（只佔 1%） | — | — |

---

## 3. 具體改動（可以直接照做）

### A1 ★ 對賬守護收口（最高 ROI）

**(a) 加欄位投影 —— 7 MB → 0.43 MB（16×）**

`src/lib/pos/sync-reconcile.ts:142`

```diff
 export async function fetchServerOrders(
   storeId: string,
   startIso: string | null,
+  /** 白名單欄位投影（server 端下推 .select()）。預設 undefined = 全欄位（舊行為）。 */
+  fields?: string,
 ): Promise<{ orders: PosOrder[]; error?: string }> {
   const params = new URLSearchParams({ storeId, ordersOnly: "1", limit: "5000" });
   if (startIso) params.set("start", startIso);
+  if (fields) params.set("fields", fields);
```

`src/app/api/pos/state/route.ts`（`ordersOnly` 分支之前）

```diff
+/** 🔴 只准白名單欄位，防止 `fields=*` 之類被濫用。 */
+const ORDER_FIELD_WHITELIST = new Set([
+  "id", "store_id", "status", "updated_at", "created_at", "reopened_at",
+  "client_updated_at", "local_order_no", "table_id", "table_name",
+  "total", "online_order_id", "reopen_count",
+]);
+const rawFields = searchParams.get("fields")?.trim() || "";
+const fields = rawFields
+  ? rawFields.split(",").map((f) => f.trim()).filter((f) => ORDER_FIELD_WHITELIST.has(f))
+  : null;
+// 投影模式只喺 ordersOnly 用（全量 state 需要完整 row）
+const selectColumns = ordersOnly && fields?.length ? fields.join(",") : "*";
```

然後 `fetchOrdersInRange` 加一個 `columns` 參數，把 `base()` 嘅 `.select("*")` 換成 `.select(columns)`。

**(b) 用返現成嘅日期下限助手**（檔案早就有，只係守護冇用）

`src/lib/pos/sync-reconcile-daemon.ts:207`

```diff
-    const { orders: serverOrders, error } = await fetchServerOrders(storeId, null);
+    // 🔴 唔可以再傳 null：null = 拉全店歷史（limit 5000）。用 7 日窗口內最舊終態單 − 12h 做下限。
+    const startIso = computeServerRangeStart(loadOrders());
+    const { orders: serverOrders, error } = await fetchServerOrders(storeId, startIso, VERIFY_FIELDS);
```

```ts
/** 核實只需要呢三欄（7 MB → 0.43 MB）。 */
const VERIFY_FIELDS = "id,status,updated_at";
```

**(c) TTL 10 分鐘 → 1 小時**（`src/lib/pos/sync-acks.ts:149`）

```diff
-export const RECONCILE_ACK_TTL_MS = 10 * 60 * 1000;
+// 10 分鐘 → 60 分鐘：偵測「雲端被回水」嘅延遲由 10 分鐘變 60 分鐘（單店可接受），
+// 但守護嘅全店拉取次數直接變 1/6。呢個係本專案 egress 嘅最大單一控制點。
+export const RECONCILE_ACK_TTL_MS = 60 * 60 * 1000;
```

**(d) 每日拉取預算硬閘**（防病態循環）

```ts
/** 每部機每日最多拉幾多次雲端（正常營業日遠低於此）。超過即停，只寫告警。 */
const MAX_PULLS_PER_DAY = 24;
let pullDayKey = "";
let pullsToday = 0;
function withinPullBudget(): boolean {
  const key = new Date().toISOString().slice(0, 10);
  if (key !== pullDayKey) { pullDayKey = key; pullsToday = 0; }
  return pullsToday < MAX_PULLS_PER_DAY;
}
```

> **更徹底嘅做法（建議下一輪做）**：開 `POST /api/pos/orders/verify`
> `{ storeId, ids: [...≤100] }` → `select id,status,updated_at where store_id=$1 and id = any($2)`。
> 成本由「全店 5000 張」變成「我問嘅 100 張」，每輪 KB 級，**徹底消滅「輪次 × 全店」乘數效應**。
> 代價：要加一條 route（+ 客戶端改 1 個呼叫點）。

---

### A2 ★ 三條時間腿 → 單一 RPC（每次省 2/3）

問題：`src/lib/pos-orders-range.ts:85-96` 每「一頁」並行 3 條 query（`created_at` / `updated_at` / `reopened_at`），
各自 `.select("*")` 同 `.range()`，回嚟嘅超集再喺 client 去重 ⇒ **DB → function 嗰段照俾 3 份錢**。

```sql
-- supabase/migrations/0046_pos_orders_page_rpc.sql（待核准後才建立／執行）
create or replace function public.pos_orders_page(
  p_store_id uuid,
  p_start timestamptz,
  p_end   timestamptz,
  p_limit int,
  p_offset int
) returns setof public.pos_orders
language sql stable security definer set search_path = public as $$
  select o.*
  from public.pos_orders o
  where o.store_id = p_store_id
    and p_start is not null and p_end is not null
    and (
         o.created_at  between p_start and p_end
      or o.updated_at  between p_start and p_end
      or o.reopened_at between p_start and p_end
    )
  order by o.created_at desc
  limit  greatest(1, least(p_limit, 5000))
  offset greatest(0, p_offset);
$$;

revoke all on function public.pos_orders_page(uuid, timestamptz, timestamptz, int, int) from anon, authenticated;
grant execute on function public.pos_orders_page(uuid, timestamptz, timestamptz, int, int) to service_role;

-- ⚠️ 必須同 migration 0044 一齊跑（三個索引），否則 reopened_at 腿會慢。
```

好處：**1 次 round trip、每行只回一次**（即時 −67%），而且順便解決 `.or()` 解析歧義嘅歷史包袱。
`fetchOrdersInRange()` 改為呼叫 `supabase.rpc("pos_orders_page", {...})`，保留現有回傳型別 ⇒ client 唔使改。

---

### A3 全量 state 收身

**(a) v2 之下唔再查 `pos_queue_events`（每次省 ~500 KB）**

v2 outbox 之下 client **完全唔用** `payload.queue`（`pos-app.tsx:1209` `!isOutboxV2Enabled()`），
但 `pos/state/route.ts:140` 每次都查 300 條（每條 `payload` ＝ 完整訂單快照 ≈ 1.67 KB）。

```diff
-  const queueQuery = storeId
-    ? supabase.from("pos_queue_events").select("*").eq("store_id", storeId).order("created_at", { ascending: false }).limit(300)
-    : supabase.from("pos_queue_events").select("*").limit(0);
+  // 🔴 v2 outbox 之下 client 唔會 merge server queue（見 pos-app.tsx:1209）⇒ 唔應該再拉。
+  //    呼叫端可以傳 ?skipQueue=1；v1 回溯時唔傳就得。
+  const skipQueue = searchParams.get("skipQueue") === "1";
+  const queueQuery = skipQueue
+    ? Promise.resolve({ data: [], error: null })
+    : storeId
+      ? supabase.from("pos_queue_events").select("*").eq("store_id", storeId).order("created_at", { ascending: false }).limit(300)
+      : supabase.from("pos_queue_events").select("*").limit(0);
```

客戶端（`pos-app.tsx:1124`）在 `isOutboxV2Enabled()` 時加 `&skipQueue=1`。

**(b) `local-orders-panel.tsx:239` 補上 `ordersOnly=1`**

```diff
-      const res = await fetch(`/api/pos/state?storeId=${encodeURIComponent(merchantId)}`, {
+      // 呢個 panel 只需要 orders；原本拉足 orders+queue+printJobs（0.98 MB）＝ 浪費。
+      const res = await fetch(`/api/pos/state?storeId=${encodeURIComponent(merchantId)}&ordersOnly=1`, {
```

**(c) `printJobs` 由「每次 200 條」改增量**（可選，第二步）
`?printJobsSince=<iso>` → 只回 `created_at > since` 嘅 job。

---

### A4 報表降頻降頁

`src/components/restaurant-daily-report.tsx`

```diff
-const AUTO_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
+/** 3 → 10 分鐘：報表係「對數」用途，10 分鐘延遲可以接受，而成本直接變 1/3。 */
+const AUTO_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
```

```diff
-      const PAGE = 2000;
+      const PAGE = 500;   // 配合 A2 嘅單一 RPC；單頁 8.41 MB → ~0.3 MB
```

「全部」範圍建議加二次確認，或改成「先出聚合、撳明細才分頁拉」。

---

### B1 ★ 充值 badge 降頻（Vercel 最大單一改動）

`src/lib/topup/pending-count-store.ts:30`

```diff
 function getPollIntervalMs() {
-  return fastPollers > 0 ? 12_000 : 30_000;
+  // 側欄一個紅點唔需要 30 秒新鮮度；而每次拉要打 Ledger Auth + 2 select + 外部站 HTTP。
+  return fastPollers > 0 ? 60_000 : 300_000;
 }
```

```diff
 export function startTopupPendingPolling(mode: "slow" | "fast") {
   ...
   schedulePoll();
   void refreshTopupPendingCount();
+  // 回到前景即刻拉一次（30s → 5min 之後唔會漏咗即時性）
+  const onVisible = () => {
+    if (document.visibilityState === "visible") void refreshTopupPendingCount();
+  };
+  document.addEventListener("visibilitychange", onVisible);
```

（`pending-count-store.ts` 現時冇移除 listener，要一併喺 `schedulePoll` 重設時處理，或改用 module-level 單一 listener。）

順帶建議：`members-page.tsx:109` 嘅 `fast: true`（12 秒）改成 60 秒。

---

### B2 班次同步降頻

`src/components/pos-app.tsx:745`

```diff
-    const timer = window.setInterval(() => void syncOnce(), 60_000);
+    // 班次狀態唔需要分鐘級新鮮度；60 → 180 秒省 2/3 invocations。
+    // （focus / online / adopt 邏輯不變，仍然保證「切返嚟就即刻對齊」。）
+    const timer = window.setInterval(() => void syncOnce(), 180_000);
```

### B3 打印中心降頻

`src/components/print-center.tsx:441`

```diff
-    const interval = window.setInterval(tick, 8000);
+    // 8 → 30 秒。呢頁長開一晚原本約 0.4 GB 流量／10,800 次 invocations。
+    const interval = window.setInterval(tick, 30_000);
```

---

## 4. 預期效果

| 指標 | 現況 | A1~A4 後 | B1~B3 後 | 全部完成 |
|---|---|---|---|---|
| Supabase PostgREST（20 日） | **6.07 GB**（峰值 1.47 GB／日） | < 0.6 GB | 不變 | **< 0.6 GB（−90%）** |
| Vercel Function Invocations | **131,010** | ~90,000 | ~60,000 | **~55,000（−58%）** |
| Vercel Fast Origin Transfer | 3 GB | ~1 GB | ~0.8 GB | ~0.8 GB |
| Vercel 費用 | ≈ $1.45 | ≈ $0.9 | ≈ $0.6 | **< $0.6** |
| 超額情況 | 6.13 / 5 GB（超 1.13 GB） | 回到額度內 | 回到額度內 | **餘量充足** |

> ⚠️ 降幅估算嘅不確定度主要喺「守護實際拉幾多次」—— 呢個要 Step 1（`pg_stat_statements` 按 `rows`）
> 或 Vercel log 數 `limit=5000` 呼叫次數才坐實。**但 A1 嘅方向唔會錯**：拉全店歷史 + 每 10 分鐘重來，
> 無論實際次數幾多，收口之後都係數量級下降。

---

## 5. 執行次序（建議）

**第 1 批（低風險、即見效，唔使 migration）**
1. A1 (a)(b)(c) 守護投影 + 日期下限 + TTL 60 分鐘 → **單獨已可令帳單回到額度內**
2. B1 充值 badge 降頻 → invocations −20%
3. A3 (a)(b) state 唔查 queue ＋ 訂單頁補 `ordersOnly=1`
4. A4 報表 3 → 10 分鐘、B2 班次 180 秒、B3 打印中心 30 秒

**第 2 批（需要 migration / 較大改動）**
5. A2 單一 RPC（要跑 0046 ＋ 0044 索引）
6. A5 全域 `SELECT *` → 投影
7. A1 (d) 每日預算硬閘 ＋（可選）`/api/pos/orders/verify` 精準核實端點

**每批之後**：睇 Supabase Egress 日曲線 ＋ Vercel Usage，確認降幅符合預期。

---

## 6. 仍待量度確認嘅兩點

1. **守護實際每日拉幾次** → Supabase SQL Editor 跑 `pg_stat_statements` 按 `rows` 排序
   （或 Vercel log 搜 `limit=5000`）。呢個數字決定 A1 能否單獨達標。
2. **`Fast Data Transfer` 只 1 GB vs `PostgREST` 6.07 GB** → 已用「壓縮 ＋ 欄位投影」解釋，
   但如果你想精準對帳，建議喺 `pos/state` route 加一行 `console.info('[pos/state] bytes=…')`，
   跑一日之後兩邊數字就可以逐條對上。
