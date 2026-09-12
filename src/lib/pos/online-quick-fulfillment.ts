"use client";

import { updateOrderStatus } from "@/lib/ledger/order-actions";
import type { PosOrder } from "@/lib/types";

/**
 * 快餐模式：本地「可取餐 / 完成」→ **回寫 Ledger 狀態**（2026-09-12）。
 *
 * ## 為咩一定要做
 *
 * 快餐模式收到線上單之後會**採納成本地 counter 單**（`adoptLedgerOrderAsQuickCounter()`），
 * 之後收銀喺快餐 strip 撳「可取餐 → 完成」。但本地 `status` 同 Ledger 係**兩套狀態機**：
 * 唔回寫就會出現「本地已 settled、Ledger 仍 accepted / preparing」→
 * 線上訂單列表永遠停留喺「製作中」、客人端亦睇唔到進度、對賬對唔上。
 *
 * ## 為咩要「爬梯」
 *
 * Ledger 只接受逐級轉換（`pending → accepted → preparing → ready → completed`），
 * 唔可以 `accepted` 直接跳 `completed`（會報 invalid transition）。
 * 但 POS 手上**冇存住** Ledger 當前狀態，所以由頭逐級試：
 * 各級失敗如果係「狀態唔啱」（即已經過咗呢級）就繼續，其餘錯誤即刻上報。
 *
 * 呢個做法係**冪等**嘅：重複撳「完成」／已經 completed 嘅單，全部呼叫都只會
 * 回 invalid transition → 照樣 `ok: true`，唔會拋錯嚇人。
 *
 * ⚠️ 線上單取消／退款**唔行呢度**：嗰條路一定要走
 * `merchant_resolve_order_change`（Ledger RPC），唔可以用 `update_order_status`。
 *
 * @see `docs/online-dinein-table-assign-plan-2026-09-12.md` §10
 */

export type OnlineFulfillmentTarget = "ready" | "completed";

const LADDER = ["preparing", "ready", "completed"] as const;

/** Ledger 嘅「目前狀態唔可以做呢步」。 */
function isInvalidTransition(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("invalid transition") || message.includes("目前狀態不可執行");
}

/**
 * 將 Ledger 狀態推進到 `target`（或以上）。
 *
 * @returns `ok: false` 只喺**非狀態原因**嘅失敗（例如 Ledger 登入過期、網絡）先會回。
 */
export async function syncOnlineQuickFulfillment(
  order: Pick<PosOrder, "onlineOrderId" | "localOrderNo">,
  target: OnlineFulfillmentTarget,
): Promise<{ ok: boolean; error?: string }> {
  const ledgerOrderId = order.onlineOrderId;
  // 本地單（冇 onlineOrderId）唔關事：快餐本地單一向唔需要回寫任何嘢。
  if (!ledgerOrderId) return { ok: true };

  const lastIndex = LADDER.indexOf(target);
  for (let i = 0; i <= lastIndex; i += 1) {
    try {
      await updateOrderStatus(ledgerOrderId, LADDER[i]);
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
 * 背景回寫（fire-and-forget）：本地狀態已經寫好先，Ledger 慢／離線都唔應該卡住收銀。
 *
 * ⚠️ 但**唔可以靜默**：失敗至少 `console.error`，有 `onError` 就再彈 toast
 * （快餐出餐係「客人已經等緊」嘅場景，靜默失敗冇人知）。
 */
export function syncOnlineQuickFulfillmentInBackground(
  order: Pick<PosOrder, "onlineOrderId" | "localOrderNo">,
  target: OnlineFulfillmentTarget,
  onError?: (message: string) => void,
): void {
  if (!order.onlineOrderId) return;
  void syncOnlineQuickFulfillment(order, target).then((result) => {
    if (result.ok) return;
    const message = result.error ?? "未知錯誤";
    console.error(
      `[online-quick] 回寫會員通狀態失敗（${order.localOrderNo} → ${target}）：${message}`,
    );
    onError?.(message);
  });
}
