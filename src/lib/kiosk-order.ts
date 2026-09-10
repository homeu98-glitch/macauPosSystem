"use client";

import { defaultPosLocalSettings } from "@/lib/mock-data";
import { OrderItem, PosOrder, PrintJob, PrinterGroup, QueueEvent } from "@/lib/types";
import { isPlaceholderStoreId } from "@/lib/pos/store-id-guard";
import { posDeviceAuthHeaders } from "@/lib/pos/pos-sync-auth";
import { computeOrderTotals } from "@/lib/kiosk-cart";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * 產生一個「落單草稿」用嘅穩定 order id（2026-09-10 P2-5 idempotency）。
 *
 * `placeOrder()` 每次重試都會傳同一個 id 落 `buildKioskOrder()`，所以
 * 「按兩下 / 網絡重試」唔會建立兩張單（server upsert 同一個 id）。
 * 直到落單成功先重新產生下一個。
 */
export function newKioskOrderId(): string {
  return uid("kiosk");
}

/**
 * 快餐掃碼（`/quick`）**離線**時嘅落單號碼 fallback（docs/115 §5 R2）。
 *
 * 為何唔可以照用 `nextLocalDailyOrderNo("pickup", "自取")`：
 *   快餐掃碼同 kiosk 共用同一條店內 `pickup` 序號（`/api/pos/sequence`）。
 *   離線時本機自己數，但客人手機同收銀機**係兩部唔同裝置** ——
 *   客人手機嘅本地序號同店內序號係兩條獨立數列，必然撞號
 *   （客人手機永遠由「自取01」開始 → 撞死收銀機已經派咗嘅 01）。
 *
 * 所以離線一律用一個**明顯唔係序號**嘅短後綴（例：`自取-K7Q2`）：
 *   - 收銀／廚房一眼睇得出「呢張係離線落嘅、未對號」，唔會誤當正規序號；
 *   - 4 個字元 base32（去掉 0/O/1/I 等易混淆字）≈ 100 萬組合，
 *     同一日同店碰撞機率極低；
 *   - 上雲之後**唔會重寫**號碼（號碼一經落單就係客人手上／收銀見到嘅嗰個，
 *     中途改號只會令追單更加混亂）。
 */
export function quickScanOfflineOrderNo(): string {
  // 去掉 0/O/1/I/L 等易讀錯嘅字元（收銀要口頭／肉眼對號）。
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(4);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let suffix = "";
  for (const b of bytes) suffix += alphabet[b % alphabet.length];
  return `自取-${suffix}`;
}

// ─────────────────────────────────────────────────────────────
// Kiosk 設備綁店（存部機 localStorage，唔使客人 login）
// ─────────────────────────────────────────────────────────────
export const KIOSK_BINDING_KEY = "macau-pos-kiosk-device";

/**
 * @deprecated **唔好再當 fallback 用。**
 *
 * `macau-store-a` 係 admin 帳號系統（`docs/sql/admin-account-schema.sql`）嘅示範店代碼，
 * 同 `merchants.id`（UUID）係兩套嘢。寫落 kiosk 綁定 → `resolveStoreId()` 會拎到佢 →
 * sync 落 `pos_print_jobs.store_id` → 雲端中繼「配咗對但一張都印唔出」。
 *
 * 而家 `saveKioskDeviceBinding()` 會直接拒絕寫入假店，缺 merchantId 時應該**唔好寫綁定**
 * （`resolveStoreId()` 返 undefined → sync 大聲 400，好過靜默寫錯店）。
 *
 * 保留呢個常數只係為咗向後兼容舊 import；新 code 一律唔好用。
 */
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
    if (!raw) return null;
    const binding = JSON.parse(raw) as KioskDeviceBinding;
    // 防禦：舊版本可能已經寫咗示範店代碼落嚟（見 DEFAULT_KIOSK_STORE_ID 嘅 deprecation 註解）。
    // 當冇綁定處理 —— 寧願 sync 大聲 400，都唔好靜默寫錯店。
    if (isPlaceholderStoreId(binding?.storeId)) return null;
    return binding;
  } catch {
    return null;
  }
}

