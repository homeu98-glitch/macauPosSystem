"use client";

import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";
import { LedgerOrderRow, mapLedgerOrderRow, LedgerOnlineOrder } from "@/lib/ledger/order-mapper";

export type ListMerchantOrdersParams = {
  merchantId: string;
  status?: string | null;
  limit?: number;
  since?: string | null;
  sinceId?: string | null;
};

function parseRpcOrderRows(data: unknown): LedgerOrderRow[] {
  if (Array.isArray(data)) return data as LedgerOrderRow[];
  return [];
}

export async function listMerchantOrders(params: ListMerchantOrdersParams): Promise<LedgerOnlineOrder[]> {
  const client = getLedgerSupabaseClient();
  if (!client) {
    throw new Error("Ledger Supabase 尚未設定。");
  }

  const { data, error } = await client.rpc("list_merchant_orders", {
    p_merchant_id: params.merchantId,
    p_status: params.status ?? null,
    p_limit: params.limit ?? 50,
    p_since: params.since ?? null,
    p_since_id: params.sinceId ?? null,
  });

  if (error) {
    throw new Error(error.message);
  }

  return parseRpcOrderRows(data).map(mapLedgerOrderRow);
}

export async function getOrderDetail(orderId: string): Promise<{
  items: Array<{ name: string; qty: number }>;
}> {
  const client = getLedgerSupabaseClient();
  if (!client) {
    throw new Error("Ledger Supabase 尚未設定。");
  }

  const { data, error } = await client.rpc("get_order_detail", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message);
  }

  const payload = data as { items?: Array<{ product_name?: string; name?: string; qty?: number; quantity?: number }> } | null;
  const items = Array.isArray(payload?.items)
    ? payload!.items!.map((item) => ({
        name: String(item.product_name ?? item.name ?? "品項"),
        qty: Number(item.quantity ?? item.qty ?? 1),
      }))
    : [];

  return { items };
}
