# POS 跨店數據串號修復方案

> 狀態：**已實施（2026-09-06）** —— 全部 6 層已落地，`tsc --noEmit` 通過。
> Migration 檔：`supabase/migrations/0022_pos_queue_events_store_id.sql`（0021 已被 print_jobs_anon_window_24h 佔用）。
> 實施時新增發現：`shift-page.tsx` 有**三條**獨立於 doFlush 嘅直接 flush 路徑（forceSyncBeforeClose / closeShift 嘅 POST），已一併加 `filterEventsForCurrentStore` 閘口；`print-jobs.ts deletePrintJobsOnServer` 與 `kiosk-order.ts submitKioskOrder` 兩個即建即推入口已 stamp `storeId`；`loadRuntimeState` 改用 `resolveStoreId()`（覆蓋 kiosk 綁定設備）。
> 關聯：調查報告（2026-09-06）—— `pos_queue_events` 無 `store_id` 欄，店鋪歸屬 100% 由 flush 當刻登入身份決定。

## 0. 根因一句話

`pos_queue_events` 表**結構上冇 `store_id` 欄**（已用 `information_schema.columns` 證實：只有 `id/type/entity_id/payload/status/created_at`）。
→ 所有店嘅同步事件混一袋；切帳號登入後 `loadRuntimeState()` merge 全店 queue + legacy-heal 重推 → flush 用新帳號 merchantId 當 `storeId` upsert → 外店單被「蓋章」搬去新店。

修復核心原則：**事件在產生嗰刻就帶住自己嘅 store，之後任何讀寫都按呢個 store 隔離，絕對唔可以再用「flush 當刻邊個登入」去決定一張單屬於邊間店。**

---

## 1. Migration（Supabase SQL）

```sql
-- 0021: pos_queue_events 加 store_id，實現 queue 級店鋪隔離
alter table pos_queue_events
  add column if not exists store_id text;

-- 索引：state 路由按 store 過濾、sync 路由按 store 寫入都需要
create index if not exists idx_pos_queue_events_store
  on pos_queue_events (store_id);

-- 注意：歷史 event 嘅 store_id 會係 null（冇得回填，因 queue 從未記錄）。
-- 呢啲 null 舊事件按下面 §3 嘅「legacy 處理」原則處理，唔強行歸屬。
```

> ⚠️ 若 Supabase 有 RLS，確保 `pos_queue_events` 嘅 RLS 唔會因新增欄阻擋 service_role 寫入（0016 後業務表已收 service_role-only）。

---

## 2. 類型層：`QueueEvent` 加 `storeId`

`src/lib/types.ts`（第 609 行 `interface QueueEvent`）：

```ts
export interface QueueEvent {
  id: string;
  type: QueueEventType;
  entityId: string;
  payload: unknown;
  status: "pending" | "synced" | "failed";
  createdAt: string;
  /** 事件產生時所屬店鋪（= resolveStoreId() 喺 enqueue 嗰刻嘅值）。
   *  跨店隔離嘅唯一真源；flush / state / sync 全部以佢為準，
   *  唔可以 fallback 去「當前登入 merchant」。 */
  storeId?: string;
}
```

---

## 3. 入隊中央落 `storeId`（5 個入口，新增一個 helper）

新增 helper（放 `src/lib/pos/sync-flush.ts` 或 `src/lib/storage.ts`）：

```ts
import { resolveStoreId } from "@/lib/pos/sync-flush"; // 已存在

/** 入隊前為事件補上所屬 store；已經有 storeId 嘅絕對唔覆寫（防止 foreign 事件被改姓）。 */
export function withStoreScope(events: QueueEvent[]): QueueEvent[] {
  const store = resolveStoreId();
  return events.map((e) => (e.storeId ? e : { ...e, storeId: store }));
}
```

逐一改動：

| # | 文件 / 行 | 改動 |
|---|---|---|
| 1 | `pos-app.tsx:2117` `pushEvents` | `persistQueue(withStoreScope(nextQueue))` —— 喺 `const nextQueue = [...queue, ...events]` 之後包一層 `withStoreScope` |
| 2 | `print-center.tsx:416` `pushEvents` | `saveQueue(withStoreScope(nextQueue))` |
| 3 | `pos-orders.ts:283` `saveQueue([event, ...queue])` | 改 `saveQueue(withStoreScope([event, ...queue]))` |
| 4 | `quick-order-fulfillment.ts:24` `saveQueue([event, ...queue])` | 同上包 `withStoreScope` |
| 5 | `shift-page.tsx` 各 `saveQueue(...)` | 呢啲係**重存已有事件**，唔新產生；`withStoreScope` 因「已有 storeId 唔覆寫」所以安全，建議一併包住以防萬一 |

> 關鍵：`resolveStoreId()` 在 enqueue 嗰刻返回嘅就係「產生呢張單嘅店」（登入 merchant 或 kiosk 綁定），正確對應事件原始歸屬。

---

