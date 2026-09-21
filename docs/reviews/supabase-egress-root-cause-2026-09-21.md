# Supabase Egress 暴增 — 根因分析與優化方案

> 日期：2026-09-21 ｜ 範圍：POS Supabase 專案（`pos_*` 表）｜ 狀態：**待處理（已超出免費額度 1.13 GB）**
>
> 結論一句話：**唔係「一間店用得太多」，係幾個「拉全店訂單」嘅讀取路徑被高頻時鐘反覆觸發，而每次拉嘅都係「冇日期下限、limit=5000」或「三條時間腿 × 每頁 2000」嘅重 payload。**

---

## 0. 先講結果（TL;DR）

| 問題 | 答案 |
|---|---|
| 邊個服務食咗用量？ | **PostgREST（REST API 讀表）＝ 98.8 ~ 99.3%** |
| 邊啲表？ | `pos_orders`（絕對主力）＋ `pos_queue_events`、`pos_print_jobs`（次要但每次都陪拉） |
| Storage / Edge Functions 有事嗎？ | **完全無關**（圖表冇呢兩條線 = 用量近零） |
| Realtime 有事嗎？ | **無關**（0.7 ~ 1.2%，每日 9.9 ~ 16 MB，唔值得為佢做任何事） |
| Auth 有事嗎？ | **無關**（18.47 KB，全期） |
| 頭號元兇 | `sync-reconcile-daemon`：每 10 分鐘一次**無日期下限、limit=5000** 嘅全店訂單拉取（**7 MB／次**）。**掛 root layout，全站常駐 ⇒ 就算你冇開任何特定模組都照跑。** |
| KDS 有關係嗎？ | **完全無關**（2026-09-21 商家確認已停用）。KDS 只掛 `/kitchen`、`/expo` 兩個路由，唔開就零拉取 —— 見 §2.4。原排名第 2 位要歸零。 |
| 30 秒止血 | 收工前**關掉報表頁同打印中心頁**（呢兩頁係 3 分鐘／8 秒級輪詢）；真頂唔住就終端跑 `localStorage['macau-pos/sync-reconcile-daemon']='0'` |

---

## 1. 實測數據（你兩張截圖，可信度最高）

### 1.1 帳期總量

| 項目 | 數值 |
|---|---|
| 帳期 | 2026-09-02 → 2026-10-02 |
| 免費額度 | 5 GB |
| 已用 | **6.13 GB** |
| 超出 | **1.13 GB（122.6%）** |
| 期內平均 | 1.13 GB／日 |

⚠️ 注意「平均 1.13 GB／日」係被後段爆量拉高嘅均值 —— 9 月初每條柱只係幾十 MB，**真正嘅 run-rate 係最近幾日嘅 1.2 ~ 1.47 GB／日**（見下）。

### 1.2 分服務拆解（圖表 tooltip）

| 日期 | PostgREST | Realtime | Auth | 當日合計 |
|---|---|---|---|---|
| 18 Sep 2026 | **1.4555 GB（99.3%）** | 9.925 MB（0.7%） | — | ≈ 1.465 GB |
| 19 Sep 2026 | **1.287 GB（98.8%）** | 15.956 MB（1.2%） | 18.47 KB（0.0%） | ≈ 1.303 GB |

**由此可以斷定三件事：**

1. **元兇 100% 係「經 PostgREST 讀表」。** 即係我哋所有 `/api/pos/*` Route Handler 內部嗰句 `supabase.from("pos_orders").select(...)`。
2. **唔關 Realtime 事。** Realtime egress 只佔 0.7 ~ 1.2%（每日 10 ~ 16 MB）。呢個數字合理：`pos_orders` 每次 INSERT/UPDATE 推一個 row（未 `REPLICA IDENTITY FULL` 就只有 new row），一日 200 單 × 幾次改動 × 1.5 KB ≈ 1 ~ 2 MB。**千祈唔好為咗省流量去閹 Realtime** —— 省唔到，只會整壞即時性。
3. **唔關 Storage / Edge Functions 事。** 圖表連分項都冇 = 用量為零（或低到畫唔出）。你冇用 Edge Functions。

### 1.3 一個關鍵的計費口徑（好多人搞錯）

Supabase 嘅 PostgREST egress ＝ **Supabase → 你嘅 Vercel Function** 嗰段 bytes。
**唔係** Vercel Function → 瀏覽器 嗰段。

