/**
 * `/api/pos/sync` 訂單事件 payload 嘅拆解規則 —— **全 codebase 單一真源**。
 *
 * ## 為何要抽成模組（2026-09-16 事故）
 *
 * `ORDER_CREATED` / `ORDER_UPDATED` 嘅 payload 歷史上出現過**兩種形狀**：
 *
 * | 產生者 | 形狀 |
 * |---|---|
 * | 收銀台 `pos-app.tsx submitOrder()`（加單） | `{ order, addedItems }` |
 * | kiosk / 掃碼 `kiosk-order.ts submitKioskOrder()` | **裸 order** |
 * | 線上單橋接 `ledger-pos-bridge.ts enqueueOrderEvent()` | `{ order }`（**兩種 type 都用**） |
 *
 * 舊版 `sync/route.ts` 有**兩處**各自實作拆解，而且規則唔一致：
 *   - 「LWW 預取」段：只喺 ORDER_UPDATED 拆 `.order`
 *   - 「主解析」段：只喺 ORDER_UPDATED 拆 `.order`
 * ⇒ 線上單橋接嘅 **ORDER_CREATED**（`{ order }`）兩處都攞唔到訂單物件：
 *   ① 主解析 → `order.id === undefined` → `ack(false, "事件 payload 缺少訂單 id")` → **HTTP 400（永久）**；
 *   ② 預取 → 攞唔到現有 row → **LWW 守門靜默失效**（有機會將已 settled 嘅單降級）。
 *
 * 實案：2026-09-16 店舖 `8291f843…` 有 6 筆 `entity_id = ledger-<uuid>` 嘅 ORDER_CREATED
 * 卡死喺 attempts ≥ 5，喺「同步健康檢查」點「放棄」reload 後又彈返。
 *
 * ## 不變量
 *
 * 1. **兩種 type 都用同一條規則**：有 object 型 `.order` 就用佢，否則當 payload 本身就係張單。
 *    呢個順序唔會誤判 —— `PosOrder`（`src/lib/types.ts`）本身**冇** `order` 呢個欄位。
 * 2. `.order` 只認 **plain object**（`null` / 陣列 / 字串一律唔當 nested）。
 * 3. 呼叫端傳入嘅 payload 應該已經係 plain object（`sync/route.ts` 會把非 object 收窄成 `{}`）；
 *    呢度仍然做一次防禦，非 object 一律當 `{}`（`id` 缺 → route 照舊回 400，行為不變）。
 *
 * 純函式、零依賴 ⇒ 可以 `node --test` 直接跑（見 `sync-order-payload.test.ts`）。
 */

/** 判斷係咪可當作 nested order 嘅 plain object。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 由 `ORDER_CREATED` / `ORDER_UPDATED` 嘅 payload 抽出訂單物件。
 *
 * @param payload 已收窄嘅事件 payload（`sync/route.ts` 內為 `eventPayload`）
 * @returns 訂單物件；永遠回一個 plain object（拆唔到就回 payload 本身／`{}`）
 */
export function unwrapOrderEventPayload(payload: unknown): Record<string, unknown> {
  const p = asRecord(payload);
  if (!p) return {};
  return asRecord(p.order) ?? p;
}

/**
 * 抽出「本次新增菜品」（只有收銀台加單同新版 kiosk 會帶）。
 * @returns 陣列或 `null`（缺欄 / 型別唔啱）。
 */
export function addedItemsOfEventPayload(payload: unknown): Record<string, unknown>[] | null {
  const p = asRecord(payload);
  if (!p) return null;
  return Array.isArray(p.addedItems) ? (p.addedItems as Record<string, unknown>[]) : null;
}
