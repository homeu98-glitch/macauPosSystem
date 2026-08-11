"use client";

import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";

export function mapRpcErrorMessage(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("insufficient balance")) return "會員餘額不足，可改為到店付款接單。";
  if (lower.includes("balance order requires deduct on accept")) return "餘額單須使用扣點接單。";
  if (lower.includes("invalid transition")) return "目前狀態不可執行此操作。";
  if (lower.includes("order already closed")) return "訂單已結束，無法再修改。";
  if (lower.includes("delivery dispatch active")) return "派送進行中，請先在 Ledger Web 處理。";
  return message;
}

async function callRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
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

/** Pick the correct accept RPC based on payment mode. */
export async function acceptLedgerOrder(order: {
  id: string;
  paymentMode?: string;
  paymentStatus: string;
}): Promise<void> {
  const mode = String(order.paymentMode ?? "").toLowerCase();
  const paid = order.paymentStatus === "paid";

  if (mode === "balance" && !paid) {
    const idempotencyKey = crypto.randomUUID();
    await acceptOrderWithDeduct(order.id, idempotencyKey);
    return;
  }

  if (mode === "balance" && paid) {
    await updateOrderStatus(order.id, "accepted");
    return;
  }

  if (mode === "in_store") {
    await updateOrderStatus(order.id, "accepted");
    return;
  }

  // Fallback: try generic accept for already-paid or unknown modes
  await updateOrderStatus(order.id, "accepted");
}
