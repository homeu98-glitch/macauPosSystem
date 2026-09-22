# Log 錯誤分類 ＋「未結帳單又不見了」根因（2026-09-22 20:20）

> 證據檔：`tools/_analyze-logs-20260922-2016.cjs` / `…2016b.cjs`（分析腳本）、
> `…-2016.out.txt` / `…-2016b.out.txt`（完整輸出）、
> `tools/_probe-41ccd63c-20260922.cjs`（雲端實查）、
> `tools/_probe-order19*-20260922.cjs`（同一日較早）。
> 原始 log：`~/Downloads/macau-pos-system-log-export-2026-09-22T12-14-12.csv`（Vercel）、
> `~/Downloads/supabase_logs (14).csv`（Supabase）。

---

## 0 TL;DR

| 問題 | 結論 |
|---|---|
| **未結帳單又不見了** | 🔴 **今日新加嘅「舊版節流」（P0b）回咗空 `orders` 骨架，而舊 bundle 唔識新加嘅 `incremental` 欄** ⇒ 佢照跑孤兒單對賬 ⇒ **本機所有未結帳單被移入隔離區**（列表清空）。**已修**（下面 §3）。 |
| **Log 一堆 error** | 實際上 **Vercel `level=error` = 0**。真正嘅噪音係 **924 行 `[pos/sync] 拒絕覆寫訂單`**（45 秒內、涉及 77 張單、絕大多數係 9/14–9/15 舊單）。Supabase 只有 **2 條 error**（其中一條係 20:06 有人手動重跑 migration 撞 `schema_migrations_pkey`）。 |
| 兩者關係 | **唔係同一個 bug**。拒絕覆寫係「舊機 outbox 卡住舊事件、無限重試」（污染 log＋燒流量）；訂單消失係「舊機被節流骨架騙到、自我隔離」。**共同上游係「有一部機仲跑住舊 bundle」。** |

---

## 1 Log 全貌（先校正時間）

| | 窗口（澳門時間） | 行數 | 備註 |
|---|---|---|---|
| Vercel | **19:56:33 → 20:12:45** | 1466 | 305 個唯一 `requestId` |
| Supabase | **19:50:21 → 20:14:20** | 1000 | 933 edge / 67 postgres |

⚠️ 兩個檔都係「**最後約 20 分鐘**」，唔係全日 —— 落結論時唔可以當成一日。

### 1.1 錯誤／事故清單（依頻率）

| # | 類型 | 次數 | 首次→最後 | 判斷 |
|---|---|---|---|---|
| 1 | `[pos/sync] 拒絕覆寫訂單 order-xxx（付款階段降級）` | **847** | 20:12:00 → 20:12:45 | 🔴 真問題（見 §2） |
| 2 | `[pos/sync] 拒絕覆寫訂單 ledger-…（stale）` | 55 | 同上 | 同上 |
| 3 | `[pos/sync] 拒絕覆寫訂單 order-xxx（終態降級）` | 22 | 同上 | 同上 |
| 4 | `[pos/state] 🔴 偵測到疑似舊版 bundle 嘅全量拉取` | 3 | 19:57:23 → 20:12:20 | 🔴 **一切嘅上游**（ip `60.246.53.111`） |
| 5 | `[egress] pos/state mode=legacyThrottled bytes=205 orders=0` | 21 | 19:56:34 → 20:12:44 | 🔴 節流骨架（見 §3） |
| 6 | `[egress] pos/state mode=ordersOnly orders=339 bytes=514528` | 1 | 19:57:13 | 舊機一次拉 **502 KB** |
| 7 | Supabase `23505 duplicate key … schema_migrations_pkey` | 1 | 20:06:47 | ⚠️ 有人**手動重跑 migration**（同批 40+ 條 `alter table … add column if not exists`，本身無害） |
| 8 | Supabase `GET /realtime/v1/websocket` → **101** | 53 | 19:50 → 20:14 | ✅ 正常（101 = Switching Protocols，唔係錯誤） |
| 9 | Supabase `00000 checkpoint starting/complete` | 6 | 19:50 → 20:10 | ✅ Postgres 內部日誌 |
| 10 | Vercel `level=error` | **0** | — | — |