export function saveKioskDeviceBinding(binding: KioskDeviceBinding): void {
  if (typeof window === "undefined") return;
  // 硬閘：示範店代碼一律拒寫。呢度係最後一道防線，確保 resolveStoreId() 永遠拎唔到假店。
  if (isPlaceholderStoreId(binding?.storeId)) {
    console.error(
      `[kiosk] 拒絕寫入示範店綁定（storeId=${binding?.storeId}）。` +
        `呢個係 mock 值，會令雲端中繼「配咗對但印唔出單」。請確保登入有帶到 merchantId。`,
    );
    return;
  }
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
  /**
   * 落單號碼策略（2026-09-10 需求 2 / docs/115）。
   *
   * - `"table"`（**堂食掃碼** `/menu?tableId=`）：**完全唔產生單號**。掃碼端嘅訂單標識
   *   就係 **台號**，所以 `localOrderNo` 直接寫台名（例如 `A01`）—— 唔燒店內序號資源、
   *   唔會每次落單 / 加單就跳出一個新號碼，DB 亦冇任何唯一性約束
   *   （`pos_orders.local_order_no` 係 nullable text，見 0011 / 0012 migration）。
   *
   * - `"sequence"`（**預設**）：行既有邏輯 —— 店內同日序號，攞唔到就本地每日序號 /
   *   時戳後綴。適用於：自助點餐機（kiosk）、**快餐掃碼** `/quick`。
   *
   * ⚠️ **快餐掃碼一定要用 `"sequence"`**（2026-09-10 docs/115 G2 修復）：
   *   快餐冇台號（`tableId = "counter"`、`tableName = "自取"`），如果照堂食咁用台名做
   *   單號，全店幾十張快餐單會**統統叫「自取」** → 廚房單 / 標籤 / 收據 / POS 列表
   *   完全分辨唔到邊張打邊張。快餐每張單獨立，所以必須有自己嘅號碼。
   *
   * ⚠️ 注意 `PosOrder.localOrderNo` 係必填 string —— 而且收銀端嘅收據 / 廚房單
   * 模板都會顯示呢個值。所以掃碼單**唔可以**留空字串（`text("")` 會被 server
   * 收窄成 NULL → 收銀端顯示 `#null`），一律填台名 / 序號。
   */
  orderNoSource?: "sequence" | "table";
};

/**
 * 落單金額嘅**單一真源**（2026-09-10 掃碼點餐審查 P1-3）。
 *
 * 實作已抽去 `@/lib/kiosk-cart`（純函式，可單元測試）。
 * 呢度 re-export 係為咗保持 `buildKioskOrder` 一帶嘅 import 路徑穩定。
 */
export { computeOrderTotals };
export type { KioskOrderTotals } from "@/lib/kiosk-cart";

/** 建構 Kiosk 落單嘅 `PosOrder`（唔落本地 localStorage，推去 Supabase）。 */
export function buildKioskOrder(input: BuildKioskOrderInput): PosOrder {
  const timestamp = new Date().toISOString();
  const slice = new Date().getTime().toString().slice(-4);
  const { subtotal, taxAmount, serviceChargeAmount, total } = computeOrderTotals(input.items, {
    taxRate: input.taxRate,
    serviceChargeRate: input.serviceRate,
  });

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

  // 落單號碼。
  //
  // ── 掃碼（"table"）：**唔產生單號**，直接用台號做訂單標識（需求 2）──
  // 客人端唔會見到任何單號；呢個值只係落 DB 用嚟畀收銀端辨識「邊張枱」。
  // 唔會呼叫 /api/pos/sequence，亦唔會叫 nextLocalDailyOrderNo()。
  if (input.orderNoSource === "table") {
    localOrderNo = input.tableName || input.tableId || "掃碼";
  } else if (input.localOrderNo) {
    // ── Kiosk（"sequence"）：優先用店內線下同日序號（/api/pos/sequence 嘅 display），
    //    kiosk 同店內共用同一日序列表。
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

/** 落單失敗（永久性，例如 400 / 403 —— 重試唔會好）。 */
export class KioskOrderRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KioskOrderRejectedError";
  }
}

/** 落單失敗（可重試：網絡抖動 / 5xx / 429）。 */
export class KioskOrderTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KioskOrderTransientError";
  }
}

