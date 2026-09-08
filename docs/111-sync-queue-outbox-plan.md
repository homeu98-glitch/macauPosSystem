# 111 · 同步隊列 Outbox 化根治方案

> 起因：交班畫面彈「⚠ 仲有 100 筆資料未同步上雲」。查落呢個數係**假陽性**為主，
> 但入面藏住兩個真 bug。本文講清楚成因 + 根治設計（改動集中喺 client，server 基本唔使郁）。
>
> 相關程式碼：
> - `src/lib/pos/sync-flush.ts`（flush worker：`doFlush` / `filterEventsForCurrentStore` / `withStoreScope`）
> - `src/lib/storage.ts`（`loadQueue` / `saveQueue`，key = `macau-pos/stores/{merchantId}/sync-queue`）
> - `src/components/shift-page.tsx`（`queueSummary` 第 227 行、`forceSyncBeforeClose` 第 349 行）
> - `src/components/pos-app.tsx`（`pushEvents` 第 2298 行、`syncNow` 第 2254 行、state merge 第 917 行）
> - `src/app/api/pos/sync/route.ts`、`src/app/api/pos/state/route.ts`
>
> 診斷工具：`tools/diagnose-sync-queue.js`（F12 Console 貼上跑，只讀）

---

## 1. 兩個名詞：乜嘢係「外店」同「去重輸家」

### 1.1 外店事件（foreign / unscoped）

每條 queue event 出世嗰刻會由 `withStoreScope()` 蓋一個 `storeId`
（= 登入嘅 `merchantId`，或 Kiosk 綁定嘅店）。2026-09-06 跨店隔離之後，
`filterEventsForCurrentStore()` 規定：**淨係 `storeId === 當前登入店` 嘅事件先會被推送**。

所以有兩批事件係「推唔到」嘅：

| 類型 | 點嚟 | 下場 |
|---|---|---|
| `storeId` = 第 2 間店 | server `/api/pos/state` merge 落嚟、或者曾經用第二個帳號落單 | 留喺本機等嗰間店登入 |
| `storeId` = `undefined` | 2026-09-06 之前產生嘅舊事件；未登入 / Kiosk 未綁店時落嘅單 | **無主孤魂，永遠無人接** |

關鍵：呢批事件**連 POST 都冇發過**，所以 `attempts` 唔會加、永遠唔會變 `failed`
（變 `failed` 要 server 連續拒收 5 次）。結果就係永久 `pending`，一世計落「未同步」。

### 1.2 去重輸家（dedup loser）

`doFlush` 推送前會做一次去重：

```ts
// src/lib/pos/sync-flush.ts:290
const candidateByEntity = new Map<string, ExtendedQueueEvent>();
for (const e of scoped) {
  if ((e.attempts ?? 0) >= MAX_SYNC_ATTEMPTS) continue;
  const prev = candidateByEntity.get(e.entityId);
  if (!prev || prev.createdAt < e.createdAt) candidateByEntity.set(e.entityId, e);
}
const flippable = Array.from(candidateByEntity.values()).slice(0, MAX_EVENTS_PER_FLUSH);
```

**同一個 `entityId` 每次 flush 淨推最新一條**，而 `entityId` 對訂單類事件一律係 `order.id`：

- `ORDER_CREATED` → `entityId = order.id`
- `ORDER_UPDATED` → `entityId = order.id`
- `ORDER_ITEM_VOIDED` → `entityId = order.id`（退幾件就有幾條）
- `ORDER_SETTLED` → `entityId = order.id`

即係一張單由落單到結帳產生嘅所有事件**共用同一個 entityId**。
一張 5 個 item 全退嘅單可以產生 1 + 1 + 5 + 1 = 8 條事件，
flush 只推 1 條（最新嗰條），**只有嗰條標 `synced`，其餘 7 條永久 `pending`** ——
呢 7 條就係「去重輸家」。下次 flush 佢哋又會輸（因為永遠有條最新嘅贏佢哋），無限輪迴。

