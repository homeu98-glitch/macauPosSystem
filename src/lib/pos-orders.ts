"use client";

import { applyPosAdd } from "@/lib/ledger/members";
import { getLedgerMerchantId } from "@/lib/ledger/session";
import { appendPrintJobs, buildReopenPrintJobs } from "@/lib/print-jobs";
import { loadOrders, saveOrders } from "@/lib/storage";
import { PosOrder } from "@/lib/types";

/**
 * 可返結：只可對「已結帳」（settled / paid）嘅單返結。
 *
 * 線上單分兩種：
 * - 純線上快餐 / 自取 / 外賣（onlineOrderId 存在，且未轉枱 = tableId 係 counter 或無枱）：
 *   由上游 Ledger 對賬，POS 端唔支援返結。
 * - 「線上堂食單轉到枱」（onlineOrderId 存在 + tableId 唔係 counter）：
 *   已變成喺店堂食單，當本地單處理，可以返結。
 * 美容同其他本地單無 onlineOrderId，一律當本地單。
 */
export function isReopenable(order: PosOrder): boolean {
  if (order.onlineOrderId) {
    const isInStoreDineIn = !!order.tableId && order.tableId !== "counter";
    if (!isInStoreDineIn) return false;
  }
  return order.status === "settled" || order.status === "paid";
}

export type ReopenResult = {
  ok: boolean;
  error?: string;
  /** 會員餘額是否成功反向加回（best-effort） */
  memberReversed?: boolean;
  /** add RPC 失敗原因（不阻擋返結，僅標記） */
  memberReverseError?: string;
};

/**
 * 餐飲返結（反結賬）：把已結單退回可編輯狀態。
 *
 * 1. 強制原因（reason 不可空白）。
 * 2. 狀態切到 `reopened` + 寫審計（reopenedAt / reopenedBy / reopenReason / reopenCount / originalSettledAt）。
 * 3. 反向回滾會員餘額（best-effort：若 Ledger add RPC 尚未佈署，只記警告並繼續切狀態）。
 * 4. 印「返結單」到各區域 / 標籤機。
 * 5. dispatch `pos-orders-changed` 通知訂單面板刷新。
 *
 * 重結由 POS 工作台（pos-app confirmPayment）針對同一 order.id 重新落單結帳完成。
 */
export async function reopenPosOrder(params: {
  orderId: string;
  reason: string;
  operator: string;
}): Promise<ReopenResult> {
  const reason = (params.reason ?? "").trim();
  if (!reason) {
    return { ok: false, error: "必須揀返結原因" };
  }

  const orders = loadOrders();
  const idx = orders.findIndex((o) => o.id === params.orderId);
  if (idx < 0) return { ok: false, error: "找不到訂單" };

  const order = orders[idx];
  if (!isReopenable(order)) {
    return { ok: false, error: "此單狀態不可返結（只可返結已結帳單）" };
  }

  // ① 反向回滾會員餘額（best-effort）
  let memberReversed = false;
  let memberReverseError: string | undefined;
  if (order.memberDeductionAvos && order.memberDeductionAvos > 0 && order.ledgerMemberPhone) {
    const merchantId = getLedgerMerchantId();
    if (merchantId) {
      try {
        await applyPosAdd({
          merchantId,
          phone: order.ledgerMemberPhone,
          amountAvos: order.memberDeductionAvos,
          idempotencyKey: `reopen-${order.id}-${(order.reopenCount ?? 0) + 1}-${Date.now()}`,
        });
        memberReversed = true;
      } catch (err) {
        memberReverseError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // ② 切狀態 + 寫審計
  const now = new Date().toISOString();
  const updated: PosOrder = {
    ...order,
    status: "reopened",
    reopenedAt: now,
    reopenedBy: params.operator,
    reopenReason: reason,
    reopenCount: (order.reopenCount ?? 0) + 1,
    originalSettledAt: order.originalSettledAt ?? order.updatedAt,
    updatedAt: now,
  };

  const next = [...orders];
  next[idx] = updated;
  saveOrders(next);

  // ③ 印返結單
  appendPrintJobs(buildReopenPrintJobs(updated, reason, params.operator));

  // ④ 通知面板刷新
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-orders-changed"));
  }

  return { ok: true, memberReversed, memberReverseError };
}