/**
 * `/api/pos/sync` 嘅按事件回執（方案 C）。
 *
 * `applied:false` = server **有意冇寫入**（stale / 終態降級 / 未授權），
 * 同「寫入失敗」係兩回事 —— 前者重推冇用，後者可以重試。
 */
type KioskEventAck = {
  id: string;
  ok: boolean;
  applied?: boolean;
  reason?: string;
  error?: string;
};

/** `/api/pos/sync` 嘅回應（方案 C：永遠帶按事件 results）。 */
type KioskSyncResponse = {
  ok?: boolean;
  error?: string;
  /** true = 基建失敗可重試；false = 業務拒絕（永久）。舊 server 冇呢欄。 */
  retryable?: boolean;
  results?: KioskEventAck[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 推 Kiosk 落單去 Supabase（經 `/api/pos/sync`，server 用 service role 寫入）。禁寫本地 localStorage。
 * `eventType` 預設 ORDER_CREATED；resume 重用現有單時傳 ORDER_UPDATED（同一 order.id upsert）。
 *
 * ⚠️ **只會推訂單事件，絕對唔推 `PRINT_JOB_CREATED`**（docs/87 §3.1）。
 * 原因：任何同步咗上 server 嘅 pending job，收銀端 `onPrintJobUpsert` 會 merge 落自己嘅
 * localStorage，然後嗰部機嘅 `PrintFlushWorker` 會照印 → Kiosk 已經印咗一張，收銀台再印多張。
 * Kiosk 嘅顧客小票屬於「本機打印」，由 `appendPrintJobs()` 寫本機就夠，唔好上雲。
 *
 * ## payload 形狀（2026-09-10 加單事故修復 —— 呢度就係根因所在）
 *
 * `ORDER_UPDATED` 嘅 payload **必須**係 `{ order, addedItems }`，唔可以係裸 `order`。
 * `/api/pos/sync` 對 ORDER_UPDATED 係讀 `eventPayload.order`（同收銀台 `submitOrder()`
 * 一致）；舊版呢度寫 `payload: order`（照抄 ORDER_CREATED 嘅形狀）→ server 攞到
 * `eventPayload.order === undefined` → `orderId` 為空 → 回 `ok:false` + **HTTP 500**
 * → client 當網絡抖動重試 3 次 → 入本地待同步隊列 → 顯示「落單成功，正在同步…」。
 * 結果：**掃碼 / kiosk 加單 100% 必定失敗，而客人以為成功、收銀端完全冇反應**
 * （冇新單、冇補印廚房單、冇介面更新）。
 * `addedItems` 亦係 server 端「只驗新增菜品有冇售罄」同收銀端補印嘅依據。
 *
 * ## 失敗分類（2026-09-10）
 *   429 / 5xx / 網絡錯誤 → `KioskOrderTransientError`（入本地隊列，稍後補推）
 *   其他 4xx（業務拒絕：售罄、未授權、payload 有問題）→ `KioskOrderRejectedError`
 *     **即刻拋，唔重試、唔入隊列** —— 重試唔會改變結果，只會燒額度同延遲錯誤曝光。
 */
export async function submitKioskOrder(
  storeId: string,
  order: PosOrder,
  eventType: "ORDER_CREATED" | "ORDER_UPDATED" = "ORDER_CREATED",
  addedItems?: OrderItem[],
): Promise<void> {
  const now = new Date().toISOString();
  const events: QueueEvent[] = [
    {
      id: uid("evt"),
      type: eventType,
      entityId: order.id,
      // ⚠️ ORDER_UPDATED 一定用 `{ order, addedItems }`（同收銀台一致）；
      // ORDER_CREATED 保持裸 order（兩種 server 版本都食）。
      payload: eventType === "ORDER_UPDATED" ? { order, addedItems: addedItems ?? [] } : order,
      status: "synced",
      createdAt: now,
      // 🛡️ 跨店隔離 L1：kiosk 落單事件帶自身綁定店（函數參數 storeId 即真源，
      // 唔使再行 resolveStoreId() —— kiosk 未登入 POS 帳號，auth branch 會 miss）。
      storeId,
    },
  ];
  const body = JSON.stringify({ storeId, events });
  const eventId = events[0].id;

  const MAX_ATTEMPTS = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let res: Response;
    try {
      res = await fetch("/api/pos/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...posDeviceAuthHeaders() },
        body,
      });
    } catch (e) {
      // 網絡層失敗（離線 / DNS / TLS）→ 可重試
      lastError = new KioskOrderTransientError(e instanceof Error ? e.message : String(e));
      if (attempt < MAX_ATTEMPTS - 1) await sleep(300 * (attempt + 1));
      continue;
    }

    // ⚠️ 一定要用具名型別做斷言。寫 `as typeof payload` 會中招：`payload` 啱啱初始化為
    // `null`，TS 會用**收窄後**嘅型別（`null`）→ 之後所有 `payload.results` 都變 `never`。
    let payload: KioskSyncResponse | null = null;
    try {
      payload = (await res.json()) as KioskSyncResponse;
    } catch {
      // 回應非 JSON（例如 503 HTML），下面靠 status 判斷
    }

    // 讀本事件嘅回執：`applied:false` 代表 server **有意冇寫入**（stale / 終態降級）。
    const myAck = payload?.results?.find((r) => r?.id === eventId) ?? null;

    if (res.ok && payload?.ok !== false) {
      if (myAck && myAck.applied === false && eventType === "ORDER_UPDATED") {
        // 加單特別處理：`applied:false` = 收銀端已經有更新版本／雲端已有較新狀態，
        // 今次加單**冇生效**。唔可以當成功（否則又係「客人以為落咗、收銀端冇反應」）。
        throw new KioskOrderRejectedError(
          "加單未被接受（雲端已有較新版本），請返回重新載入本枱訂單後再試。",
        );
      }
      return;
    }

    const msg = myAck?.error ?? payload?.error ?? `落單失敗（${res.status}）`;

    // 429（限流）：喺度硬重試只會令情況更差 → 即刻交本地隊列，等稍後慢慢補推。
    if (res.status === 429) throw new KioskOrderTransientError(msg);

    // 4xx（非 429）＝ **業務拒絕**（售罄 / 未授權 / payload 有問題）：重試同一個請求
    // 結果一樣，所以即刻拋永久錯誤，由 UI 直接告知客人（唔好靜默入隊造假成功）。
    if (res.status >= 400 && res.status < 500) {
      throw new KioskOrderRejectedError(msg);
    }

    // 5xx / 其他：基建失敗，真係可以重試
    lastError = new KioskOrderTransientError(msg);
    if (attempt < MAX_ATTEMPTS - 1) await sleep(300 * (attempt + 1));
  }

  throw lastError ?? new KioskOrderTransientError("落單失敗");
}

