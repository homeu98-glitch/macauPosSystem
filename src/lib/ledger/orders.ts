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
 * 品項備註嘅候選欄名 —— 逐個試。
 *
 * 🔴 **2026-09-13 已用真實 RPC 回應確認**：Ledger 用 **`line_note`**（唔係 `note`）。
 * 舊寫法只讀 `item.note` → 品項備註**永遠係 undefined** → 廚房單／收據永遠冇單品備註。
 *
 * 備註鏈路本身係通嘅（`item.note` → `OrderItem.note` → `toPrintItemLine().note`
 * → 廚房單／收據），缺口只喺呢一格。其餘別名保留做防禦。
 */
const ITEM_NOTE_KEYS = [
  "line_note",
  "lineNote",
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

/**
 * 認得嘅 `get_order_detail` item 欄位（含 2026-09-13 實機確認嘅真欄名）。
 * 其餘欄位會喺 console log 出嚟（見 `reportDetailShapeOnce`），方便對返 Ledger 改版。
 */
const KNOWN_ITEM_KEYS = new Set<string>([
  "id",
  "product_id",
  "productId",
  "name",
  "product_name",
  "qty",
  "quantity",
  "unit_price_avos",
  "price_avos",
  "discounted_unit_price_avos",
  "menu_item_id",
  "discount_avos",
  "discount_rate",
  "line_discount_avos",
  "selected_specs",
  "promo_applied_qty",
  "promo_rate_permille",
  ...ITEM_NOTE_KEYS,
]);

/** `get_order_detail` 原始欄位形狀（🔍 臨時診斷用；確認 Ledger 真欄名後可以刪）。 */
export type LedgerOrderDetailShape = {
  at: string;
  orderKeys: string[];
  itemKeys: string[];
  unknownItemKeys: string[];
  sampleItem: Record<string, unknown> | null;
};

let lastOrderDetailShape: LedgerOrderDetailShape | null = null;

/** 拎最後一次 `get_order_detail` 嘅原始欄位形狀（同一 session 快取；畀除錯面板用）。 */
export function getLastOrderDetailShape(): LedgerOrderDetailShape | null {
  return lastOrderDetailShape;
}

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
      /** 🔴 真實欄位（2026-09-13 實機確認）：`id` / `product_id` / `name` / `qty` /
       *  `line_note` / `selected_specs` / `unit_price_avos` / `promo_rate_permille` /
       *  `discounted_unit_price_avos`。以下逐個列出只係文件用途（有 index signature 兜底）。 */
      id?: string;
      product_id?: string;
      name?: string;
      product_name?: string;
      qty?: number;
      quantity?: number;
      unit_price_avos?: number;
      price_avos?: number;
      discounted_unit_price_avos?: number;
      menu_item_id?: string;
      /** 品項備註（真實欄名）。 */
      line_note?: string | null;
      note?: string | null;
      /** 已選規格（真實欄名）：`[{ group_name, option_name, price_delta_avos }]`。 */
      selected_specs?: unknown;
      promo_applied_qty?: number | null;
      promo_rate_permille?: number | null;
      // 折扣欄位（defensive）
      discount_avos?: number;
      discount_rate?: number;
      line_discount_avos?: number;
      [key: string]: unknown;
    }>;
    total_avos?: number;
    note?: string | null;
    /** 折扣前小計（真實欄位）。 */
    subtotal_avos?: number;
    /** 菜品促銷折扣總額（真實欄位，avos）。 */
    item_promo_discount_avos?: number;
    /** 履約方式折扣總額（真實欄位，avos）。 */
    fulfillment_discount_avos?: number;
    // 訂單層折扣欄位（defensive）
    discount_avos?: number;
    coupon_avos?: number;
    promotion_avos?: number;
  } | null;

  const items = Array.isArray(payload?.items)
    ? payload!.items!.map((item) => ({
        name: String(item.name ?? item.product_name ?? "品項"),
        qty: Number(item.qty ?? item.quantity ?? 1),
        unitPrice:
          item.unit_price_avos != null
            ? Math.round(Number(item.unit_price_avos)) / 100
            : item.price_avos != null
              ? Math.round(Number(item.price_avos)) / 100
              : undefined,
        /**
         * 🔴 **2026-09-13 用真實 RPC 回應確認**：Ledger 明細嘅菜品 id 係 **`product_id`**，
         * **唔係** `menu_item_id`。舊寫法只讀 `menu_item_id` → 永遠 undefined →
         * `resolveMenuItem()` 只能靠菜名撞 → 撞唔中就退回預設分區 `"kitchen"`
         * （廚房單可能打去錯嘅機），而且 `enrichSpecsFromMenu()` 失去餐牌 fallback。
         */
        menuItemId: pickItemMenuId(item),
        // 🔴 唔可以直接讀 `item.note`：Ledger 用 `line_note`（見 `ITEM_NOTE_KEYS`）。
        note: pickItemNote(item),
        discountAvos: mapDiscountAvos(item.discount_avos ?? item.line_discount_avos),
        discountRate: typeof item.discount_rate === "number" ? item.discount_rate : undefined,
        specs: parseOrderItemSpecs(item),
      }))
    : [];

  reportDetailShapeOnce(payload);

  return {
    items,
    total: payload?.total_avos != null ? Math.round(Number(payload.total_avos)) / 100 : undefined,
    note: payload?.note ?? undefined,
    discountAvos: mapDiscountAvos(
      payload?.discount_avos ??
        payload?.coupon_avos ??
        payload?.promotion_avos ??
        // 真實欄名（2026-09-13 實機確認）：菜品促銷折扣 + 履約方式折扣。
        payload?.item_promo_discount_avos ??
        payload?.fulfillment_discount_avos,
    ),
    subtotalAvos: typeof payload?.subtotal_avos === "number" ? Number(payload.subtotal_avos) : undefined,
  };
}

