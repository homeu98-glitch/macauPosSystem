# 56 — 「立即同步」與「刪除全部訂單」行為釐清（只說明，唔改碼）

> 狀態：**釐清後已落碼**（2026-08-26）。原只釐清，後續用家 confirm 硬化刪除邏輯 + 移除「立即同步」btn，見 §6。
> 關聯：`docs/52-clear-delete-sync-consistency-plan.md`、memory `2026-08-26.md` §62 / §63b。

## 1. 「立即同步」——只上傳，唔撈 DB

- 位置：`src/components/pos-app.tsx:3054` 嘅「立即同步」btn → `syncNow(queue)`（`pos-app.tsx:1835-1860`）。
- 行為：`syncNow` 只 `POST /api/pos/sync`，把**本機 queue 事件**（落單/改單/刪單/打印/付款）推上伺服器，標 `synced`。**完全無 GET、無撈 orders**。
- 結論：「立即同步」＝ **upload / push 專用**，唔會令舊訂單「落」返嚟。

## 2. 舊訂單「落」返嚟嘅真正來源 = backfill（從 DB 撈）

- 真正撈 orders 嘅係 `loadRuntimeState`（`pos-app.tsx:574-637`）→ `GET /api/pos/state?storeId=X`。
- `src/app/api/pos/state/route.ts:24-26` 直接 `supabase.from("pos_orders").select("*").eq("store_id", storeId)` —— **直接讀 DB `pos_orders` 表，store 隔離**。
- 觸發時機：
  - App mount
  - realtime `(re)subscribe` 成功（`onResubscribed`，`pos-app.tsx:691-695`；斷線重連 / visibilitychange 都會）
  - `backToTables`（返枱面）
- 所以：用家見到「舊訂單全部同步落嚟」，**確實係直接從 DB `pos_orders` 撈出嚟**，但係經 backfill（多數發生喺剛 reconnect / 返枱面嗰刻），唔係「立即同步」粒掣本身。
- 模式差異：Supabase 模式 = 真 DB；mock 模式（無 supabase）`/api/pos/state` 返 `orders:[]`，唔會撈到嘢。

## 3. 「刪除全部訂單」——設計上連 DB 一齊刪（一次性）

- 位置：`src/components/local-orders-panel.tsx:155` `handleDeleteAllOrders`。
- 步驟：
  1. `DELETE /api/pos/orders?storeId=X` → 伺服器 `pos_orders DELETE WHERE store_id=X AND online_order_id IS NULL`（`src/app/api/pos/orders/route.ts:65-69`）。
  2. `saveOrders([])` 清本機 localStorage。
  3. `saveQueue(loadQueue().filter(e => !(e.type && e.type.startsWith("ORDER_"))))` —— 清走 ORDER_* 事件免重推落 DB。
  4. `window.dispatchEvent(new CustomEvent("pos-orders-changed"))` 廣播畀收銀 / 其他面板。
- **結論：有跟 DB 連動，一次性刪 DB 行 + 本機。**

## 4. 實際範圍（重要）

- 只刪 **`online_order_id IS NULL`** 嘅單＝**店內線下訂單**。
- **Ledger 線上單（`online_order_id` 唔空）按設計保留**，唔會刪 —— 避免同會員餘額 / 線上單脫鉤。
- 粒掣文案「刪除全部訂單」實際語意＝「刪除全部線下訂單」（toast 亦寫「已刪除全部線下訂單」）。
- 其他終端唔會自動清（confirm dialog 已講明），佢哋下次 backfill 仍見到該批單（直到佢哋自己刪）。

## 5. 已知復活風險（今次唔修，記低等跟進）

1. **Ledger 線上單被 exclude** → 下次 backfill 照樣撈返嚟，易誤會「刪咗又返」。
2. **mock 模式（無 Supabase env）**：`DELETE` handler 當成功（`route.ts:58-61` 返 `{deleted:0}`）但 DB 實際冇嘢刪 → 本機清咗、DB 仲有 → 下次 backfill 復活。
3. **delete-all 冇寫 tombstone**：單筆刪除 `deleteOrderPermanently` 有 `deletedOrderIds` tombstone 擋 backfill 復活；「全部刪」靠 DB DELETE 完整。若 DB 刪除失敗/無效，無 tombstone 擋復活。

## 6. 後續動作（已做 · 2026-08-26）

- A. 刪除硬化（已做，`local-orders-panel.tsx` `handleDeleteAllOrders`）：
  - 刪 DB 前將本機線下單 id 記 `deletedOrderIds` tombstone（`addDeletedOrderIds`，只記 `onlineOrderId` 為空嘅線下單；Ledger 線上單唔記，DB 冇刪、照常顯示）。
  - toast 回報 DB 實際刪除筆數 `data.deleted`：>0 顯「已刪除 N 筆線下訂單（本地 + DB）」；0 顯 warning「DB 未刪除任何單（可能離線 / mock 模式）」。
  - 效果：DB DELETE 失效（RLS/mock 返 `{deleted:0}`）時 tombstone 擋本機 backfill 復活；0 筆即時提示。
- B. 「立即同步」btn **已移除**（`pos-app.tsx:3049`）：只留 offline banner（文案「恢復網絡後會自動補傳資料」）。安全依據——`pos-app.tsx:794-803` 有 30s 自動批量 `syncNow(pendingQueue)`，離線累積事件 reconnect 後 30s 內自動推 DB，移除 btn 無 regression。
- 擴範圍（一併刪 Ledger 線上單）仍未做，按設計保留（用家無異議，系統非我哋負責）。
- `tsc --noEmit` 零新 error；web-only，Vercel push 即生效。