// ─────────────────────────────────────────────────────────────
// 重複掃碼 resume：以**台號**查該台未結單（DB 真源）
// ─────────────────────────────────────────────────────────────
//
// ⚠️ root-cause（2026-08-31 · 用戶掃 A01 見「已落單」但枱面「空間 / 已坐 0/10」）：
// 舊邏輯以「該枱有任何 server-side open 單」＝「有人坐」，會被以下 stale state 誤擋：
//   - 返結（`reopened`）後 temp 枱未清 / sync 時差，server 仍有 stale reopened record
//   - 其他 terminal 嘅 draft / sent_to_kitchen 單 sync 落 server，枱 ID 撞咗
//   - 商戶嘅 paid counter 單（quick）殘留喺 /api/pos/state 配對到枱 ID
//
// 修正：resume 嘅單一真源改為「客人自己嘅單」——只認 `source === "scan"`。
// 商戶 / kiosk 落嘅單唔會被當客人 resume 對象（佢哋有自己嘅 round-trip，不需 resume）。
//
// ⚠️ 2026-09-10（需求 1「資料以 DB 為準」）嘅**進一步修正**：
// 舊版 resume 嘅唯一入口係 `sessionStorage("kiosk-last-order")` 嘅 orderId；
// **客人第一次掃呢張枱**（換手機 / 清過 session / 用另一部機）→ orderId 係 undefined
// → `fetchUnsettledKioskOrder()` 直接 `return null` → 畫面當「新枱」顯示空白餐牌，
// 但 DB 明明已經有 A01 嘅已下單菜品。
//
// 掃碼下單嘅查詢鍵本來就係**台號**（需求 2：客人端唔需要、亦唔會見到單號），
// 所以而家改為：
//   ① 有 orderId（同一部手機）→ 精確查（最快、最準，亦係最細嘅資料面）；
//   ② 冇 orderId 但有台號 → **依台號查該台未結嘅掃碼單**（DB 為準）。
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

