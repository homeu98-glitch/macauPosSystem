# 68 · 結帳後空枱被舊單 occupy 修復（Option A）

> 日期：2026-08-26
> 類別：數據同步 / 防復活過濾（非結帳邏輯錯）
> 落碼：web-only（`src/lib/pos-order-filters.ts`），Vercel push 即生效，唔使 rebuild exe / apk

---

## 1. 現象（用家報）

完成一張單嘅「收單」操作（settled）後，原本處於空閒、無人狀態嘅幾張枱，突然重新顯示咗訂單記錄。

預期：收單 → 枱變 idle → 只有真正未完成嘅枱顯示單。
實際：收單後，若干**原本空枱**被**舊單**佔據。

---

## 2. 根因鏈（數據同步，唔係結帳邏輯錯）

收單本身冇錯，問題出喺收單之後觸發嘅「雲端 backfill」將**卡住嘅舊 open 單**拉返嚟復活：

1. **收單寫入終態**
   `applyPaymentToOrder`（~pos-app.tsx:2478）對 dine-in 單 set `status:"settled"`，再 `syncNow([...queue, paymentEvent], {silent:true})` 推 DB。

2. **queue 清空 → 觸發 backfill**
   收單後 sync-queue 清空，pos-app effect（~pos-app.tsx:564-570）偵測到 → 調 `loadRuntimeState()`。

3. **backfill 撈齊全店 orders（無 filter）**
   `loadRuntimeState` → `GET /api/pos/state?storeId=X`（`src/app/api/pos/state/route.ts:24-26`）。
   該 route **讀 `pos_orders` 全部同店單，`limit(200)`，無日期 / 無狀態 filter** → 舊到前日嘅 open 單照樣撈返嚟。

4. **合併 + 防復活過濾**
   `mergeOrderLists(...)`（pos-order-filters.ts:36）→ `filterResurrectedOrders(orders, deletedOrderIds, localOrders)`（~pos-app.tsx:589-597）。

5. **舊版 filter 冇擋「舊 open 單」← 關鍵缺口**
   舊 `filterResurrectedOrders` 只擋：
   - ① tombstoned 已刪 id（`deletedOrderIds`）；
   - ② server 單邊終態單（cancelled / refunded / partially_refunded / settled，見 docs/52）。
   **完全冇擋 server 單邊嘅「舊 open 單」**（draft / sent_to_kitchen / paid / reopened）。
   → 個別卡住未結帳 / 落單冇成功 / 落咗冇落單嘅舊 open 單經 backfill 復活。

6. **復活單 occupy 空枱**
   `openOrders = orders.filter(status ∈ {draft, sent_to_kitchen, paid, reopened})`（pos-app.tsx:781）
   → `tableOrderMap: tableId → order`（pos-app.tsx:846）
   → 枱 status = `tableOrderMap.get(id)?.status ?? "idle"`（pos-app.tsx:2762）。
   舊 open 單 map 咗去原本 idle 嘅枱 → 枱面顯示「有單」。

7. **面板 vs 枱面錯覺（為何面板搵唔到）**
   `local-orders-panel.tsx:140-145` 用 `orderMatchesLocalDateFilter(order, "today")` filter 面板清單
   → 舊 open 單（updatedAt 舊過今日）唔喺面板出；但枱面用全 `orders` → 「枱面見單、面板搵唔到」嘅假象。

---

## 3. 相關代碼 / 數據表 一覽

| 位置 | 角色 | 備註 |
| --- | --- | --- |
| `src/app/api/pos/state/route.ts:24-26` | backfill 讀 `pos_orders` | **無日期 / 狀態 filter**，舊單來源 |
| `src/lib/pos-order-filters.ts:36` `mergeOrderLists` | 合併多源 orders（server 版優先，保 local `localOrderNo`） | B4 防 `row.id` fallback 覆寫 |
| `src/lib/pos-order-filters.ts:98` `filterResurrectedOrders` | **防復活過濾（今次改）** | 舊版只擋 tombstone + 終態單 |
| `src/components/pos-app.tsx:564-570` | queue 清空 → `loadRuntimeState` | backfill 觸發點 |
| `src/components/pos-app.tsx:589-597` | 調 `filterResurrectedOrders` | 合併後過濾 |
| `src/components/pos-app.tsx:781` `openOrders` | 活躍單集合 | 含復活舊單 → occupy 枱 |
| `src/components/pos-app.tsx:846` `tableOrderMap` | 枱 → 單映射 | 舊單指去 idle 枱 |
| `src/components/pos-app.tsx:2762` | 枱 status 計算 | `?? "idle"` |
| `src/components/local-orders-panel.tsx:140-145` | 面板 `today` filter | 舊單唔喺面板出 → 錯覺 |
| Supabase `pos_orders` | 真源表 | 卡住舊 open 單喺呢度 |

---

## 4. 排查 SQL（確認邊啲舊單企咗枱）