所以：
- 優化目標 ＝ **令 PostgREST 每次回少啲 bytes、每日回少幾次**。
- 改 Next.js route 嘅 response 格式（例如 gzip 出去畀瀏覽器）**對 Supabase 帳單零幫助**。
- 但反過來：**Vercel 端嘅請求次數 × 每次 Supabase 回幾多 bytes ＝ 你嘅帳單**。呢個就係下面 §2 嘅模型。

---

## 2. 用量佔比排名（估算模型）

以下 per-row 數字係**用真實欄位結構實測**（`tools/_egen-estimate-20260921.cjs`，純字串量度，唔連 DB）：

### 2.1 單一物件實際大小

| 物件 | 實測 bytes |
|---|---|
| 1 張 `pos_orders` row（帶 `items`，4 件菜） | **1 469 B** |
| 1 條 `pos_queue_events` row（`payload` ＝完整訂單快照） | **1 668 B** |
| 1 條 `pos_print_jobs` row（帶 `items`） | **1 165 B** |
| 同上，但只投影 `id,status,updated_at` | **91 B（細 16 倍）** |

### 2.2 每次請求嘅 payload

| 路徑 | 內容 | 單次大小 |
|---|---|---|
| ① `/api/pos/state`（全量） | orders 200 ＋ queue 300 ＋ printJobs 200 | **0.98 MB** |
| ② `/api/pos/state?ordersOnly=1&limit=5000`（守護，**無 start**） | 5000 × 1 469 B | **7.00 MB** |
| ② 同上，改投影 + 帶 7 日範圍（≈700 單） | 700 × 91 B | **0.06 MB** |
| ③ 報表一頁（PAGE=2000 × **3 條時間腿**） | 2000 × 3 × 1 469 B | **8.41 MB** |
| ③ 同上，改 1 條腿 + 投影 | 2000 × 164 B | **0.31 MB** |
| ④ `/api/pos/kds/board`（300 單 `select *`） | 300 × 1 469 B | **0.42 MB** |

### 2.3 佔比排名

> ⚠️ §1 嘅 99% 係**實測**；下面每條路徑佔幾多係**由程式碼頻率推算**。要坐實邊條，跑 §4 Step 1 嘅 SQL（`pg_stat_statements` 按 `rows` 排序）即可 5 分鐘內定案。

> 🔴 **2026-09-21 修正（商家回報：已停用 KDS）**：KDS 螢幕**只掛喺 `/kitchen` 同 `/expo` 兩個路由**（見 §2.4）。
> **唔開呢兩頁 = 完全零拉取**，唔存在「冇用都一直拉」。所以下面原排名第 2 位（KDS）在你嘅情況係 **0**，
> 佔比要重新歸一化。**「模組未用但照跑」嘅其實係第 1 位嘅對賬守護**（掛 root layout，全站常駐）。

| # | 來源 | 常駐？ | 觸發頻率（程式碼實據） | 單次 | 推算日用量（單機） | 佔比估算 |
|---|---|---|---|---|---|---|
| **1** | **對賬守護全店拉取**<br>`sync-reconcile-daemon.ts:207` | ✅ **全站常駐**<br>（root layout） | 掃描每 60s；**回執 TTL 10 分鐘**令全部重入工作集；每輪上限 100 張 ⇒ 7 日內終態單 > 100 時連續多輪 | **7.00 MB** | **504 MB ~ 3.5 GB** | **75 ~ 95%** |
| **2** | **報表 3 腿分頁**（＋ Ledger 線上單）<br>`restaurant-daily-report.tsx:1332,1694` | ⬜ 只喺報表頁 | 每頁 2000 × **3 條腿**，最多 10 頁；**每 3 分鐘自動刷新**（頁面可見時）；另加 Ledger RPC 500×8 | 8.41 MB／頁 | **0 ~ 數 GB** | **0 ~ 20%** |
| **3** | **全量 state（queue 白拉）**<br>`pos-app.tsx:1124`、`local-orders-panel.tsx:239` | ⬜ 只喺工作台／訂單頁 | mount／realtime resubscribe／**每次 queue-changed（＝每張單 enqueue）** | 0.98 MB | 按單量，午市 200 單 ⇒ 200+ 次 | **0 ~ 15%** |
| ~~4~~ | ~~KDS 看門狗全板拉取~~<br>`use-kds-board.ts:377-383` | ⬜ **只喺 `/kitchen`、`/expo`** | tick 每 15s；Realtime 靜 > 60s 就拉（實際 ≈ 每 60s 一次） | 0.42 MB | **302 MB（僅當開住該頁）** | **0%（已停用）** |
| 5 | 打印中心（`/prints`） | ⬜ 只喺打印中心頁 | **每 8 秒**：`syncCloudPrintOutcomes` ＋ pair-status | ~40 KB | **~432 MB（僅當長開該頁）** | 0 ~ 15% |
| 6 | 交班頁（今日單，3 腿 × limit 5000） | ⬜ 只喺交班頁 | 入頁 + `focus` + `online`（**focus 每次點返窗都觸發**） | 小（只回今日命中） | 小 | < 3% |
| 7 | 對班次同步（`pos-app.tsx:745`） | ✅ 常駐 | 每 60 秒 | 1 行 | 小 | < 1% |
| 8 | Realtime | ✅ | 常駐 | — | 10 ~ 16 MB | **~1%（實測）** |
| 9 | Auth | — | 登入 / token 續期 | — | 18 KB | **~0%（實測）** |
| 10 | Storage / Edge Functions | — | 未使用 | — | 0 | **0%（實測）** |

