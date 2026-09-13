"use client";

import { loadAuthSession } from "@/lib/storage";
import { ensureLedgerSession } from "@/lib/ledger/session";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";
import { LedgerOrderRow, mapLedgerOrderRow, LedgerOnlineOrder } from "@/lib/ledger/order-mapper";
import { parseOrderItemSpecs, type ParsedOrderSpec } from "@/lib/ledger/order-item-specs";

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

/**
 * admin panel 讀取 Ledger 線上單（service-role 通道，唔使商戶 JWT）。
 *
 * 對應 server route `GET /api/admin/ledger/orders`：用 admin session token 把關、
 * 後端以 Ledger service-role 直接查 `public.orders`，跨店（merchantId 留空）或
 * 指定商家（merchantId = Ledger merchant_id == POS store_id）都得。
 *
 * 呢個函式取代 admin 模式下原本會被 skip 嘅 `listMerchantOrders`，令管理後台
 * 真係睇到線上單（root cause 修復 2026-09-07）。
 */
export async function fetchAdminLedgerOrders(params: {
  merchantId: string | null;
  start: string | null;
  end: string | null;
}): Promise<LedgerOnlineOrder[]> {
  const token = loadAuthSession()?.adminSessionToken;
  const qs = new URLSearchParams();
  if (params.merchantId) qs.set("merchantId", params.merchantId);
  if (params.start) qs.set("start", params.start);
  if (params.end) qs.set("end", params.end);

  const res = await fetch(`/api/admin/ledger/orders?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${token ?? ""}` },
  });
  const json = (await res.json()) as {
    ok?: boolean;
    orders?: LedgerOnlineOrder[];
    error?: string;
    code?: string;
  };
  if (!res.ok || !json.ok) {
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  return json.orders ?? [];
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
  /**
   * 已選規格（揀咗咩規格／加購）。
   *
   * 🔴 2026-09-13 修：舊寫法**完全冇解析規格欄位**，令所有線上單嘅廚房單／
   * 飲品標籤單／收據一條規格都冇（Ledger 自己印嘅單有）。
   * 解析交 `parseOrderItemSpecs()`（防禦式多欄名，Ledger 欄名未確認）。
   */
  specs?: ParsedOrderSpec[];
};

/**
 * 品項備註嘅候選欄名 —— Ledger 欄名未確認，逐個試。
 *
 * 備註鏈路本身係通嘅（`item.note` → `OrderItem.note` → `toPrintItemLine().note`
 * → 廚房單／收據；`pos-app.tsx` 本地落單亦係寫 `note`），
 * **唯一風險**就係 Ledger 用咗另一個欄名 → 呢度兜住。
 */
const ITEM_NOTE_KEYS = [
  "note",
  "item_note",
  "itemNote",
  "remark",
  "remarks",
  "comment",
  "comments",
  "memo",
  "special_request",
  "specialRequest",
  "request",
] as const;

function pickItemNote(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const rec = record as Record<string, unknown>;
  for (const key of ITEM_NOTE_KEYS) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** 認得嘅 `get_order_detail` item 欄位（其餘欄位喺 dev 會 log 一次，方便對返 Ledger 真欄名）。 */
const KNOWN_ITEM_KEYS = new Set<string>([
  "product_name",
  "name",
  "qty",
  "quantity",
  "unit_price_avos",
  "price_avos",
  "menu_item_id",
  "discount_avos",
  "discount_rate",
  "line_discount_avos",
  ...ITEM_NOTE_KEYS,
]);

let didReportUnknownItemKeys = false;

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
      /**
       * 規格／選項欄位**唔喺度逐個列名**（Ledger 欄名未確認）：
       * 由 `parseOrderItemSpecs()` 逐個候選欄名試，命中就用。
       */
      [key: string]: unknown;
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
        // 🔴 唔可以直接讀 `item.note`：Ledger 可能用 `remark` / `comment` 等別名。
        note: pickItemNote(item),
        discountAvos: mapDiscountAvos(item.discount_avos ?? item.line_discount_avos),
        discountRate: typeof item.discount_rate === "number" ? item.discount_rate : undefined,
        specs: parseOrderItemSpecs(item),
      }))
    : [];

  reportUnknownItemKeysOnce(payload?.items);

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

/**
 * dev-only：第一次見到「未識別欄位」就 log 一次。
 *
 * Ledger `get_order_detail` 嘅規格欄名從未被確認（本機冇 Ledger 源碼），
 * 所以 `parseOrderItemSpecs()` 只可以逐個候選欄名盲試。呢個 log 令萬一盲試
 * 唔中都可以由 DevTools Console 一眼睇到真欄名，唔使再猜。
 * 每個 session 只報一次，唔會洗版。
 */
function reportUnknownItemKeysOnce(rawItems: unknown): void {
  if (didReportUnknownItemKeys || process.env.NODE_ENV === "production") return;
  if (!Array.isArray(rawItems) || rawItems.length === 0) return;
  const sample = rawItems[0];
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) return;

  const unknownKeys = Object.keys(sample as Record<string, unknown>).filter(
    (key) => !KNOWN_ITEM_KEYS.has(key),
  );
  if (unknownKeys.length === 0) return;

  didReportUnknownItemKeys = true;
  console.info(
    "[ledger→pos] get_order_detail item 有未識別欄位（可能就係規格／選項）：" +
      `${unknownKeys.join(", ")}。若廚房單仍然冇規格，請回報呢行。`,
  );
}