數據其實已經由嗰條贏出嘅事件上咗雲，所以呢個警告係**假陽性**。

### 1.3 順便發現：去重邏輯本身有資料丟失風險（比假警告嚴重）

去重係「最新者贏」，**不理事件類型**。會出事：

- 離線落新單 → 退菜 → 結帳，全部喺 30 秒內發生：
  最新嗰條係 `ORDER_SETTLED`，但 server 嘅 `ORDER_SETTLED` 分支用 `.update()`（route.ts:325），
  **訂單行仲未存在 → 影響 0 列、唔報錯** → 張單永遠唔會出現喺 `pos_orders`。
- 最新嗰條係 `ORDER_ITEM_VOIDED` 時更慘：server 根本冇處理呢個 type
  （只 upsert 落 `pos_queue_events`），`pos_orders` 一欄都唔寫。

即係「離線一輪操作」可以令張單喺雲端蒸發。呢個先係要根治嘅主因。

### 1.4 另外兩個真 bug（而家就該修）

| 位置 | 問題 |
|---|---|
| `shift-page.tsx:405` | `saveQueue(retryable.map(...synced))` 係**成條 queue 覆寫**，交班強制同步成功後會剷走 failed / 外店 / 其他事件 |
| `pos-app.tsx:2271` `syncNow()` | **冇 check `res.ok`** 就全標 synced；server 返 500 都當成功，資料留喺本機又唔會再試 |
| `quick-order-fulfillment.ts:44/72` | `status: readNetworkOnline() ? "synced" : "pending"` —— 線上時**未 push 就寫 synced**，出餐/完成狀態要靠 `legacyHealed` 撞彩先上到雲 |

---

## 2. 根治目標：把 queue 由「狀態流水帳」變成「outbox」

設計不變量（往後所有 code 都要守）：

1. **queue 入面淨係「仲未上雲嘅工作」** —— 上咗雲就刪，唔留 `synced` 墓碑。
2. **queue 入面每條事件都一定要有明確下場** —— 推得到（pending）、推唔到但有主（foreign）、
   無主（unscoped）、失敗（failed）。**唔可以有「無限期 pending 但永遠唔推」嘅狀態**。
3. **唔同 type 嘅事件唔可以互相取代** —— 取代淨限「同 entity + 同 type + 同 item」。
4. **推送按時間升序**，保證 `ORDER_CREATED` 先過 `ORDER_SETTLED`。

---

## 3. 改動設計

### A. 入隊時合併（取代 flush 去重）

新增 `src/lib/pos/queue-coalesce.ts`：

```ts
/** 合併鍵：只有「同一個目標 + 同一種操作」嘅事件先可以互相取代。 */
export function coalesceKey(e: QueueEvent): string {
  switch (e.type) {
    case "ORDER_ITEM_VOIDED":
      // 唔同 item 嘅退菜要各自保留，唔可以互相取代
      return `void:${e.entityId}:${String((e.payload as { menuItemId?: string })?.menuItemId ?? "")}`;
    case "DEVICE_CONFIG_UPDATED":
    case "TEST_PRINT_REQUESTED":
      return e.type; // 全店 / 全機設定，淨留最新一條
    default:
      return `${e.type}:${e.entityId}`; // ORDER_* / PRINT_JOB_*（entityId 本身唯一）
  }
}

/** 入隊：撞 key 嘅舊 pending 被新事件取代（原位替換，保次序）；撞唔到就 append。 */
export function enqueueEvents(queue: QueueEvent[], incoming: QueueEvent[]): QueueEvent[]
```

- 所有 enqueue 入口改用佢：
  | call site | 附帶要修嘅嘢 |
  |---|---|
  | `pos-app.tsx:2298 pushEvents` | — |
  | `print-center.tsx:417 pushEvents` | — |
  | `pos-orders.ts:282 / :333` | 入隊後補 `notifyQueueChanged()` |
  | `quick-order-fulfillment.ts:26 persistOrderUpdate` | ⚠️ 而家寫 `status: readNetworkOnline() ? "synced" : "pending"` —— **線上時寫 synced 但從來冇 push**，靠 `legacyHealed` 首次 flush 撞彩先上到雲。改做一律 `pending` + 入隊後 `notifyQueueChanged()` |
  | `shift-page.tsx:343 / :631` | — |
  | `device-settings.tsx:450` | — |