**總量校驗（已按「停用 KDS」修正）：** 第 1 位單獨就足以解釋 1.2 ~ 1.47 GB／日 ——
以一日 30 張單為例：7 日窗口 ≈ 210 張終態單 → 每 10 分鐘週期需 ⌈210/100⌉ = 3 輪 × 7 MB = 21 MB／10 分鐘
→ 126 MB／小時 → **POS 分頁開 10 小時 ≈ 1.26 GB／日**，同你 18-19 Sep 嘅 1.29 / 1.47 GB 幾乎完全吻合。

### 2.4「常駐」定「開頁才跑」—— 呢個分野決定一切

| 模組 | 掛載位置 | 未用時會唔會拉？ |
|---|---|---|
| 對賬守護 `installSyncReconcileDaemon()` | `app/layout.tsx:70` → `pos-sync-flush-worker.tsx:32` | 🔴 **會**。root layout，**任何頁面**（收銀台／訂單／自助機／報表／admin）都裝，且 `useEffect` 內**零條件**。 |
| KDS 看門狗 `useKdsBoard()` | `app/kitchen/page.tsx`、`app/expo/page.tsx` | ✅ **唔會**。route-scoped，冇開頁就完全唔 mount。 |
| 打印中心 8 秒輪詢 | `app/prints/page.tsx` | ✅ 唔會（但**開住就每 8 秒**）。 |
| 報表 3 分鐘刷新 | 報表 tab（頁面內） | ✅ 唔會（但**開住就每 3 分鐘**）。 |
| 全量 state pull | `pos-app`（工作台）／訂單頁 | ⬜ 開住就由「每張單」觸發。 |

**⇒ 結論：真正「唔用都照燒」嘅只有對賬守護一個。** 其餘都係「開住某頁先燒，但開住就燒得好快」。

---

## 3. 根本原因（逐條，附 code 證據）

### R1 🔴 對賬守護拉「全店歷史」——用 `null` 當日期下限

`src/lib/pos/sync-reconcile.ts:142-147`：

```ts
export async function fetchServerOrders(storeId: string, startIso: string | null) {
  const params = new URLSearchParams({ storeId, ordersOnly: "1", limit: "5000" });
  if (startIso) params.set("start", startIso);   // ← 傳 null 就完全冇日期過濾
```

`src/lib/pos/sync-reconcile-daemon.ts:207`：

```ts
const { orders: serverOrders, error } = await fetchServerOrders(storeId, null);  // 🔴 無下限
```

**同一個檔案入面明明有現成嘅 `computeServerRangeStart(localOrders)`**（`sync-reconcile.ts:164`，會算出「最舊終態單 − 12 小時」），連註釋都寫住「null = 唔限（會好大，盡量傳）」。**守護冇用佢。**
而 `sync-health-modal.tsx:98` 就識用（`fetchServerOrders(storeId, startIso)`）—— 證明呢個係守護獨有嘅漏招，唔係設計原意。

→ 一次拉 = 最多 5000 張單 = **7 MB**。而守護每 10 分鐘就再拉一次。

### R2 🔴🔴 TTL 10 分鐘 × 每輪上限 100 張 ＝ 乘數放大器（最致命）

`sync-acks.ts:149`：`RECONCILE_ACK_TTL_MS = 10 * 60 * 1000`
`sync-reconcile-daemon.ts:62`：`SCAN_INTERVAL_MS = 60_000`
`sync-reconcile-daemon.ts:68`：`MAX_ORDERS_PER_ROUND = 100`

三個常數撞埋一齊就變成：

