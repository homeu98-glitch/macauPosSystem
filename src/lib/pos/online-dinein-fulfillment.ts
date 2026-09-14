"use client";

import { updateOrderStatus } from "@/lib/ledger/order-actions";
import { getOrderStatus } from "@/lib/ledger/orders";
import {
  DINEIN_FINAL_STATUS,
  DINEIN_LADDER,
  isInvalidTransition,
  isLedgerStatusComplete,
} from "@/lib/pos/online-dinein-ladder";
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
 * ## 🔴 2026-09-14：走完梯**唔等於**到咗 `completed`（要驗證）
 *
 * 「無效轉換一律跳過」唔分辨兩種情況：
 *   (a) 已經過咗呢級（＝成功路徑）；
 *   (b) **根本推唔到**（訂單已 `cancelled`／已退款 → 每一級都 invalid transition）。
 * 舊寫法兩種都回 `ok: true` ⇒ 收銀以為排位已同步，實際 Ledger 完全冇動，而本地
 * 已經排位、線上列表又已剔除該單 ⇒ **兩邊靜默不一致，冇人有辦法發現**。
 *
 * ⇒ 收尾加一步**確認**：梯頂（`completed`）**成功**就直接算數；梯頂被拒就讀一次
 * Ledger 真實狀態（`getOrderStatus()`）——只有明確讀到「已完成」才算成功，讀到其他
 * 狀態（例如 `cancelled`）就回 `ok: false` 俾呼叫端彈提示。讀唔到（RLS／網絡）＝
 * 無法確認 → 維持樂觀（當成功）但 `console.warn` 留痕，**唔會**製造假失敗。
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
 * @see `src/lib/pos/online-dinein-ladder.ts`（梯級順序／錯誤判定口徑，零依賴可測）
 * @see `docs/online-dinein-table-assign-plan-2026-09-12.md` §11
 */

/** 排位後回寫嘅結果（俾呼叫端決定要唔要彈 toast）。 */
export type OnlineDineInProgress = { ok: boolean; error?: string };

/** 無法確認 Ledger 真實狀態時留痕（唔算失敗，但唔可以靜默到冇人知）。 */
function reportUnconfirmed(ledgerOrderId: string, reason: string): void {
  console.warn(
    `[online-dinein] 排位後無法確認 Ledger 狀態（${ledgerOrderId} → ${DINEIN_FINAL_STATUS}）：${reason}`,
  );
}

/**
 * 讀一次 Ledger 真實狀態；**所有**失敗（登入／網絡／冇 status 欄）一律回 `null`
 * ＝「無法確認」，並留一條 log。
 */
async function readLedgerStatusQuietly(ledgerOrderId: string): Promise<string | null> {
  try {
    const status = await getOrderStatus(ledgerOrderId);
    if (status === null) {
      reportUnconfirmed(ledgerOrderId, "回應冇 status 欄，讀唔到當前狀態");
    }
    return status;
  } catch (err) {
    reportUnconfirmed(ledgerOrderId, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * 將 Ledger 狀態由 `accepted` 一路推到 `completed`，**並確認真係到咗**。
 *
 * @returns `ok: false` 只喺以下情況先會回：
 *   ① 非狀態原因嘅失敗（Ledger 登入過期、網絡）；
 *   ② 爬梯走完但明確讀到 Ledger **唔係** `completed`（例如訂單已被取消）。
 */
export async function syncOnlineDineInCompletion(
  order: Pick<PosOrder, "onlineOrderId" | "localOrderNo" | "tableId">,
): Promise<OnlineDineInProgress> {
  if (!isOnlineDineInOrder(order)) return { ok: true };
  const ledgerOrderId = order.onlineOrderId as string;

  let completedAccepted = false;
  for (const status of DINEIN_LADDER) {
    try {
      await updateOrderStatus(ledgerOrderId, status);
      if (status === DINEIN_FINAL_STATUS) completedAccepted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 已經過咗呢一級 → 繼續爬；其他錯誤即刻停手（唔好靜默）。
      if (isInvalidTransition(message)) continue;
      return { ok: false, error: message };
    }
  }

  // Ledger 親口接受咗 `completed` ⇒ 一定已完成，唔使再查（正常情況零額外請求）。
  if (completedAccepted) return { ok: true };

  // 梯頂被拒：可能「本來已經 completed」（冪等成功），亦可能真係推唔到（已取消…）。
  const current = await readLedgerStatusQuietly(ledgerOrderId);
  if (current === null) return { ok: true };
  if (isLedgerStatusComplete(current)) return { ok: true };
  return {
    ok: false,
    error: `線上訂單未能推進至「已完成」（Ledger 目前狀態：${current}）。`,
  };
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