/** 非終態 + 係客人自己嘅掃碼單 = 可以 resume 加單。 */
function isResumableScanOrder(order: PosOrder | null | undefined): order is PosOrder {
  if (!order?.id) return false;
  if (!isCustomerScanOrder(order)) return false;
  return !TERMINAL_STATUSES.has(order.status);
}

/** 排序用時間戳：優先 `createdAt`（落單時間），同值再用 `updatedAt`。 */
function orderRecency(order: PosOrder): number {
  const created = Date.parse(order.createdAt ?? "");
  const updated = Date.parse(order.updatedAt ?? "");
  return (Number.isFinite(created) ? created : 0) * 1000 + (Number.isFinite(updated) ? updated : 0);
}

/**
 * 依**台號**查該台未結嘅客人掃碼單（DB 真源）。
 *
 * 呢個係掃碼流程嘅主查詢路徑 —— 客人掃 A01 QR 嗰刻，DB 有咩就顯示咩，
 * 唔會因為本機 session 冇紀錄而顯示空白 / 當新單。
 *
 * @returns 最新一張可 resume 嘅單（台上有多過一張未結掃碼單屬異常，取最新一張），
 *          冇（或查詢失敗 / 未配置）一律回 `null` → 客人正常落新單。
 */
export async function fetchScanTableOrder(storeId: string, tableId: string): Promise<PosOrder | null> {
  if (!storeId || !tableId) return null;
  try {
    const res = await fetch(
      `/api/pos/order-lookup?storeId=${encodeURIComponent(storeId)}&tableId=${encodeURIComponent(tableId)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; order?: PosOrder | null; orders?: PosOrder[] };
    const list = Array.isArray(data?.orders) ? data.orders : data?.order ? [data.order] : [];
    const resumable = list.filter(isResumableScanOrder);
    if (resumable.length === 0) return null;
    if (resumable.length > 1) {
      console.warn(
        `[kiosk-order] 台號 ${tableId} 有 ${resumable.length} 張未結掃碼單（異常），resume 最新一張。`,
      );
    }
    return resumable.reduce((acc, cur) => (orderRecency(cur) >= orderRecency(acc) ? cur : acc));
  } catch {
    return null;
  }
}

/** 精確查一張客人掃碼單（同一部手機重複掃碼時行呢條快路）。 */
export async function fetchScanOrderById(storeId: string, orderId: string): Promise<PosOrder | null> {
  if (!storeId || !orderId) return null;
  try {
    const res = await fetch(
      `/api/pos/order-lookup?storeId=${encodeURIComponent(storeId)}&orderId=${encodeURIComponent(orderId)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; order?: PosOrder | null };
    const order = data?.order ?? null;
    return isResumableScanOrder(order) ? order : null;
  } catch {
    return null;
  }
}

/**
 * resume：要唔要載入「本枱現有訂單」。
 *
 * 兩段查詢（見上面長註釋）：
 *   ① `lastOrderId`（sessionStorage）→ 精確查；
 *   ② 失敗 / 冇 → 用 `tableId` 依台號查（**DB 為準**，唔再因為冇 session 就當新枱）。
 */
export async function fetchUnsettledKioskOrder(
  storeId: string,
  tableId: string | null,
  lastOrderId?: string,
): Promise<PosOrder | null> {
  if (lastOrderId) {
    const byId = await fetchScanOrderById(storeId, lastOrderId);
    if (byId) return byId;
  }
  if (tableId) return fetchScanTableOrder(storeId, tableId);
  return null;
}

/**
 * 客人端訂單狀態文案（掃碼「本枱訂單」頁顯示「下單狀態」用）。
 *
 * 實作已抽去 `@/lib/pos/order-status-label`（純函式，可單元測試）。
 * 呢度 re-export 係為咗保持 `kiosk-order` 一帶嘅 import 路徑穩定。
 */
export { customerOrderStatusLabel } from "@/lib/pos/order-status-label";