```
工作集 = 最近 7 日內嘅全部終態單（SYNC_HEALTH_WINDOW_MS = 7 日，sync-acks.ts:58）
每 10 分鐘，全部回執「過期」→ 全部重新入工作集
但每輪只處理 100 張（MAX_ORDERS_PER_ROUND）
⇒ 每輪都拉一次「全店 7 MB」
⇒ ceil(N / 100) 輪之後先處理完
```

假設一日 150 單 → 7 日 ≈ **1 000 張終態單** → 需要 **10 輪**，每輪隔 60 秒：
**每 10 分鐘就食 10 × 7 MB ＝ 70 MB**，一小時 6 個週期 ⇒ **420 MB／小時**。

**呢個就係 1.2 ~ 1.47 GB／日 嘅來源。** 亦解釋咗點解 9 月 10 日加入守護之後（見 docs/112），曲線由 13 日開始爬升、17-19 日爆發。

> 更差嘅情況：如果有一批單永遠對唔上（`conflict` / `missing`，見 `sync-reconcile-daemon.ts:239-254`），佢哋**永遠拿唔到回執**，於是每 60 秒掃描都會再拉一次 —— 24 小時不停，每日 **10 GB**。呢個係必須堵死嘅病態路徑。

### R3 三條時間腿 ＝ 3× 放大

`src/lib/pos-orders-range.ts:85-96`：每個「一頁」並行跑 **3 條** query（`created_at` / `updated_at` / `reopened_at`），各自 `.range(offset, offset+limit-1)` 同 `.select("*")`。

- 回傳係超集，client 端按 `id` 去重 → **但 DB → Vercel 嗰段 bytes 係照俾 3 份**。
- 而 Supabase 就係按嗰段計 egress。

→ 任何走呢條路嘅請求，成本**起碼 ×3**。（`/api/pos/state`、報表、交班頁全部走佢。）

### R4 報表：2000 / 頁 × 10 頁 × 3 腿

`restaurant-daily-report.tsx:1332-1333`：`PAGE = 2000`、`MAX_PAGES = 10`
`restaurant-daily-report.tsx:816`：`AUTO_REFRESH_INTERVAL_MS = 3 分鐘`

若果商家（很正常地）長開報表分頁、並揀「全部」：
一輪 = 最多 **2000 × 10 × 3 = 60 000 row-reads ＝ 88 MB**，每 3 分鐘一次 ⇒ **1.7 GB／小時**。

呢個係 18-19 日 1.3 ~ 1.47 GB／日 嘅另一個高度可疑來源（同 R2 疊加）。

### R5 🔴 全量 state 每次陪拉 300 條 queue，而 v2 之下 client **完全唔用**

`src/app/api/pos/state/route.ts:140` 每次（非 `ordersOnly`）都查：

```ts
supabase.from("pos_queue_events").select("*").eq("store_id", storeId).limit(300)
```

300 × 1 668 B ≈ **500 KB／次**。
但 `pos-app.tsx:1209`：

```ts
if (Array.isArray(payload.queue) && !isOutboxV2Enabled()) {   // ← v2 之下成段唔行
```

即係 v2（outbox，docs/111）**已經唔會 merge server queue** ⇒ 呢 500 KB 係**純浪費**，而且每次 mount / resubscribe / queue-changed 都拉。

### R6 事件驅動放大：每張單都觸發一次全量拉取

- `sync-flush.ts:197` `notifyQueueChanged()` 廣播 `pos-sync-queue-changed`，而**每個落單 / 加菜 / 結帳都會 fire**。
- `local-orders-panel.tsx:276` 聽到就 `pullServerOrders()` —— 而佢打嘅係 **`/api/pos/state?storeId=`（冇 `ordersOnly`！）**（`:239`）⇒ 拉埋 300 條 queue + 200 條 print job。

午市 200 張單 ⇒ **200+ 次 × 0.98 MB ≈ 200 MB**，只係為咗 refresh 一個列表。

### R7 KDS 看門狗 ≈ 每 60 秒拉一次全板（⚠️ **只喺開住 `/kitchen` 或 `/expo` 時成立**）