- `doFlush` 入面嘅 `candidateByEntity` 去重**刪掉**（唔再有輸家）。
- 效果：一張單最多 1 條 CREATED + 1 條 UPDATED + N 條 ITEM_VOIDED（每 item 一條）+ 1 條 SETTLED，
  全部都會被推送、全部都會被 ack。

### B. ack 即刪（outbox 語義）

`doFlush` 成功分支（sync-flush.ts:362）由「標 synced」改為「從 queue 刪除」：

```ts
const nextQueue = allQueue.filter((e) => !flippedIds.has(e.id));
saveQueue(nextQueue);
```

- 前提係 C（唔再從 server merge queue 返落本地），否則會無限重推。
- queue 長度從此 = 實際待辦量，`pendingEvents` 唔使再減任何嘢就係真數。
- `local-orders-panel.tsx:197` 已經有「直接 `saveQueue(filter(...))` 剷事件」嘅先例，語義一致。

### C. 移除 server → client 嘅 queue merge

`pos-app.tsx:917-949` 成段刪（或加 feature flag 開關）。

- 理由：queue 係**本機 outbox**，事件推上雲之後就係 server 嘅事；
  結果狀態由 `orders` / `printJobs` 兩條獨立 pull 攞返（呢兩條本來就有）。
  而家 merge 返落嚟只會造成：外店事件流入、其他收銀機嘅舊事件喺呢部機「復活」成 pending
  （server 嗰張 `pos_queue_events.status` 永遠係 `pending`，因為 client 推送時就寫死 pending）。
- `/api/pos/state` 嘅 `queueQuery`（state/route.ts:101）可以保留（server 端審計日誌仲有用），
  純粹 client 唔再消費。或者跟 P2 直接唔查。

### D. 推唔到嘅事件要有終態（消滅「外店 / 無主」假 pending）

`QueueEvent.status` 加 `"skipped"`，加 `skipReason?: "foreign-store" | "no-store"`
（`src/lib/types.ts:621`）。

flush 開始前對每條 pending 做 classify（抽成 `classifyQueueEvent(e, currentStoreId)`）：

| 情況 | 動作 |
|---|---|
| `storeId === 當前店` | 保持 `pending`，正常推 |
| `storeId` 有值、唔等於當前店 | → `skipped / foreign-store` |
| `storeId` 係 `undefined` | → `skipped / no-store` |

切店 / 切帳號時（`prepareStoreStorage` 同一時機）跑 `reconcileQueueScope()`：
- `skipped/foreign-store` 且 `storeId === 新店` → reset 做 `pending`（回到自己店，重新排隊）
- `pending` 但 `storeId !== 新店` → 轉 `skipped/foreign-store`

UI（交班頁 `queueSummary`）：
- 「待同步事件」**淨計 `pending`**（已經係真數，唔使再剔）
- 加一行「N 筆無歸屬資料（唔會上雲）」+ 掣，開一個小 panel 畀用家揀：
  「歸屬當前店並重推」/「永久清除」。panel 可以放喺 `local-orders-panel.tsx`（已有清 queue 先例）。

### E. 修嗰兩個 bug

- `shift-page.tsx:405`：改成 merge，唔好成條覆寫
  ```ts
  const acked = new Set(retryable.map((e) => e.id));
  saveQueue(loadQueue().map((e) => (acked.has(e.id) ? { ...e, status: "synced" as const } : e)));
  ```
  （若已做 B，則係 `filter` 剷走 acked 嗰批，其餘原樣保留）
- `pos-app.tsx:2271 syncNow()`：加 `if (!res.ok) { toast error; return; }`，同 `doFlush` 一致。

