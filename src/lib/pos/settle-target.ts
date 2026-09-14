/**
 * 結帳目標解析 —— 純函式（零依賴，`node --test` 可直接載入）。
 *
 * ## 為咩要抽出嚟做純函式
 *
 * 2026-09-14 實案：收銀對 A03 加菜後撳「去結帳」，**結咗第二張枱嘅單**。
 * 根因係結帳入口最後一重 fallback `orders.find((order) => isSettleableOrder(order))`
 * —— 喺全店任意揀一張單。呢個口徑唔可以再靠「記得」守，要**用測試鎖死**。
 *
 * ## 四層（**永不跨枱**）
 *
 *   1. `explicitId`：結帳入口明確指定嘅單（桌台卡／訂單列／線上面板直接結帳）。
 *      佢**可以**屬另一張枱 —— 嗰啲入口本身就係「隔空結某張單」，屬正常流程。
 *   2. `activeOrder`：當前工作台嘅單（點餐頁「去結帳」）。
 *   3. `workspaceOrder`：`activeOrderId` 實際載入嘅單（唔受 `activeOrder` 嘅狀態白名單影響）。
 *   4. 只限 `activeTableId`（當前枱）嘅最新可結帳單 —— 同一枱可以有多張單。
 *
 * 全部唔中 → `null`：呼叫方要出提示。**寧願結唔到帳，都唔可以靜靜結錯枱。**
 *
 * @see docs/113-agent-gotchas.md「結帳目標唔可以喺『全店』揀」
 */

import { isSettleableOrder, type SettleableOrderInfo } from "./online-dinein-labels.ts";

/** 解析所需嘅最小欄位（`PosOrder` 直接滿足）。 */
export type SettleTargetCandidate = SettleableOrderInfo & {
  id: string;
  updatedAt?: string | null;
};

export type SettleTargetInput<T extends SettleTargetCandidate> = {
  /** 全店訂單（本機 `orders` state）。 */
  orders: T[];
  /** 入口明確指定嘅單 id；快餐購物車哨兵（`__cart__`）請傳 `null`。 */
  explicitId?: string | null;
  /** 當前工作台嘅單（可為 `null`）。 */
  activeOrder?: T | null;
  /** `activeOrderId` 對應嘅單（含已結帳單，用嚟救「狀態白名單」漏咗嘅情況）。 */
  workspaceOrder?: T | null;
  /** 當前枱 id。 */
  activeTableId?: string | null;
};

/** 時間戳解析（非法 / 缺失 → 0，當最舊）。 */
function parseTs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function resolveSettleTargetOrder<T extends SettleTargetCandidate>(
  input: SettleTargetInput<T>,
): T | null {
  const { orders, explicitId, activeOrder, workspaceOrder, activeTableId } = input;

  if (explicitId) {
    const byId = orders.find((order) => order.id === explicitId);
    if (byId) return byId;
  }

  if (activeOrder && isSettleableOrder(activeOrder)) return activeOrder;
  if (workspaceOrder && isSettleableOrder(workspaceOrder)) return workspaceOrder;

  if (!activeTableId) return null;
  const sameTable = orders
    .filter((order) => order.tableId === activeTableId && isSettleableOrder(order))
    .sort((a, b) => parseTs(b.updatedAt) - parseTs(a.updatedAt));
  return sameTable[0] ?? null;
}