**重點：肉眼睇落「大量 error」其實係第 1–3 條同一件事（拒絕覆寫）嘅 924 行**，
加上 Vercel UI 會把 `warn` 一齊當紅字顯示，所以睇落好恐怖。

### 1.2 節奏（每分鐘請求，去重後）

```
19:56  16 個    19:57  21 個        ← 舊機每 ~3 秒拉一次（節流前後對比）
20:07  12        20:08  22         ← 正常營業節奏
20:09  12        20:10  12
20:11  16+1      20:12  40 + 956   ← 🔴 20:12 一次過 956 個（＝同一批事件重推）
```

---

## 2 「拒絕覆寫訂單」風暴（924 行）

### 2.1 形狀

```
[pos/sync] 拒絕覆寫訂單 order-41ccd63c
  （現有=settled@2026-09-22T11:41:20.813+00:00，
    incoming=sent_to_kitchen@2026-09-22T11:41:04.922Z，
    付款階段降級（已收款唔可以被未收款 snapshot 覆蓋））
```

| 項目 | 值 |
|---|---|
| 涉及單數 | **77 張** |
| 每張被拒次數 | 11 次（大部份）／22 次（7 張） |
| 理由 | 付款階段降級 847（92%）／stale 55／終態降級 22 |
| 時間集中 | **45 秒內**（20:12:00–20:12:45） |
| 單齡 | 絕大多數係 **9/14 – 9/15** 嘅單；最新一張係今日 `order-41ccd63c`（訂單30） |

### 2.2 判讀

* **唔會令訂單消失** —— 伺服器拒收嘅意思係「雲端保留較新版本（settled）」，雲端資料反而係對嘅。
* 呢批係**一部機 outbox 裡面卡住嘅舊事件**：payload 係幾日前嘅 `sent_to_kitchen` 快照，
  雲端早已 `settled` ⇒ 永遠推唔成功 ⇒ 每次 flush 都重推一次。
* **新 bundle 已經有終態**：`sync-flush.ts` 510–517 會將「雲端已有較新版本」標成
  `skipped / server-newer`（`lastError: 雲端已有較新版本（…），改由對賬守護補推`）⇒ 唔會無限重試。
* 🔴 **舊 bundle 冇呢段**（2026-09-22 才加）⇒ **無限重試**，造成：
  ① log 洗版（今次 924 行，真正錯誤會被淹沒）；
  ② 每次 flush 都帶住呢批事件上雲（egress）；
  ③ UI「待同步」數字永遠唔歸零。

### 2.3 建議

| 優先 | 做法 |
|---|---|
| P0 | **叫該裝置重新載入**（換新 bundle）→ 自動停止無限重推，並把舊事件標 `skipped`。 |
| P1 | 伺服器端對「同一 event 反覆被拒」加 log 節流（`rateLimit`），避免洗版。 |
| P1 | 「同步健康」頁顯示「伺服器已較新（已放棄重推）：N 筆」，令店員／運維一眼睇到。 |
| P2 | 加一條 6 小時 TTL：`failed` 超過 N 次且理由屬「確定性拒收」（stale／downgrade）→ 自動轉 `skipped`。 |

---

## 3 🔴 「未結帳單又不見了」根因（本次最重要）

### 3.1 現象
下單 iPad 上，**已建立但未結帳**嘅單會**再次消失**（今日已第二次），而且「接連出現」。

### 3.2 根因鏈（每一格都有證據）

1. **該 iPad 跑住舊 bundle。**
   證據：`ip=60.246.53.111` 嘅請求**冇 `skipQueue`**（＝`isLegacyFullState`），
   被 `[pos/state] 🔴 疑似舊版 bundle` 點名 3 次；而且有一次
   `mode=ordersOnly orders=339 bytes=514528 limit=5000`（**502 KB／次**，新 bundle 唔會咁樣拉）。