> 🟢 **2026-09-21 商家澄清：已停用 KDS ⇒ 本項成本 ＝ 0，唔係你要處理嘅事。**
> 保留喺報告只為完整記錄，以及避免將來重開 KDS 屏時再次中招。
> 判斷依據：`useKdsBoard()` 只被 `components/kds/kitchen-screen.tsx:249` 同 `expo-screen.tsx:63` 呼叫，
> 而兩者只喺 `app/kitchen/page.tsx`、`app/expo/page.tsx` 渲染 —— **route-scoped，冇開頁就完全唔 mount**。
> （⚠️ 但留意 `enabled: Boolean(storeId)` 係「有 session 就開」，冇額外開關 —— 即係**只要有人開住呢頁就會不停拉**，
> 所以如果將來重新啟用 KDS 屏，記得同時處理呢一項。）

`use-kds-board.ts:66-67`：`WATCHDOG_INTERVAL_MS = 15_000`、`WATCHDOG_STALE_MS = 60_000`
`use-kds-board.ts:190`：`refresh()` 自己會 `lastEventAtRef.current = Date.now()`

⇒ 邏輯上係「靜 60 秒先拉」，實際上係 **每 60 秒拉一次**（拉完自己就變「新鮮」，60 秒後又拉）。
`kds-server.ts:83-95`：`select("*")`、status `in (draft,sent_to_kitchen,paid)`、12 小時窗、limit 300 ⇒ **0.42 MB／次 × 720 次（12h）= 302 MB／日／屏**。

### R8 `SELECT *` 全域冇投影

`pos/state`、`pos-orders-range.ts:82`、`kds-server.ts:85`、`pos/orders/route.ts:43`、`salon/state` 全部係 `.select("*")`。
`pos_orders` 一行 1 469 B 之中，`items` 佔大部分，但**守護、KDS 決定狀態、去重**呢啲場景根本唔需要 `items` —— 投影後係 **91 B（16 倍差距）**。

---

## 4. 排查步驟（先量後改，唔好靠估）

### Step 0 ★ 先確認「邊個專案」燒嘅 —— 你嗰張圖揀咗 **All projects**

截圖右上 filter 係 `All projects` ⇒ **6.13 GB 係整個 Organisation 嘅總和**，唔一定全部係 POS 專案。
同一 org 仲有 **Ledger 專案**（`zymdemjflsckicwcinxl`，線上訂單／會員／充值），而 POS app 亦會讀佢：

| 讀取 | 位置 | 頻率 | 單次 |
|---|---|---|---|
| `list_merchant_orders` RPC（線上單） | `quick-online-orders-panel.tsx:252`、`online-orders.tsx:217,473` | 入頁／resubscribe | 50 行 |
| `sumPaidLedgerOrders`（交班用，最多 8 頁 × 200） | `shift-page.tsx:760` | 入頁 ＋ **每次 `focus`** | 最多 1600 行 |
| 報表內 Ledger 線上單（500 × 8 頁） | `restaurant-daily-report.tsx:1681,1694` | **每 3 分鐘** | 最多 4000 行 |
| `pending-count` 輪詢 | `lib/topup/pending-count-store.ts:40` | 12s / 30s | 1 行（極小） |

**做法：把 filter 由 `All projects` 改成逐個專案睇，記低 POS / Ledger 各自佔幾多。**
👉 若主要係 **Ledger 專案** → 唔關 POS 拉取事，要查 Macau-Ledger（線上落單／會員）嗰邊；
👉 若主要係 **POS 專案** → 就係本報告 §3 嘅四條路徑。

### Step 1 ★ 一針定案：`pg_stat_statements`（令 rows 高者 ＝ egress 大者）

Supabase Dashboard → SQL Editor：

```sql
-- ① 邊條查詢回最多「行」＝ egress 最大來源（最重要一步）
select
  calls,
  rows,
  round(rows::numeric / greatest(calls, 1), 1) as rows_per_call,
  round(total_exec_time::numeric / 1000) as total_sec,
  left(regexp_replace(query, '\s+', ' ', 'g'), 140) as q
from pg_stat_statements
where query ilike any (array['%pos_orders%','%pos_queue_events%','%pos_print_jobs%'])
  and query ilike '%select%'
order by rows desc
limit 20;
```

預期會見到 3 種形狀（對應實際元兇）：

| 形狀 | 代表 |
|---|---|
| `select * from pos_orders where store_id = $1 order by created_at desc limit $2`（`calls` 極高） | 對賬守護 / 全量 state |
| 同上但有 `created_at >= $` / `updated_at >= $` / `reopened_at >= $`（**3 條輪流出現**） | 三腿查詢（R3） |
| `select * from pos_orders ... status in (...) ... limit 300`（`calls` 高、`rows ≈ 300 × calls`） | KDS 看門狗 |

> 若 `pg_stat_statements` 唔存在 → 用 Dashboard → **Reports → Query Performance**（Supabase 內建，同一份數據）。

