/**
 * 線上單顧客资料嘅** session 記憶體快取**（2026-10-19 到店優惠改價）。
 *
 * ## 為咩要有
 *
 * Ledger 顧客電話（`customer_phone`）只喺 `list_merchant_orders` 嘅回應入面
 * （見 `orders-hub.tsx` 註釋），**從未落本地 `pos_orders`**（個資紅線：
 * Ledger 契約 §7.2 只准存 uuid）。所以收銀台（`/pos`）結帳嗰陣攞唔返
 * 客人電話 —— 但「差額充值返回原支付戶口」一定要電話先call到
 * `applyPosTopup()`。
 *
 * 權衡：寫得快取 ⇒  reopen／採納嗰刻（online-orders.tsx，一定有 phone）
 * 記低，同一個 SPA session 內（client-side 導航）結帳讀得到。
 * 硬 reload 後遺失 ⇒ 差額模態改為人手輸入電話（見該 component）。
 *
 * ⚠️ 純記憶體、零持久化、零 import（可以被 node --test 直接測）。
 * Key = Ledger order id（＝ `PosOrder.onlineOrderId`）。
 */

export type OnlineCustomerInfo = {
  name?: string;
  phone?: string;
};

const cache = new Map<string, OnlineCustomerInfo>();

/** 記低線上單顧客（覆寫語意；空值會清走）。 */
export function rememberOnlineCustomer(orderId: string, info: OnlineCustomerInfo): void {
  const key = orderId.trim();
  if (!key) return;
  const name = info.name?.trim() || undefined;
  const phone = info.phone?.trim() || undefined;
  if (!name && !phone) {
    cache.delete(key);
    return;
  }
  cache.set(key, { name, phone });
}

/** 讀返線上單顧客；未記錄過 → null。 */
export function getOnlineCustomer(orderId: string): OnlineCustomerInfo | null {
  const key = orderId.trim();
  if (!key) return null;
  return cache.get(key) ?? null;
}