2. **今日新加嘅 P0b 節流會回「空 orders 骨架」**（`state/route.ts` `legacyThrottled` 分支）：
   ```jsonc
   { ok:true, orders: [], queue: [], printJobs: [], incremental: true, legacyThrottled: true }
   ```
   節流目的正確（舊分頁每 33 秒拉 403 KB，佔該時段 egress 51%），
   但佢嘅安全論證係「**client 見到 `incremental: true` 就唔會跑孤兒對賬**」。

3. 🔴🔴 **舊 bundle 根本唔識 `incremental` 呢個欄位** —— 佢係**今日（2026-09-22）P1 才加入**嘅。
   一個契約**唔可以要求舊 client 遵守一個佢唔認識嘅新欄位**。

4. 舊 bundle 於係**照跑孤兒單對賬**（`pos-app.tsx` `computeOrphanLocalOrders`），
   判準係「**雲端 `payload.orders` 冇呢張單**」＋本機非終態＋outbox 冇 pending ORDER_* ＋單齡 ≥10 分鐘。
   ⇒ 收到 `orders: []` 等於「**雲端一張單都冇**」⇒ **本機所有未結帳單一次過中招**
   ⇒ `quarantineOrders()` 將佢哋**移出 `orders` localStorage**（移入隔離區）。

5. 結果：**收銀列表／枱面即刻清空**。而「未結帳單」正正係唯一仲有客人／錢未收嘅單
   ⇒ 症狀就係商家講嘅「原本已建立但尚未結帳嘅訂單不見了」。

6. 為何「**接連**出現」：舊機每 ~3 秒拉一次，每次節流命中就再隔離一次。

7. 為何「**最近優化之後**」才爆：P0b 係**今日**才部署；之前舊 client 收到嘅係真 orders，
   孤兒判準唔會誤中。⇒ 呢個係**今日引入嘅迴歸（regression）**。

> 新 bundle 有守門（`pos-app.tsx` 1504–1508 `if (!payload.incremental)`），
> 而該處註釋自己就寫住呢個後果係「**災難級誤判**」—— 但守門只存在於新 client。

### 3.3 已修

**`src/app/api/pos/state/route.ts`** —— 節流骨架由 `orders: []` 改為**回本店全部未結帳單**：

```ts
// legacyThrottled 分支
const openRes = await supabase
  .from("pos_orders")
  .select(POS_ORDER_DB_COLUMNS.join(","))
  .eq("store_id", storeId)
  .in("status", [...OPEN_ORDER_STATUSES])   // draft / sent_to_kitchen / paid / reopened
  .order("created_at", { ascending: false })
  .limit(100);
// orders: throttleOrders.map(mapOrderRow)
```

* 舊 client 嘅孤兒判準即刻變 **no-op**（本機未結帳單全部喺 server 名單內）；
* 終態單照樣唔回（孤兒邏輯本身唔理終態單）；
* 節流目標（唔回 300 條 queue ＋ 200 張單 ≈ 500 KB）**完全保留**（未結帳單通常 0–5 行）。
* 另加兩道保險：節流條件要求 `Boolean(storeId)`；分支加 `&& supabase` 守門（該分支排喺 mock 模式檢查之前）。

**`src/lib/pos/pos-app-queue-base.test.ts`** —— 新增守衛：
「legacyThrottled 骨架一定要回未結帳單，**唔可以回空 `orders`**」。

### 3.4 立即止血（商家操作，按次序）

1. **救返消失嘅單**：`/orders` →「**同步健康**」→ **隔離區** → 逐張「**還原**」。
   （隔離係「移走」唔係「刪除」，資料仲喺；`restoreQuarantinedOrder()`。）
2. **每部 iPad／桌面分頁重新載入**（或關掉重開）→ 換新 bundle。
   之後 `[egress]` 唔應該再出現 `mode=legacyThrottled`。