```sql
-- ② 表實際規模（判斷貼唔貼近 limit 5000 上限）
select
  count(*) as row_count,
  pg_size_pretty(pg_total_relation_size('public.pos_orders')) as total_size,
  min(created_at)::date as first_day,
  max(created_at)::date as last_day
from public.pos_orders;

select count(*) as queue_rows,
       pg_size_pretty(pg_total_relation_size('public.pos_queue_events')) as queue_size
from public.pos_queue_events;

-- ③ 每日單量（推算「7 日窗口有幾多張終態單」＝ 守護每輪要跑幾多輪）
select (created_at at time zone 'Asia/Macau')::date as d, count(*) as orders
from public.pos_orders
group by 1
order by 1 desc
limit 14;
```

### Step 2 數請求次數：Vercel 側

Vercel → Logs（或 Log Drains），統計 24 小時內 `/api/pos/state` 嘅呼叫次數同 query string 分佈：

```
grep -c 'GET /api/pos/state'                       # 總次數
grep -o 'ordersOnly=1'                             # 分拆 ordersOnly vs 全量
grep -o 'limit=[0-9]*'                             # 有冇 limit=5000 嘅守護呼叫
```

**`limit=5000` 且冇 `start=` 嘅呼叫次數 × 7 MB ＝ 守護嘅實際成本。**

### Step 3 令超支「帶住數字報警」（建議永久保留）

`src/app/api/pos/state/route.ts` 結尾改成：

```ts
const body = JSON.stringify(payload);
// 🔴 保留：令 Vercel log 直接變成 Supabase egress 帳單嘅鏡像
console.info(
  `[pos/state] bytes=${Buffer.byteLength(body)} orders=${n} queue=${q} jobs=${p}` +
  ` ordersOnly=${ordersOnly ? 1 : 0} range=${rangeStartRaw ?? "-"}~${rangeEndRaw ?? "-"} ip=${ip}`,
);
return new NextResponse(body, { status: 200, headers: { "content-type": "application/json" } });
```

同類一行 log 亦建議加落 `/api/pos/kds/board`。之後任何一天超支，睇 Vercel log 加總 `bytes=` 就即刻知邊條路徑。

### Step 4 瀏覽器實測（最快、唔使改嘢）

Chrome DevTools → Network → 篩 `pos/state` → 睇 **Size** 欄，然後：

1. 開收銀台，食一支煙，數 10 分鐘內有幾次請求、每次幾 MB。
2. 開報表揀「全部」，睇佢拉幾多頁。
3. 開 KDS 屏，睇係唔係每 60 秒一次。

### Step 5 驗證閉環

改完之後，睇 Supabase → Egress → PostgREST 日曲線。**目標：由 1.3 GB／日 落返 < 100 MB／日。**

---

## 5. 優化方向（按 ROI 排序）

### P0-1 ★ 對賬守護收口（預期省 40 ~ 70%）

**a. 投影 —— 唔好再拉 `items`。** 守護只需要 `id / status / updated_at`：

```ts
// sync-reconcile.ts
const params = new URLSearchParams({
  storeId, ordersOnly: "1", limit: "5000",
  fields: "id,status,updated_at",          // ← 新增（server 端下推 .select() 投影）
});
```

7 MB → **0.43 MB（省 94%）**。

**b. 用返現成嘅 `computeServerRangeStart()`：**

```ts
// sync-reconcile-daemon.ts:207
const startIso = computeServerRangeStart(loadOrders());   // ← 由 null 改成有下限
const { orders: serverOrders, error } = await fetchServerOrders(storeId, startIso);
```

**c. 更徹底：改成「按 id 精準核實」端點。** 守護真正需要嘅係「我手上呢 N 張單，雲端而家係咩狀態」：

```
POST /api/pos/orders/verify   { storeId, ids: [...最多 100 個] }
→ select id,status,updated_at from pos_orders where store_id=$1 and id = any($2)
```

成本由「全店 5000 張」變成「我問嘅 100 張」，**每輪 KB 級**，而且徹底消滅「輪次 × 全店」嘅乘數效應。

**d. TTL 由 10 分鐘 → 1 ~ 6 小時**（`sync-acks.ts:149`），並且加「連續 N 輪無分叉就指數延長 TTL」。
`RECONCILE_ACK_TTL_MS = 10 min` 嘅設計目的（見該處註釋）係「雲端被回水最多 10 分鐘內被發現」。但**代價係每 10 分鐘一次全店拉取**。以澳門一間店嘅實際情況，1 小時嘅偵測延遲完全可以接受 —— 而成本變 1/6。

