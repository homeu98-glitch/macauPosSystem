"use client";

import { updateOrderStatus } from "@/lib/ledger/order-actions";
import { isOnlineDineInOrder } from "@/lib/pos/online-dinein-labels";
import type { PosOrder } from "@/lib/types";

/**
 * 線上**堂食**單：排位完成 → **一次過爬梯推 Ledger 到 `completed`**（2026-09-13 商家需求）。
 *
 * ## 商家口徑（原話）
 *
 * 「客人下單後，系統需先為其排位，**排位完成即代表訂單已開始製作**。所以當某張線上堂食單
 * 排位完成時，應自動一次性將該訂單依序推進至後續全部狀態：已接單、開始製作、製作完成、
 * 已出單，無需逐一手動更新。」
 *
 * 即：排位呢個動作**取代**咗收銀逐個撳「接單 / 開始製作 / 製作中 / 完成」嘅步驟
 * （所以同步要拎走嗰批多餘按鈕，見要點 4）。
 *
 * ## 為咩由 `accepted` 起、仲要逐級爬
 *
 * Ledger 只接受逐級轉換（`pending → accepted → preparing → ready → completed`），
 * 跳級會報 `invalid transition`。而 POS 手上**冇存住** Ledger 當前狀態——可能係
 * `pending`（未接單，例如商家設定咗排位前要先接單，但實際未撳），亦可能已經係
 * `preparing`（有人手動推過）。所以照舊用「爬梯」：由 `accepted` 逐級試，
 * 各級失敗如果係「目前狀態唔啱」（＝已經過咗呢級）就繼續，其餘錯誤即刻停手。
 *
 * 呢個做法係**冪等**嘅：重複排位、已經 `completed` 嘅單，全部呼叫都只會回
 * invalid transition → 照樣 `ok: true`，唔會拋錯嚇人。
 *
 * ## 隔離範圍（🔴 唔可以影響其他訂單類型）
 *
 * 只有**線上堂食單**先會行到：帶 `onlineOrderId`（Ledger 落嘅單）＋ 有真枱號
 * （`tableId !== "counter"`）。快餐 counter 採納單（`adoptLedgerOrderAsQuickCounter`）
 * 唔會行呢條路——嗰條走 `syncOnlineQuickFulfillment()`（由 `preparing` 起，保留
 * 收銀自己撳「可取餐 / 完成」嘅節奏）。本地堂食單冇 `onlineOrderId` → 直接返 `ok: true`。
 *
 * ⚠️ 線上單取消／退款**唔行呢度**：嗰條路一定要走 `merchant_resolve_order_change`（Ledger RPC），
 * 唔可以用 `update_order_status`。
 *
 * @see `docs/online-dinein-table-assign-plan-2026-09-12.md` §11
 */

/** 排位後要一次過推到頂嘅整條梯。 */
const DINEIN_LADDER = ["accepted", "preparing", "ready", "completed"] as const;

/** Ledger 嘅「目前狀態唔可以做呢步」。 */
function isInvalidTransition(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("invalid transition") ||
    lower.includes("already") ||
    message.includes("目前狀態不可執行")
  );
}

/** 排位後回寫嘅結果（俾呼叫端決定要唔要彈 toast）。 */
export type OnlineDineInProgress = { ok: boolean; error?: string };

/**
 * 將 Ledger 狀態由 `accepted` 一路推到 `completed`。
 *
 * @returns `ok: false` 只喺**非狀態原因**嘅失敗（例如 Ledger 登入過期、網絡）先會回。
 */
export async function syncOnlineDineInCompletion(
  order: Pick<PosOrder, "onlineOrderId" | "localOrderNo" | "tableId">,
): Promise<OnlineDineInProgress> {
  if (!isOnlineDineInOrder(order)) return { ok: true };
  const ledgerOrderId = order.onlineOrderId as string;

  for (const status of DINEIN_LADDER) {
    try {
      await updateOrderStatus(ledgerOrderId, status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 已經過咗呢一級 → 繼續爬；其他錯誤即刻停手（唔好靜默）。
      if (isInvalidTransition(message)) continue;
      return { ok: false, error: message };
    }
  }
  return { ok: true };
}

/**
 * 背景回寫（fire-and-forget）：本地排位已經寫好先，Ledger 慢／離線都唔應該卡住收銀。
 *
 * ⚠️ 但**唔可以靜默**：失敗至少 `console.error`，有 `onError` 就再彈 toast。
 */
export function syncOnlineDineInCompletionInBackground(
  order: Pick<PosOrder, "onlineOrderId" | "localOrderNo" | "tableId">,
  onError?: (message: string) => void,
): void {
  if (!isOnlineDineInOrder(order)) return;
  void syncOnlineDineInCompletion(order).then((result) => {
    if (result.ok) return;
    const message = result.error ?? "未知錯誤";
    console.error(
      `[online-dinein] 排位後回寫會員通狀態失敗（${order.localOrderNo} → completed）：${message}`,
    );
    onError?.(message);
  });
}