## 4. flush 閘口（最重要嘅防線）

`src/lib/pos/sync-flush.ts` `doFlush()`：

**(a) 過濾：只推「屬於當前店」的事件**（第 239–243 行附近，`unflushed` 計算出來之後）：

```ts
const currentStore = resolveStoreId();
// 只推 storeId === 當前店 嘅事件；外店事件留喺 queue，等佢自己所屬嘅店登入時先推。
// legacy null（冇 storeId 嘅舊事件）：按下面 §7 原則，唔喺今次 flush 重推，避免改姓。
const scoped = unflushed.filter(
  (e) => !!e.storeId && (currentStore ? e.storeId === currentStore : false),
);
if (scoped.length === 0) return;
```

**(b) 每個事件帶自己嘅 storeId 上雲**（第 267–274 行 `body` 構造）：

```ts
events: flippable.map((e) => ({
  id: e.id,
  type: e.type,
  entityId: e.entityId,
  payload: e.payload,
  status: e.status,
  createdAt: e.createdAt,
  storeId: e.storeId,   // ← 新增
})),
```

> 呢個閘口令「即使外店事件神奇地混入咗本地 queue，都唔會以當前店身份被 push 上雲」—— 係防禦縱深嘅最後一關。

---

## 5. `/api/pos/sync`：用事件自身 store，唔用請求 store

`src/app/api/pos/sync/route.ts`：

**(a)** 每個 event 先解析 `eventStoreId`：

```ts
const eventStoreId =
  typeof event.storeId === "string" && event.storeId.trim()
    ? event.storeId.trim()
    : null;
```

**(b)** `pos_queue_events` upsert（第 200–210 行）加 `store_id`：

```ts
await supabase.from("pos_queue_events").upsert(
  {
    id: eventId,
    type: eventType,
    entity_id: text(event.entityId, MAX_ID_LEN),
    payload: eventPayload,
    status: text(event.status, 64),
    created_at: typeof event.createdAt === "string" ? event.createdAt : new Date().toISOString(),
    store_id: eventStoreId,   // ← 新增
  },
  { onConflict: "id" },
);
```

**(c)** `ORDER_CREATED` / `ORDER_UPDATED` 寫 `pos_orders`（第 225–261 行）：將 `store_id: storeId` 改為用 `eventStoreId`（fallback 請求 storeId 只做 legacy 兼容）：

```ts
store_id: eventStoreId ?? storeId,
```

> 需要決策：是否**嚴格**要求 `eventStoreId` 必須存在（ORDER_CREATED 無 storeId 即 400）？
> 建議：**嚴格**。新 client 全部帶 storeId，無 storeId 即係舊/偽造事件，拒收最安全。
> 若想溫和過渡，先 `?? storeId` fallback，下個版本再收緊。

**(d)** `ORDER_SETTLED`（第 298–302 行）與 `PRINT_JOB_CREATED`（第 340–357 行）、`PRINT_JOB_DELETED`（第 370–374 行）、`ORDER_DELETED`（第 386–390 行）嘅 `.eq("store_id", storeId)` 改為 `.eq("store_id", eventStoreId ?? storeId)`，insert 時 `store_id: eventStoreId ?? storeId`。

---

## 6. `/api/pos/state`：queue 按 store 過濾（唔好再返全店）

`src/app/api/pos/state/route.ts` 第 149 行：

```ts
// 改前：
const queueQuery = supabase.from("pos_queue_events").select("*").order("created_at", { ascending: false }).limit(300);

// 改後：storeId 必須有，先按 store 過濾；無 storeId 直接返空（fail safe，絕不洩露其他店）
const queueQuery = storeId
  ? supabase.from("pos_queue_events").select("*").eq("store_id", storeId).order("created_at", { ascending: false }).limit(300)
  : supabase.from("pos_queue_events").select("*").limit(0); // 無 storeId 唔返任何 queue
```

回傳 mapping（第 170–178 行）補 `storeId: event.store_id ?? undefined`。

> 同步修補：報表頁 `/api/pos/state?ordersOnly=1` 已帶 `storeId`，所以訂單查詢（第 122–124 行）本來就過濾，唔使改；但 queue 段一直漏咗。

---

## 7. `loadRuntimeState` merge：只收屬於當前店嘅 server 事件

`src/components/pos-app.tsx` 第 769–796 行（接 `payload.queue`）：

```ts
if (Array.isArray(payload.queue)) {
  const currentStore = resolveStoreId();
  const localQueue = loadQueue();
  const localById = new Map(localQueue.map((e) => [e.id, e]));
  const mergedQueue: QueueEvent[] = [];
  const seen = new Set<string>();
  for (const e of payload.queue) {
    // 🛡️ 跨店隔離：server 返嚟嘅事件若唔係當前店，直接 skip，唔 merge 入本地 queue
    if (currentStore && e.storeId && e.storeId !== currentStore) continue;
    seen.add(e.id);
    mergedQueue.push(localById.get(e.id) ?? e);
  }
  for (const e of localQueue) {
    if (!seen.has(e.id)) mergedQueue.push(e);
  }
  // ... 餘下 signature 判斷 + setQueue + saveQueue 不變
}
```

