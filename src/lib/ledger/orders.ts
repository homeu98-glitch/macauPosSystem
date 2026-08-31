"use client";

import { ensureLedgerSession } from "@/lib/ledger/session";
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
  const accessToken = await ensureLedgerSession();
  if (!accessToken) {
    throw new Error("Ledger 登入已過期，請重新登入。");
  }

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

export type LedgerOrderDetailItem = {
  name: string;
  qty: number;
  unitPrice?: number;
  menuItemId?: string;
  note?: string;
  /** 單品折扣金額（avos），攞嚟對齊 per-item discountRate。defensive：RPC 唔一定有。 */
  discountAvos?: number;
  /** 單品折扣百分比（0-100），如果有就比金額優先。defensive。 */
  discountRate?: number;
};

export type LedgerOrderDetail = {
  items: LedgerOrderDetailItem[];
  total?: number;
  note?: string;
  /** 訂單層全單折扣（avos）。defensive：RPC 唔一定有（後端未必支援）。 */
  discountAvos?: number;
  /** 訂單層折扣前小計（avos）。defensive。 */
  subtotalAvos?: number;
};

export async function getOrderDetail(orderId: string): Promise<LedgerOrderDetail> {
  const accessToken = await ensureLedgerSession();
  if (!accessToken) {
    throw new Error("Ledger 登入已過期，請重新登入。");
  }

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

  const payload = data as {
    items?: Array<{
      product_name?: string;
      name?: string;
      qty?: number;
      quantity?: number;
      unit_price_avos?: number;
      price_avos?: number;
      menu_item_id?: string;
      note?: string;
      // 折扣欄位（defensive，後端未必有；見 mapDiscountAvos / 對應 type 註釋）
      discount_avos?: number;
      discount_rate?: number;
      line_discount_avos?: number;
    }>;
    total_avos?: number;
    note?: string;
    // 訂單層折扣欄位（defensive）
    discount_avos?: number;
    coupon_avos?: number;
    promotion_avos?: number;
    subtotal_avos?: number;
  } | null;

  const items = Array.isArray(payload?.items)
    ? payload!.items!.map((item) => ({
        name: String(item.product_name ?? item.name ?? "品項"),
        qty: Number(item.quantity ?? item.qty ?? 1),
        unitPrice:
          item.unit_price_avos != null
            ? Math.round(Number(item.unit_price_avos)) / 100
            : item.price_avos != null
              ? Math.round(Number(item.price_avos)) / 100
              : undefined,
        menuItemId: item.menu_item_id,
        note: item.note ?? undefined,
        discountAvos: mapDiscountAvos(item.discount_avos ?? item.line_discount_avos),
        discountRate: typeof item.discount_rate === "number" ? item.discount_rate : undefined,
      }))
    : [];

  return {
    items,
    total: payload?.total_avos != null ? Math.round(Number(payload.total_avos)) / 100 : undefined,
    note: payload?.note ?? undefined,
    discountAvos: mapDiscountAvos(payload?.discount_avos ?? payload?.coupon_avos ?? payload?.promotion_avos),
    subtotalAvos: typeof payload?.subtotal_avos === "number" ? Number(payload.subtotal_avos) : undefined,
  };
}

function mapDiscountAvos(value: number | null | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}