**e. 加每日預算硬閘（防病態循環）：**

```ts
const MAX_PULLS_PER_DAY = 24;   // 超過就只寫 blocked 告警，唔再拉
```

對付 R2 提到嘅「永遠對唔上 ⇒ 每 60 秒拉一世」病態路徑。

### P0-2 ★ 三條時間腿 → 單一 RPC（省 ~67%，順便修好索引問題）

`fetchOrdersInRange` 嘅 3 條腿係為咗避開 PostgREST nested `.or()` 嘅解析歧義（見該檔頭註釋）。正解＝**推落 DB，用一個 function 做 OR + distinct**：

```sql
create or replace function public.pos_orders_page(
  p_store_id uuid, p_start timestamptz, p_end timestamptz,
  p_limit int, p_offset int
) returns setof pos_orders language sql stable as $$
  select o.* from public.pos_orders o
  where o.store_id = p_store_id
    and (
      (p_start is null or o.created_at  between p_start and p_end)
   or (p_start is null or o.updated_at  between p_start and p_end)
   or (p_start is null or o.reopened_at between p_start and p_end)
    )
  order by o.created_at desc
  limit p_limit offset p_offset;
$$;
```

**1 次 round trip、每行只回一次** ⇒ 即時省 2/3。（配合 migration 0044 嘅三個索引，`reopened_at` 腿亦唔會拖慢。）

### P0-3 全量 state 收身（省每次 ~500 KB 以上）

1. **v2 之下索性唔查 queue**（`pos-app.tsx:1209` 證明 client 唔用）：

```ts
const ordersOnlyQueue = isOutboxV2Enabled...  // server 側無法知 client 狀態 → 改為：
// route.ts：加 ?skipQueue=1，client 在 v2 之下傳
const queueQuery = (ordersOnly || skipQueue) ? Promise.resolve({data:[]}) : <原本查詢>;
```

2. **`local-orders-panel.tsx:239` 補上 `ordersOnly=1`** —— 佢只需要 orders，但而家拉足 0.98 MB。
3. **`printJobs` 由「每次 200 條」改增量**：加 `?printJobsSince=<iso>`，只回新 job。
4. **加 `updatedAt` 版本號 / ETag**：state 內容無變就回 `304`（對 Supabase 帳單幫助有限，但可省 Vercel 傳輸，且令 client 邏輯更清晰）。

### P0-4 報表降頻降頁

| 改動 | 位置 | 效果 |
|---|---|---|
| `AUTO_REFRESH_INTERVAL_MS`：3 分鐘 → 10 分鐘 | `restaurant-daily-report.tsx:816` | 省 70% |
| `PAGE`：2000 → 500 | `:1332` | 單頁 8.41 MB → 0.31 MB（配合 P0-2） |
| 「全部」範圍加二次確認，或改為「先出聚合數字、用戶撳『睇明細』才分頁拉」 | `:1331` | 斬斷 10 頁 × 3 腿嘅尾部 |
| `focus` / `online` 事件加 60 秒去抖 | 交班頁 `shift-page.tsx:496` | 省重複拉取 |

### P1-1 KDS 看門狗改「先探後拉」⏸️ **暫緩（KDS 已停用，現時成本 0）**

> 唔需要為咗省流量而做。**留待重新啟用 KDS 屏之前再落實**（否則一開屏就即刻中招）。
> 反而應該加嘅係「未綁定／未啟用就唔裝」嘅閘。

`WATCHDOG_STALE_MS`：60 秒 → 180 秒；並且新增輕量探測端點：

```
GET /api/pos/kds/revision?storeId=  → { ok, revision: "<max(updated_at)>|<count>" }   // ~100 B
```

`revision` 冇變就**唔拉全板**。KDS 日常大部分時間都係「螢幕上仲有未完成單、但冇新事件」，呢個改動可以令 302 MB／日 降到 ~20 MB／日。

### P1-2 全域 `SELECT *` → 明確投影

| 檔案 | 建議 |
|---|---|
| `sync-reconcile.ts:146` | 守護只需 `id,status,updated_at` |
| `pos-orders-range.ts:82` | 由呼叫端決定欄位；狀態核實類只取 `id,status,updated_at` |
| `kds-server.ts:85` | KDS 要 `items`，但唔要 `subtotal/tax_amount/service_charge_amount/discount_amount/prepaid_amount/comp_note...` |
| `pos/orders/route.ts:43` | 同上 |
| `pos/state/route.ts:140,146` | 見 P0-3 |

