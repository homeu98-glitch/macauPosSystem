"use client";

import { defaultPosLocalSettings } from "@/lib/mock-data";
import { OrderItem, PosOrder, PrintJob, PrinterGroup, QueueEvent } from "@/lib/types";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

// ─────────────────────────────────────────────────────────────
// Kiosk 設備綁店（存部機 localStorage，唔使客人 login）
// ─────────────────────────────────────────────────────────────
export const KIOSK_BINDING_KEY = "macau-pos-kiosk-device";
export const DEFAULT_KIOSK_STORE_ID = "macau-store-a";

export type KioskLanguage = "zh-HK";

export type KioskDeviceBinding = {
  storeId: string;
  storeName?: string;
  language: KioskLanguage;
  boundAt?: string;
};

export function loadKioskDeviceBinding(): KioskDeviceBinding | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KIOSK_BINDING_KEY);
    return raw ? (JSON.parse(raw) as KioskDeviceBinding) : null;
  } catch {
    return null;
  }
}

export function saveKioskDeviceBinding(binding: KioskDeviceBinding): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KIOSK_BINDING_KEY, JSON.stringify(binding));
}

export function clearKioskDeviceBinding(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KIOSK_BINDING_KEY);
}

// ─────────────────────────────────────────────────────────────
// 購物車項目
// ─────────────────────────────────────────────────────────────
export type KioskCartItem = {
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
  printerGroup: PrinterGroup;
  selectedSpecs?: OrderItem["selectedSpecs"];
  note?: string;
};

export type KioskOrderMode = "dine_in" | "quick";
export type KioskQuickType = "pickup" | "delivery";

export type BuildKioskOrderInput = {
  storeId: string;
  tableId: string | null;
  tableName: string;
  mode: KioskOrderMode;
  quickType?: KioskQuickType;
  kitchenMode: "auto" | "dine_in_confirm";
  items: KioskCartItem[];
  taxRate: number;
  serviceRate: number;
  orderNote?: string;
  /** resume 重用現有單：保留同一 id + 狀態（點 9） */
  id?: string;
  status?: PosOrder["status"];
  fulfillmentStatus?: PosOrder["fulfillmentStatus"];
  /** 落單號碼：優先用店內線下同日序號（/api/pos/sequence 嘅 display）；無值就 fallback 去 timestamp 後綴 */
  localOrderNo?: string;
};

