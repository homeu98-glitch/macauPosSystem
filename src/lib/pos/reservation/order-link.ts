"use client";

/**
 * 入座後把「真正生成嘅 POS 訂單」回寫到訂位記錄。
 *
 * ## 點解要事後補一次
 *
 * `seat` 那一刻張單仲未存在 —— 訂位頁只係標記 `seated` + 寫枱號，
 * 真正嘅 `PosOrder` 係店員喺收銀台按「送廚房」、
 * `upsertCurrentOrder()` 先至生成（見 `pending-seat.ts` 檔頭）。
 * 所以 `order_id` / `order_no` 一定要喺建單成功之後補寫。
 *
 * ## 點解 fire-and-forget
 *
 * 呢個係**顯示用嘅關聯**，唔係交易資料。店員已經喺收銀台落緊單，
 * 唔可以因為訂位記錄寫入失敗就卡住出廚房單，亦唔應該彈錯誤嚇人。
 * 失敗就保留喺 `pos-app` 嘅 ref，下一個 state 變化會再試一次；
 * 真係寫唔到，訂位詳情最多係冇訂單號，唔影響收銀。
 *
 * ⚠️ fetch **唔好加自訂 header**：`posRouteAuthGuard` 認嘅 POS 終端憑證
 * 係由 cookie 帶（同 `use-reservations.ts` 其他 fetch 一致），加咗反而多餘。
 */

export type LinkOrderArgs = {
  storeId: string;
  reservationId: string;
  orderId: string;
  orderNo?: string | null;
};

/** @returns 是否成功寫入（或本來已綁定同一張單）。 */
export async function linkReservationOrder(args: LinkOrderArgs): Promise<boolean> {
  if (!args.storeId || !args.reservationId || !args.orderId) return false;
  try {
    const res = await fetch(`/api/pos/reservations/${encodeURIComponent(args.reservationId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storeId: args.storeId,
        action: "link_order",
        orderId: args.orderId,
        orderNo: args.orderNo ?? undefined,
      }),
      cache: "no-store",
    });
    if (res.ok) return true;
    // 409「已綁定其他單」係正常終態，唔應該無限重試 —— 當成功清 ref。
    if (res.status === 409) return true;
    console.warn("[reservation/order-link] 回寫失敗", res.status);
    return false;
  } catch (error) {
    console.warn("[reservation/order-link] 網路錯誤", error);
    return false;
  }
}