```sql
-- 查看「本店、非終態、且 updated_at 超過 1 日」嘅卡住 open 單
SELECT id, table_id, status, updated_at, created_at
FROM pos_orders
WHERE store_id = '<登入店 merchantId>'
  AND status NOT IN ('settled','cancelled','refunded','partially_refunded')
  AND updated_at < now() - interval '1 day'
ORDER BY updated_at DESC;

-- 若想睇佢哋 occupy 咗邊啲枱：
SELECT table_id, count(*) AS stale_open_orders
FROM pos_orders
WHERE store_id = '<登入店 merchantId>'
  AND status NOT IN ('settled','cancelled','refunded','partially_refunded')
  AND updated_at < now() - interval '1 day'
GROUP BY table_id
ORDER BY table_id;
```

正本店數據做法（任選）：
- 確認已經無效 → `UPDATE pos_orders SET status='settled' ...`（或 `DELETE`）令佢唔再被當 open 單；
- 唔使手動改：front-end 修復（§5）已令呢類單唔會再喺 client 復活 occupy 枱。

---

## 5. 修復（Option A · 改 client `filterResurrectedOrders`）

> 三選項背景（用家揀 A）：
> - **A（採用）**：`filterResurrectedOrders` 擴到「server 單邊嘅 open 單，若本機無且 `updatedAt` 超過 N 日（預設 1 日）→ 唔復活」。client-only，Vercel push 即生效。
> - B（server 側）：`/api/pos/state` 加 `updated_at > now()-N day` 或 status filter，唔撈舊 open 單。要改 route + 可能影響 realtime。
> - C（根治）：落單失敗 / 卡住嘅單後台 cleanup job 定時 settle。工程大，跨團隊。

### 落碼（`src/lib/pos-order-filters.ts`）

新增常數：

```ts
/**
 * 舊 open 單最大年齡（由 updatedAt 計）。超過呢個時間、且本機無嘅 server 單邊 open 單，
 * 經 backfill / realtime 唔可以復活 occupy 枱（見 docs/68）。預設 1 日——即「今日」嘅單
 * （含 kiosk 即時新單）照常拉到；舊到昨日或之前嘅 open 單（卡住未結帳 / 落單冇成功 / 冇落單）
 * 唔會再 occupy 空枱。可視需要調大（例如 2 日）。
 */
export const STALE_OPEN_ORDER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
```

`filterResurrectedOrders` 加第三擋：

```ts
export function filterResurrectedOrders(
  orders: PosOrder[],
  deletedOrderIds: string[],
  localOrders: PosOrder[],
): PosOrder[] {
  const deleted = new Set(deletedOrderIds);
  const localIds = new Set(localOrders.map((o) => o.id));
  const now = Date.now();
  return orders.filter((o) => {
    if (deleted.has(o.id)) return false;
    // 終態單：server 單邊唔可以復活（docs/52）
    if (isTerminalOrderStatus(o.status) && !localIds.has(o.id)) return false;
    // 舊 open 單：server 單邊 + 本機無 + 超過 1 日 → 唔復活（docs/68）
    if (!isTerminalOrderStatus(o.status) && !localIds.has(o.id)) {
      const ts = orderTimestamp(o);
      if (ts > 0 && now - ts > STALE_OPEN_ORDER_MAX_AGE_MS) return false;
    }
    return true;
  });
}
```

### 語義保證

| 情況 | 行為 |
| --- | --- |
| server 單邊 open 單，`updatedAt` ≤ 1 日（今日 / kiosk 新單） | ✅ 照常通過（唔誤殺當日單） |
| server 單邊 open 單，`updatedAt` > 1 日（卡住舊單） | ❌ drop，唔 occupy 空枱 |
| 本機 localStorage 已有嘅單（無論幾舊） | ✅ 永遠保留（`localIds` 優先，本機對賬 tab 照見） |
| 終態單（settled/cancelled/refunded/partially_refunded），本機無 | ❌ drop（docs/52 原有規則不變） |
| 本機已 tombstone 刪除 id | ❌ drop |

> 判定 `orderTimestamp(o) = Date.parse(o.updatedAt || o.createdAt)`；`ts > 0` 先防 0 值（兩者皆空）誤殺。

---

## 6. 驗證

- `npx tsc --noEmit`（過濾 `layout.tsx` 已知誤報）→ 零新 error。
- 行為回歸：收單後 backfill 撈到嘅舊 open 單（>1 日、本機無）唔會再入 `openOrders`，空枱保持 idle。
- 不影響：今日進行中單、kiosk 即時單、本機已存單、終態單規則。

---

## 7. 部署

- **web-only**：改動只在 `src/lib/pos-order-filters.ts`，Companion / Android APK 唔用呢個 filter → **唔使 rebuild exe / apk**。
- Vercel push 即生效。建議連 §65 / §66 / §67 / §67b 一批過 commit + push。
- 如想正本店數據，跑 §4 SQL 確認並 settle / 清走卡住舊單。