### F. 啟動一次性 GC + queue 上限

新增 `gcSyncQueue()`，喺 `installPosSyncQueueAutoFlush()` 首次 trigger 時跑一次：

1. 剷晒 `status === "synced"`（墓碑，配合 C 後再冇用）
2. 用 `coalesceKey()` 合併：撞 key 只留最新一條（舊嘅 delete）
3. classify 外店 / 無主 → `skipped`
4. 上限 `MAX_QUEUE = 2000`：超出由最舊嘅 `skipped` 開始掉，`console.warn` + UI 計數

之後靠 A（入隊合併）+ B（ack 即刪）維持不變量，正常情況 queue 會長期接近 0。

### G.（P1 加固）server `ORDER_SETTLED` 落單保證

`api/pos/sync/route.ts:325` 而家用 `.update().eq("id")`，訂單行唔存在時靜默 0 列。
建議改成：update 命中 0 列 → fallback `upsert` 最小欄位（`id` / `store_id` / `status` / `total` /
`payment_method` / `updated_at`），或者至少 `console.warn` 方便事後追。
（有咗 A 之後正常唔會發生，但係最後一道保險。）

---

## 4. 分期

| 期 | 內容 | 風險 | 改動檔案 |
|---|---|---|---|
| **P0**（同一日，獨立可出） | E 修兩個 bug + `queueSummary` 暫時用「真待推送」計法（剔外店 + 剔去重輸家，邏輯同 `tools/diagnose-sync-queue.js`） | 極低，純顯示 + bugfix | `shift-page.tsx`、`pos-app.tsx` |
| **P1**（根治主體） | A 入隊合併、B ack 即刪、C 移除 queue merge、D skipped 終態 + UI、F GC | 中（要 regression 測離線落單） | `sync-flush.ts`、新 `queue-coalesce.ts`、各 enqueue call site、`types.ts`、`pos-app.tsx`、`shift-page.tsx`、`local-orders-panel.tsx` |
| **P2**（加固） | G server settle 兜底、`pos_queue_events` 保留期清理（建議 7 日，DDL 喺 migration 0027）、queue 長度監控 | 低 | `api/pos/sync/route.ts`、`supabase/migrations/0027_*.sql` |

### 回滾

- P1 全部改動加 feature flag：`localStorage["macau-pos/sync-outbox-v2"] === "1"` 先行新邏輯，
  否則行舊 path。出事刪咗個 key 即還原（舊 path 保留一排，P1 上線稳定运行兩星期後先拆）。
- Server 零改動（G 除外）→ 唔使 migrate、唔使停機。

---

## 5. 點樣驗證「100 筆」真係冇咗

1. 改之前喺出警告嗰部機跑一次 `tools/diagnose-sync-queue.js`，記低
   `pending_按storeId` / `去重輸家_永遠推唔到` / `真_待推送` 三個數。
2. P0 上線：交班頁「待同步」應該即刻跌到 ≈ `真_待推送`（預計 0）。
3. P1 上線 + 跑一次 GC：
   - 再跑診斷 → `去重輸家` = 0、`pending_按storeId` 只剩「= 當前店」、`pending` 總數 ≈ 0
   - 交班頁「待同步事件」= 0，另顯示「N 筆無歸屬資料」（等你決定歸屬定清除）
4. 離線 regression（必做）：
   - 飛行模式 → 落新單 → 退 2 件菜 → 加菜 → 結帳 → 連網
   - 30 秒內 pending 歸 0；雲端 `pos_orders` 要有呢張單，狀態 settled、金額同本地一致
   - 再開第二部機 / 清 cache 重入 → 張單要喺度（證明 C 移除 merge 冇影響）
5. 跨店 regression：A 店落單 → 登出 → 登入 B 店 → 交班頁唔應該顯示 A 店嘅嘢，
   且 A 店單唔應該被搬去 B 店；登返 A 店 → skipped 事件 reset 做 pending 並推送。