3. 核對今日未結帳單（下面 SQL），逐張結帳或作廢收口。
4. **唔好再手動重跑 migration**（20:06 嗰次造成 `schema_migrations_pkey` 23505；
   `add column if not exists` 本身無害，但重跑冇意義又會污染 log）。

```sql
-- 今日仍未結帳（＝唯一會漏錢嘅類別）
select local_order_no, status, table_name, total,
       (created_at at time zone 'Asia/Macau') as 落單澳門,
       (updated_at at time zone 'Asia/Macau') as 更新澳門
from public.pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and status in ('draft','sent_to_kitchen','paid','reopened')
order by created_at;
-- 2026-09-22 20:20 實測：訂單19(A01,99) / 訂單25(A03,41) / 訂單29(A01,98)
```

---

## 4 「最近優化之後特別多問題」——系統性解釋

| 優化 | 對新 bundle | 對舊 bundle | 風險 |
|---|---|---|---|
| P0 舊版全量拉取唔回 queue | 無關 | 只少咗「其他機嘅 queue 事件」，安全 | 低 |
| **P0b 舊版節流回空骨架** | 無關（唔命中） | 🔴 **orders 變空 ⇒ 舊孤兒對賬誤判 ⇒ 隔離全店未結帳單** | **高（已修）** |
| P1 增量拉取（`since`） | 有 `incremental` 守門 | 舊 client 唔傳 `since` ⇒ 唔命中 | 低 |
| 投影／日期下限／每日上限 | 靠 mapper 一致性 | 舊 client 期望舊欄位（多回無害） | 低 |
| 輪詢閘／寫入閘 | 生效 | 舊 client 冇輪詢閘 ⇒ 照樣每 3 秒拉 | 中（egress） |
| 步驟閘（`pos_sessions`） | 生效 | 舊 client 唔送 session 標頭 ⇒ fail-open | 低 |

**教訓（建議寫入 `docs/113-agent-gotchas.md`）**：
> 伺服器**唔可以**用「partial payload ＋ 一個新欄位」去保護舊 client ——
> 舊 client 唔會睇個新欄位。凡係「可能令 `orders` 變空」嘅回應路徑，
> 都必須**要麼回真資料（至少未結帳單），要麼唔回 200**。
> 呢個同 `state-incremental-contract.test.ts` 守住嘅「partial 唔可以當全集」係同一條鐵律嘅**舊 client 版本**。

---

## 5 待辦（未做）

| 優先 | 項目 |
|---|---|
| P0 | 部署上面嘅修正 + 全店裝置重新載入（先斷開「舊 client × 新語義」組合） |
| P0 | 在「同步健康」加**可見警告**：呢部機跑住舊 bundle（唔止 log） |
| P1 | server 端對重複被拒事件做 log 節流，避免洗版掩蓋真錯誤 |
| P1 | `pos_sessions` 顯示：邊部機、跑邊個 build、最後一次拉取模式 |
| P1 | 清理 outbox 內「確定性拒收」嘅舊事件（自動轉 `skipped`） |
| P2 | 同日重複單號（`訂單27` ×2）、`pos_print_jobs.kind` 未寫入（上一輪已記錄） |

---

## 6 改動檔案

| 檔案 | 改動 |
|---|---|
| `src/app/api/pos/state/route.ts` | 節流骨架回未結帳單（唔再回空 orders）；`&& supabase` 守門；節流要求 storeId |
| `src/lib/pos/pos-app-queue-base.test.ts` | 新增守衛（節流骨架唔可回空 orders） |
| `tools/_analyze-logs-20260922-2016{,b}.cjs` + `.out.txt` | log 分析腳本與完整輸出（可重跑） |
| `tools/_probe-41ccd63c-20260922.cjs` + `.out.txt` | 雲端實查（訂單30 等） |

**驗證**：`node node_modules/typescript/bin/tsc --noEmit` → 0 error；
`node --test` → **1195 pass / 0 fail**。