/**
 * 抽菜品 id（Ledger 明細 → 本地餐牌 `ledger-<id>` 嘅橋）。
 *
 * 真實欄名係 **`product_id`**（2026-09-13 用實機回應確認）；
 * 其餘別名保留做防禦，避免 Ledger 改版。
 */
function pickItemMenuId(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const rec = item as Record<string, unknown>;
  for (const key of ["product_id", "productId", "menu_item_id", "menuItemId"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function mapDiscountAvos(value: number | null | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

/**
 * 🔍 臨時診斷：第一次拉到明細就 log 一次 Ledger 實際回傳嘅欄位。
 *
 * **為咩要 log**：Ledger `get_order_detail` 嘅**規格／選項欄位名從未確認**（本機冇 Ledger
 * 源碼、冇憑證）。`parseOrderItemSpecs()` 只可以逐個候選欄名盲試；盲試唔中就靠呢段 log
 * 睇真欄名，唔使再猜、亦唔使再改渲染層。
 *
 * ⚠️ 刻意**唔**用 `NODE_ENV` 閘住 —— 師傅係喺**已部署嘅 Vercel 生產版**上面試。
 * 每次 session 只報一次；只出 item（菜品）層資料，**唔出**客戶電話／地址等 PII。
 *
 * 確認完欄名之後，呢個 function 同 `getLastOrderDetailShape()` 可以整段刪走。
 */
function reportDetailShapeOnce(payload: unknown): void {
  if (lastOrderDetailShape) return;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const record = payload as Record<string, unknown>;
  const rawItems = Array.isArray(record.items) ? (record.items as unknown[]) : [];
  const sample = rawItems[0];
  const sampleItem =
    sample && typeof sample === "object" && !Array.isArray(sample)
      ? (sample as Record<string, unknown>)
      : null;

  const itemKeys = sampleItem ? Object.keys(sampleItem) : [];
  const shape: LedgerOrderDetailShape = {
    at: new Date().toISOString(),
    orderKeys: Object.keys(record),
    itemKeys,
    unknownItemKeys: itemKeys.filter((key) => !KNOWN_ITEM_KEYS.has(key)),
    sampleItem,
  };
  lastOrderDetailShape = shape;

  console.info(
    "[ledger→pos] get_order_detail 欄位｜單頭：" +
      `${shape.orderKeys.join(", ")}｜item：${itemKeys.join(", ") || "(冇 item)"}`,
  );
  if (shape.unknownItemKeys.length > 0) {
    console.info(
      `[ledger→pos] get_order_detail item 未識別欄位（規格／選項好可能就喺呢批）：` +
        `${shape.unknownItemKeys.join(", ")}`,
    );
  }
  if (sampleItem) {
    console.info("[ledger→pos] get_order_detail items[0] 原文（請展開／複製呢舊）:", sampleItem);
  }
}
