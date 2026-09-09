"use client";

import {
  beginAcceptInFlight,
  clearAcceptIdempotencyKey,
  endAcceptInFlight,
  getAcceptIdempotencyKey,
} from "@/lib/ledger/accept-idempotency";
import { ensureLedgerSession } from "@/lib/ledger/session";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";

export type AcceptMethod = "deduct" | "in_store" | "status";

export type AcceptOrderResult =
  | { ok: true; method: AcceptMethod }
  | { ok: false; code: "insufficient_balance"; message: string }
  | { ok: false; code: "in_flight"; message: string }
  | { ok: false; code: "error"; message: string };

export function mapRpcErrorMessage(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("insufficient balance")) return "會員餘額不足，可改為到店付款接單。";
  if (lower.includes("balance order requires deduct on accept")) return "餘額單須使用扣點接單。";
  if (lower.includes("invalid transition")) return "目前狀態不可執行此操作。";
  if (lower.includes("order already closed")) return "訂單已結束，無法再修改。";
  if (lower.includes("delivery dispatch active")) return "派送進行中，請先在 Ledger Web 處理。";
  // merchant_resolve_order_change 常見錯誤（顯示友善文案，勿直接丟英文）
  if (lower.includes("no pending change request"))
    return "沒有待確認的申請（可能已被另一台核准，或客人已撤回）。";
  if (lower.includes("not authorized")) return "無權限處理此申請。";
  if (lower.includes("order not found")) return "找不到訂單。";
  if (lower.includes("invalid action")) return "操作無效（只能同意或拒絕）。";
  return message;
}

function isInsufficientBalanceError(message: string): boolean {
  return message.toLowerCase().includes("insufficient balance");
}

async function callRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const accessToken = await ensureLedgerSession();
  if (!accessToken) throw new Error("Ledger 登入已過期，請重新登入。");

  const client = getLedgerSupabaseClient();
  if (!client) throw new Error("Ledger Supabase 尚未設定。");

  const { data, error } = await client.rpc(fn, args);
  if (error) {
    throw new Error(mapRpcErrorMessage(error.message));
  }
  return data as T;
}

export async function acceptOrderWithDeduct(orderId: string, idempotencyKey: string) {
  return callRpc("accept_order_with_deduct", {
    p_order_id: orderId,
    p_idempotency_key: idempotencyKey,
  });
}

export async function acceptOrderInStore(orderId: string) {
  return callRpc("accept_order_in_store", { p_order_id: orderId });
}

export async function updateOrderStatus(orderId: string, newStatus: string) {
  return callRpc("update_order_status", {
    p_order_id: orderId,
    p_new_status: newStatus,
  });
}

export async function setOrderPaidInStore(orderId: string) {
  return callRpc("set_order_paid_in_store", { p_order_id: orderId });
}

/**
 * 到店付款單「完成」前先收錢：當 `payment_mode='in_store'` 且仍未付款時，
 * 先打 `set_order_paid_in_store`（此時訂單仍處 ready/delivering，只受「須 in_store」守衛），
 * 再推進 completed。避開「已完成但未付、唔入帳」嘅收益漏單。
 *
 * - 已係 `paid` / 非 `in_store` → 直接 return false，唔做多餘 RPC（順便做咗冪等）。
 * - 返回 true = 今次有真係標記已收；UI 據此決定印「到店付款」收據
 *   （唔可以靠 `order.paymentStatus`，因為傳入嘅 order 係 call 之前嘅快照）。
 */
export async function markPaidIfInStoreUnpaid(
  orderId: string,
  paymentMode?: string,
  paymentStatus?: string,
): Promise<boolean> {
  if (String(paymentMode ?? "").toLowerCase() === "in_store" && paymentStatus !== "paid") {
    await setOrderPaidInStore(orderId);
    return true;
  }
  return false;
}

/**
 * 商家回應客人的取消／改單申請（Ledger RPC `merchant_resolve_order_change`）。
 *
 * - 傳 "approve"：取消申請 → 訂單變 cancelled（餘額單會沖正）；改單申請 → 套用新明細。
 * - 傳 "reject"：狀態不變，申請欄位清空，訂單恢復正常流程。
 *
 * ⚠️ 沒有 `update_change_request_status` 這支 RPC；也**不要**用
 * `update_order_status(..., 'cancelled')` 來「同意客人取消」（那是商戶自己取消，
 * 不會沖正）。店員 session（anon + JWT）即可，不要 service_role。
 *
 * 成功回傳 jsonb 大致為：`{ status, resolved: "approve"|"reject", print_kind: "cancel"|"modify"|null }`。
 * 誰先按誰生效，後按會拿到 `no pending change request`。
 */
export type ResolveOrderChangeResult = {
  status?: string;
  resolved?: string;
  print_kind?: string | null;
};

export async function resolveOrderChange(orderId: string, action: "approve" | "reject") {
  return callRpc<ResolveOrderChangeResult>("merchant_resolve_order_change", {
    p_order_id: orderId,
    p_action: action,
  });
}

export async function acceptLedgerOrder(order: {
  id: string;
  paymentMode?: string;
  paymentStatus: string;
}): Promise<AcceptOrderResult> {
  if (!beginAcceptInFlight(order.id)) {
    return { ok: false, code: "in_flight", message: "接單處理中，請稍候…" };
  }

  const mode = String(order.paymentMode ?? "").toLowerCase();
  const paid = order.paymentStatus === "paid";

  try {
    if (mode === "balance" && !paid) {
      const idempotencyKey = getAcceptIdempotencyKey(order.id);
      try {
        await acceptOrderWithDeduct(order.id, idempotencyKey);
        endAcceptInFlight(order.id);
        return { ok: true, method: "deduct" };
      } catch (err) {
        const message = err instanceof Error ? err.message : "接單失敗";
        if (isInsufficientBalanceError(message)) {
          endAcceptInFlight(order.id);
          return { ok: false, code: "insufficient_balance", message };
        }
        throw err;
      }
    }

    if (mode === "in_store" && !paid) {
      await updateOrderStatus(order.id, "accepted");
      endAcceptInFlight(order.id);
      return { ok: true, method: "status" };
    }

    if (mode === "balance" && paid) {
      await updateOrderStatus(order.id, "accepted");
      endAcceptInFlight(order.id);
      return { ok: true, method: "status" };
    }

    await updateOrderStatus(order.id, "accepted");
    endAcceptInFlight(order.id);
    return { ok: true, method: "status" };
  } catch (err) {
    endAcceptInFlight(order.id);
    const message = err instanceof Error ? err.message : "接單失敗";
    return { ok: false, code: "error", message };
  }
}

export async function acceptLedgerOrderInStore(order: { id: string }): Promise<AcceptOrderResult> {
  if (!beginAcceptInFlight(order.id)) {
    return { ok: false, code: "in_flight", message: "接單處理中，請稍候…" };
  }
  try {
    await acceptOrderInStore(order.id);
    endAcceptInFlight(order.id);
    return { ok: true, method: "in_store" };
  } catch (err) {
    endAcceptInFlight(order.id);
    const message = err instanceof Error ? err.message : "接單失敗";
    return { ok: false, code: "error", message };
  }
}