/** 建構 Kiosk 落單嘅 `PosOrder`（唔落本地 localStorage，推去 Supabase）。 */
export function buildKioskOrder(input: BuildKioskOrderInput): PosOrder {
  const timestamp = new Date().toISOString();
  const slice = new Date().getTime().toString().slice(-4);
  const subtotal = input.items.reduce((sum, it) => sum + it.price * it.quantity, 0);
  const taxAmount = subtotal * input.taxRate;
  const serviceChargeAmount = subtotal * input.serviceRate;
  const total = subtotal + taxAmount + serviceChargeAmount;

  const orderItems: OrderItem[] = input.items.map((it) => ({
    menuItemId: it.menuItemId,
    name: it.name,
    quantity: it.quantity,
    price: it.price,
    printerGroup: it.printerGroup,
    selectedSpecs: it.selectedSpecs,
    note: it.note,
  }));

  let localOrderNo: string;
  let tableId: string;
  let tableName: string;
  let status: PosOrder["status"];
  let fulfillmentStatus: PosOrder["fulfillmentStatus"];

  if (input.mode === "dine_in") {
    tableId = input.tableId ?? "counter";
    tableName = input.tableName;
    if (input.kitchenMode === "dine_in_confirm") {
      // 待確認：落 draft，等收銀確認才 sent_to_kitchen
      status = "draft";
      fulfillmentStatus = undefined;
    } else {
      status = "sent_to_kitchen";
      fulfillmentStatus = "preparing";
    }
  } else {
    tableId = "counter";
    if (input.quickType === "delivery") {
      tableName = "外賣";
    } else {
      tableName = "自取";
    }
    status = "sent_to_kitchen";
    fulfillmentStatus = "preparing";
  }

  // 落單號碼：優先用店內線下同日序號（/api/pos/sequence 嘅 display），kiosk/掃碼同店內共用同一日序列表；
  // 無序號（fetch 失敗 / 離線）先 fallback 去 timestamp 後綴，確保一定有號。
  if (input.localOrderNo) {
    localOrderNo = input.localOrderNo;
  } else if (input.mode === "dine_in") {
    localOrderNo = `堂食${slice}`;
  } else if (input.quickType === "delivery") {
    localOrderNo = `外賣${slice}`;
  } else {
    localOrderNo = `自取${slice}`;
  }

  // resume：重用現有單嘅狀態（唔可以因為改 mode 而把「待確認」變「已落廚房」）
  if (input.status) {
    status = input.status;
    fulfillmentStatus = input.fulfillmentStatus;
  }

  return {
    id: input.id ?? uid("kiosk"),
    localOrderNo,
    tableId,
    tableName,
    status,
    fulfillmentStatus,
    items: orderItems,
    orderNote: input.orderNote,
    subtotal,
    taxAmount,
    serviceChargeAmount,
    discountAmount: 0,
    total,
    prepaidAmount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** 按 printerGroup 分區建廚房 / 水吧出單（print agent 會按 printerGroup 搵真機）。 */
export function buildKioskKitchenPrintJobs(order: PosOrder, zoneNames: Record<string, string>): PrintJob[] {
  const timestamp = order.createdAt;
  const groups = Array.from(new Set(order.items.map((it) => it.printerGroup)));
  return groups.map<PrintJob>((group) => ({
    id: uid("print"),
    orderId: order.id,
    orderNo: order.localOrderNo,
    tableName: order.tableName,
    ticketType: "normal",
    printerGroup: group,
    printerName: zoneNames[group] ?? group,
    items: order.items
      .filter((it) => it.printerGroup === group)
      .map((it) => ({
        name: it.name,
        quantity: it.quantity,
        specs: (it.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
        note: it.note,
      })),
    status: "pending",
    createdAt: timestamp,
  }));
}

export function defaultZoneNames(): Record<string, string> {
  return Object.fromEntries(defaultPosLocalSettings.printZones.map((zone) => [zone.id, zone.name]));
}

/** 推 Kiosk 落單去 Supabase（經 `/api/pos/sync`，server 用 service role 寫入）。禁寫本地 localStorage。
 *  `eventType` 預設 ORDER_CREATED；resume 重用現有單時傳 ORDER_UPDATED（同一 order.id upsert）。 */
export async function submitKioskOrder(
  storeId: string,
  order: PosOrder,
  printJobs: PrintJob[],
  eventType: "ORDER_CREATED" | "ORDER_UPDATED" = "ORDER_CREATED",
): Promise<void> {
  const now = new Date().toISOString();
  const events: QueueEvent[] = [
    {
      id: uid("evt"),
      type: eventType,
      entityId: order.id,
      payload: order,
      status: "synced",
      createdAt: now,
    },
    ...printJobs.map<QueueEvent>((job) => ({
      id: uid("evt"),
      type: "PRINT_JOB_CREATED",
      entityId: job.id,
      payload: job,
      status: "synced",
      createdAt: now,
    })),
  ];

  const res = await fetch("/api/pos/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storeId, events }),
  });
  let body: { ok?: boolean; error?: string } | null = null;
  try {
    body = (await res.json()) as { ok?: boolean; error?: string };
  } catch {
    // 回應非 JSON（例如 503 HTML），下面靠 status 判斷
  }
  if (!res.ok || body?.ok === false) {
    const msg = body?.error ?? `落單失敗（${res.status}）`;
    throw new Error(msg);
  }
}

// ─────────────────────────────────────────────────────────────
// 重複掃碼 resume：查該枱 / 上次單有冇未結單，有就 resume（點 9）
// ─────────────────────────────────────────────────────────────
const TERMINAL_STATUSES = new Set<PosOrder["status"]>([
  "settled",
  "cancelled",
  "refunded",
  "partially_refunded",
  // 已付款但未「已完成」嘅 counter 單（快餐先收款後出餐）：對客人嚟講已結帳，
  // 唔應該再畀佢哋掃碼 resume 加單。
  "paid",
]);

export async function fetchUnsettledKioskOrder(
  storeId: string,
  tableId: string | null,
  lastOrderId?: string,
): Promise<PosOrder | null> {
  try {
    const res = await fetch(`/api/pos/state?storeId=${encodeURIComponent(storeId)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { orders?: PosOrder[] };
    const orders = Array.isArray(data.orders) ? data.orders : [];
    // /api/pos/state 已經按 updated_at desc 排序。下面一律以「該枱最新一張單」判斷，
    // 避免舊嘅 open 單（例如收銀結帳後 30s 批量 sync 未到位嘅 sent_to_kitchen）遮住咗
    // 新嘅 settled 單，令客人掃碼 resume 仲見到「已落單」。
    if (tableId) {
      const latest = orders.find((o) => o.tableId === tableId);
      if (!latest) return null;
      // 最新一張已結帳／已取消／已退款 → 枱已完結，唔畀客人再加單
      if (TERMINAL_STATUSES.has(latest.status)) return null;
      return latest; // 最新一張仍係 open → resume 呢張單
    }
    if (lastOrderId) {
      const open = orders.filter((o) => !TERMINAL_STATUSES.has(o.status));
      return open.find((o) => o.id === lastOrderId) ?? null;
    }
    return null;
  } catch {
    return null;
  }
}