### P2 其他（非流量，但相關）

- **migration 0044 / 0045 未跑** → 索引唔齊會令 DB CPU 高、鎖久（唔影響 egress，但會令「同一個慢查詢被拉更久」放大感知問題）。**建議一齊上。**
- **Supabase anon 直讀**（0041 §3 per-store token 未做）＝ 安全問題、唔關流量，但既然要開 Supabase 後台做診斷，順手確認 anon 讀取窗口冇被縮得太寬。
- **超額兜底**：免費 plan 5 GB，超出後 Supabase 會限制服務。**先做 P0-1c（按 id 精準核實）＋ P0-1d（TTL 改 1 小時）＋ 關掉長開嘅報表／KDS 分頁，就足以即時跌返額度之內。**

---

## 6. 預期效果

| 項目 | 現況（推算） | P0 完成後 | 降幅 |
|---|---|---|---|
| **對賬守護**（常駐，主因） | **504 MB ~ 3.5 GB／日** | 1 ~ 5 MB／日 | **>99%** |
| 報表（＋ Ledger 線上單） | 0 ~ 數 GB／日（視乎有冇長開） | ~10 MB／日 | 90%+ |
| 全量 state | 0 ~ 200 MB／日（午市 200 單） | ~60 MB／日 | 70% |
| 打印中心 8 秒輪詢 | 0 ~ 432 MB／日（**只喺長開 `/prints` 時**） | ~40 MB／日（改 30 秒） | 73% |
| ~~KDS 看門狗~~ | **0（已停用）** | 0 | — |
| Realtime | 10 ~ 16 MB／日 | 不變（**唔應該動**） | 0 |
| **合計** | **1.2 ~ 1.47 GB／日（實測）** | **< 100 MB／日** | **~93%** |

---

## 7. 建議執行次序（今日可做 → 本週可做）

**今日（唔使改 code，即時止血）：**
1. 收工前**關掉報表頁同打印中心頁**（呢兩頁分別係 3 分鐘／8 秒級輪詢；打印中心長開一晚 ≈ 0.4 GB）。
2. 真的頂唔住：終端 console 執行 `localStorage['macau-pos/sync-reconcile-daemon']='0'` 並 reload（守護即停，**唔影響 flush / 落單 / 出紙**；只係暫停「自動對賬補推」）。
3. ⚠️ 唔關 KDS 事（已停用）；亦**唔好**去閹 Realtime（只佔 1%）。

**本週（P0）：** P0-2 RPC（1 次查詢取代 3 條腿）→ P0-1a/1b（守護投影 + 帶範圍）→ P0-1d（TTL）→ P0-3（state 收身）。
**下週（P1）：** KDS 探測端點、全域投影、報表降頻。

---

## 8. 附錄：本報告嘅證據清單

| 結論 | 證據位置 |
|---|---|
| 守護拉全店無下限 | `src/lib/pos/sync-reconcile-daemon.ts:207`（`null`）／`sync-reconcile.ts:146`（`limit=5000`、`start` 可選） |
| 既有但未用嘅範圍助手 | `src/lib/pos/sync-reconcile.ts:164` `computeServerRangeStart`；`sync-health-modal.tsx:98` 有用 |
| TTL 10 分鐘 / 每輪 100 張 | `src/lib/pos/sync-acks.ts:149`、`sync-reconcile-daemon.ts:62,68` |
| 7 日工作集窗口 | `src/lib/pos/sync-acks.ts:58` `SYNC_HEALTH_WINDOW_MS` |
| 三條時間腿 | `src/lib/pos-orders-range.ts:85-96` |
| 報表 PAGE/MAX_PAGES/自動刷新 | `restaurant-daily-report.tsx:816,1332,1333` |
| state 每次都查 queue 300 | `src/app/api/pos/state/route.ts:140` |
| v2 之下 client 唔用 queue | `src/components/pos-app.tsx:1209`（`!isOutboxV2Enabled()`） |
| 每張單觸發全量拉取 | `sync-flush.ts:197` → `local-orders-panel.tsx:239,276`（**缺 `ordersOnly`**） |
| KDS 每 60 秒拉全板 | `use-kds-board.ts:66,377-383,190`；`kds-server.ts:83-95` |
| `select("*")` 清單 | `pos/state:140,146,149`、`kds-server:85`、`pos/orders:43`、`pos-orders-range:82` |
| payload 實測 | `tools/_egen-estimate-20260921.cjs` |