> 呢度係「即使 state 路由漏咗過濾」嘅第二道閘。配合 §6 雙重保險。

---

## 8. 報表與 Local 後門收口

**(a)** `src/components/restaurant-daily-report.tsx` 第 864–902 行（`merchantId` 為 null 嗰條 dev 後門）：

```ts
// 改前：merchantId 為 null → fetch /api/pos/state 唔帶 storeId → 返全店 + belongsToStore 放行
// 改後：merchantId 必須有；無則直接 setOrders([]) + 顯示「請先選擇店鋪」，唔好拉全店
if (!merchantId) {
  setOrders([]);
  return; // fail safe，絕不顯示跨店資料
}
```

**(b)** `src/lib/storage.ts` `prepareStoreStorage()`（第 127–155 行）legacy 遷移：

- `legacyDataBelongsToMerchant()` 喺**冇 legacy bootstrap 時唔可以無條件返 true**；改為：若無法確認歸屬，寧願**唔遷移**（留喺 legacy key 等人工處理），唔好整套吸收入新店 scope。
- 或者更穩：遷移前先按 `pos_orders.store_id` / queue 內容推斷歸屬，對唔上當前 merchant 就 skip。

---

## 9. 數據修復（已污染行）

`pos_queue_events` 冇 store 歷史，冇法自動還原「原本屬邊間店」。建議**只診斷、唔自動改寫**，靠外部真源判斷：

```sql
-- 診斷：pos_orders 嘅 store_id 同「外部真源」對唔上嘅單
-- 外部真源 1：online_order_id 對應 Ledger 渠道嘅 merchant
-- 外部真源 2：local_order_no 若各店有固定前綴
-- 下面係最簡單嘅「懷疑名單」：同一張單被多個 store 嘅事件碰過
select o.id, o.store_id, o.local_order_no, o.online_order_id, o.source, o.created_at
from pos_orders o
where o.store_id is distinct from (
  -- 呢度換成你嘅外部真源 subquery
  null
)
order by o.created_at desc;
```

> 決策點：是否要寫一條「按外部真源 re-tag `pos_orders.store_id`」嘅修復 SQL？
> **建議暫緩**，先觀察新機制上線後仲有冇新污染；舊污染單可逐張人工核對（數量應該有限，主要係 60000003↔65273599 切換期間嗰批）。

---

## 10. 防禦縱深總結

| 層 | 位置 | 作用 |
|---|---|---|
| 1. 產生 | §3 入隊 helper `withStoreScope` | 事件一出世就帶所屬 store |
| 2. 合併 | §7 `loadRuntimeState` | 唔收 server 返嚟嘅外店事件 |
| 3. 推送 | §4 `doFlush` 過濾 | 只推屬於當前店嘅事件 |
| 4. 雲端寫入 | §5 `/api/pos/sync` | 用事件自身 store 寫 `pos_orders`，唔用請求 store |
| 5. 雲端讀取 | §6 `/api/pos/state` | queue 按 store 過濾，無 storeId 唔返 |
| 6. 報表/Local | §8 | 收口 dev 後門 + legacy 遷移擁有權 |

任一一層漏咗，其餘層仍然擋得住——呢係跨店隔離要嘅最低要求。

---

## 11. 驗證步驟（實施後）

1. **單元/手動**：用 60000003 落一張線下單 → 切去 65273599 → 65273599 報表**唔應該**出現 60000003 嘅線下菜品。
2. **DB 旁觀**：`select store_id, count(*) from pos_queue_events group by store_id` —— 確認事件按店分佈，唔再全部混一袋。
3. **Local 驗證**：localhost dev 無 Supabase 時，切帳號後本地 queue / 報表 fallback 唔顯示外店單。
4. **診斷面板**：報表內置 `storeIdBreakdown` / `foreignStoreCount` 應為 0（外店事件已被 §7 skip）。

---

## 12. 風險與注意

- **legacy null 事件**：§3 helper 唔會改寫已有 storeId；§4 flush 過濾會**跳過** null storeId 舊事件（佢哋唔會再被重推，留喺本地 queue）。若擔心呢啲舊事件冇上雲，可喺升級時將佢哋標 `synced`（假設歷史已推送過）。
- **kiosk 單**：`resolveStoreId()` 喺未登入 POS 時退到 kiosk 綁定 storeId，正確對應 kiosk 所屬店；落單嗰刻 stamp 嘅就係對嘅店。
- **print job 順帶修好**：§5(d) 令 `pos_print_jobs.store_id` 跟事件自身 store，順便解決 comments 入面提到嘅「雲端中繼配咗對但一張都印唔出」silent failure。
- **唔改寫歷史 `pos_orders`**：實施只防止**新**污染；已經被改姓嘅舊行按 §9 人工處理。
