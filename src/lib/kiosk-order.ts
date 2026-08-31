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
// Kiosk 模式（裝置模式開關）
// ─────────────────────────────────────────────────────────────
export const KIOSK_MODE_KEY = "macau-pos-kiosk-mode";
export const KIOSK_MODE_EVENT = "pos-kiosk-mode-changed";

/**
 * 呢部機係咪「自助點餐機」模式（docs/87 §1）。
 *
 * 開咗 → 開 `/` 會自動跳去 `/order`（客人自助點餐介面），唔做收銀。
 * 熄咗 → 正常收銀台。
 *
 * 三個重點：
 * 1. **純本機旗標**（localStorage，device-level 唔跟 store scope）——Android APK 同桌面 EXE
 *    都係用 persistent localStorage 嘅 WebView / 瀏覽器裝住同一個 Vercel 網址，
 *    所以加呢個模式**唔使 rebuild APK / EXE**（規格 1）。
 * 2. **唔同步上 server**：絕對唔好放 `pos_device_configs`——嗰個 GET 係
 *    `.order(updated_at desc).limit(1)` 冇 store filter，會讀到第啲機嘅設定
 *    （同 `onlineOrderSettings.autoAccept` 嗰個 bug 同一類）。
 * 3. 同「綁店」係兩回事：綁店（`KIOSK_BINDING_KEY`）決定**落單落去邊間店**，
 *    kiosk mode 決定**呢部機開機做乜**。
 */
export function loadKioskMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KIOSK_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveKioskMode(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KIOSK_MODE_KEY, enabled ? "1" : "0");
  } catch {
    // 寫唔到（私隱模式 / kiosk WebView 限制）就當冇開，起碼唔會令收銀台入唔到
    return;
  }
  window.dispatchEvent(new CustomEvent(KIOSK_MODE_EVENT, { detail: { enabled } }));
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
  /**
   * 「自動接自助單」開關（DB `pos_kiosk_settings.self_order_auto_accept`，Kiosk 落單時讀一次）。
   * - `true`：免確認，直接 `sent_to_kitchen`（規格 5 嘅預設）
   * - `false`：落 `draft`，排入「待確認」，等收銀台撳確認先用代客下單流程出單
   */
  autoAcceptSelfOrder: boolean;
  /** 訂單來源：自助點餐機 `"kiosk"` / 客人掃碼 `"scan"`（docs/87 §5.2） */
  source: "kiosk" | "scan";
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
    if (!input.autoAcceptSelfOrder) {
      // 待確認：落 draft，等收銀台撳「確認」先用代客下單流程出廚房（規格 5、6）
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
    if (!input.autoAcceptSelfOrder) {
      // 快餐都受同一粒開關管（規格 6：堂食與快餐共用同一個開關）
      status = "draft";
      fulfillmentStatus = undefined;
    } else {
      status = "sent_to_kitchen";
      fulfillmentStatus = "preparing";
    }
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
    source: input.source,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * @deprecated **Kiosk 唔再建廚房單**（docs/87 §3.1）。
 *
 * 廚房單一律改由**收銀端**建立（realtime 收到自助點餐新單 → `buildKitchenPrintJobs()`），
 * 好處：① 冇雙重打印（收銀端係唯一建立者）；② Kiosk 只需一部機印顧客小票；
 * ③ 掃碼單同 Kiosk 單行為完全一致。
 *
 * 保留原因：僅供日後需要「Kiosk 直出廚房單」嘅場景參考，**目前冇 caller**。
 * 另一個唔好直接復用嘅原因：呢個 builder 產生嘅 job **冇 `template` / `content` / `printerId`**，
 * 打印端會行硬編 fallback（冇店名／時間／單據類型／頁尾，亦唔理商家設嘅字型大小）。
 */
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

/**
 * 推 Kiosk 落單去 Supabase（經 `/api/pos/sync`，server 用 service role 寫入）。禁寫本地 localStorage。
 * `eventType` 預設 ORDER_CREATED；resume 重用現有單時傳 ORDER_UPDATED（同一 order.id upsert）。
 *
 * ⚠️ **只會推訂單事件，絕對唔推 `PRINT_JOB_CREATED`**（docs/87 §3.1）。
 * 原因：任何同步咗上 server 嘅 pending job，收銀端 `onPrintJobUpsert` 會 merge 落自己嘅
 * localStorage，然後嗰部機嘅 `PrintFlushWorker` 會照印 → Kiosk 已經印咗一張，收銀台再印多張。
 * Kiosk 嘅顧客小票屬於「本機打印」，由 `appendPrintJobs()` 寫本機就夠，唔好上雲。
 */
export async function submitKioskOrder(
  storeId: string,
  order: PosOrder,
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
// 重複掃碼 resume：查上次單有冇未結單，有就 resume（點 9）
// ─────────────────────────────────────────────────────────────
//
// ⚠️ root-cause（2026-08-31 · 用戶掃 A01 見「已落單」但枱面「空間 / 已坐 0/10」）：
// 舊邏輯以「該枱有任何 server-side open 單」＝「有人坐」，會被以下 stale state 誤擋：
//   - 返結（`reopened`）後 temp 枱未清 / sync 時差，server 仍有 stale reopened record
//   - 其他 terminal 嘅 draft / sent_to_kitchen 單 sync 落 server，枱 ID 撞咗
//   - 商戶嘅 paid counter 單（quick）殘留喺 /api/pos/state 配對到枱 ID
//
// 修正：resume 嘅單一真源改為「客人自己嘅單」—— 用 sessionStorage `kiosk-last-order`
// 配 server-side 對應 ID，且只認 `source === "scan"`（客人掃碼落嘅）。其他來源一律唔擋客人。
// 商戶 / kiosk 落嘅單唔會被當客人 resume 對象（佢哋有自己嘅 round-trip，不需 resume）。
const TERMINAL_STATUSES = new Set<PosOrder["status"]>([
  "settled",
  "cancelled",
  "refunded",
  "partially_refunded",
  // 已付款但未「已完成」嘅 counter 單（快餐先收款後出餐）：對客人嚟講已結帳，
  // 唔應該再畀佢哋掃碼 resume 加單。
  "paid",
]);

/** 客人 scan 自己落嘅單（手機 /menu 掃碼）。`pos` / `kiosk` 都唔算客人 resume 對象。 */
function isCustomerScanOrder(order: Pick<PosOrder, "source">): boolean {
  return order.source === "scan";
}

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

    // 主路徑：客人自己嘅 scan 單（sessionStorage 記住嘅 orderId）。
    // 呢個就係 resume 嘅單一真源——唔再靠 tableId 推斷「有冇人坐」。
    if (lastOrderId) {
      const candidate = orders.find(
        (o) => o.id === lastOrderId && isCustomerScanOrder(o) && !TERMINAL_STATUSES.has(o.status),
      );
      return candidate ?? null;
    }

    // Fallback：tableId 有但 sessionStorage 冇 lastOrderId（例如 sessionStorage 被清），
    // 仍然唔可以用「該枱最新單」—— 會被商戶 / stale state 誤擋。
    // 唔再做 server-side 推斷；return null 等客人正常落新單。
    // 注意：客人第一次掃枱（sessionStorage 空）想落單就係呢條 path，必須 return null。
    void tableId; // 保留參數以維持 call site 簽名穩定，但唔再用佢做判定
    return null;
  } catch {
    return null;
  }
}
