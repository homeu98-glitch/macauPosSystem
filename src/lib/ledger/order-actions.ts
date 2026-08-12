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
