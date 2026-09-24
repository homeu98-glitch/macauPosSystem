import type { OrderItem, PosOrder } from "@/lib/types";

/**
 * 外賣平台單（澳覓 / MFOOD）由瀏覽器插件推送入嚟之後嘅**唯一轉換口徑**。
 *
 * ── 為什麼獨立一個模組 ────────────────────────────────────────────────
 * 接單 route（`/api/integration/grabber/orders`）只做 HTTP 與 DB，
 * 所有「payload → pos_orders 一列」嘅判斷收喺度，令呢部分可以 `node --test`
 * 直接驗（唔需要起 server、唔需要 Supabase）。
 *
 * ── 🔴 零影響原則 ────────────────────────────────────────────────────
 * 呢個模組係**全新檔案**，完全唔 import 現有 UI／bridge 模組，
 * 亦唔改動任何既有函式（`ledger-pos-bridge` 嗰套照舊行佢自己嗰條路）。
 *
 * ── 🔴 三個唔可以踩嘅地雷（設計上刻意避開）─────────────────────────────
 *   1. **唔可以假定平台菜單存在於 POS**：平台嘅 `itemCode` 只係自由文字，
 *      唔係菜品標記 → 一律靠**菜名比對**，對唔到要**回報**（唔可以靜靜當數）。
 *   2. **金額用「營業額」**（澳覓 `turnoverAmount` / mfood `businessAmount`），
 *      唔用客人實付；平台價同 POS 菜單價唔會一樣，差額入 `discountAmount`。
 *   3. **未知狀態唔可以當成正常**：平台改版加咗新枚舉值時，要落到 `unknown`
 *      並由 caller 記錄落日誌，唔可以靜靜地當「進行中」。
 */

export type GrabberSource = "aomi" | "mfood";

/** 平台單對 POS 生命週期嘅分類。`unknown` 唔等於正常。 */
export type GrabberLifecycle = "active" | "cancelled" | "refunded" | "unknown";

export interface GrabberItem {
  name?: string | null;
  displayName?: string | null;
  itemCode?: string | null;
  skuName?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  specs?: unknown;
}

export interface GrabberOrder {
  source?: string | null;
  externalOrderId?: string | null;
  /** 澳覓：訂單編號（`#2` 連 #）；mfood 冇，要靠 orderNumber */
  storeSeqNo?: string | null;
  /** mfood：訂單編號（數字） */
  orderNumber?: string | number | null;
  /** 澳覓狀態 enum（ASCII，例：`ORDER_ARRIVED`） */
  stateEnum?: string | null;
  /** 澳覓狀態中文（只作 fallback，唔可以單靠佢） */
  stateRaw?: string | null;
  /** mfood 狀態（例如 `completed`） */
  orderStatus?: string | null;
  transactionStatus?: string | null;
  amount?: Record<string, unknown> | null;
  items?: GrabberItem[] | null;
  customer?: { remark?: string | null; phone?: string | null } | null;
  /** 平台類型（外送 / 外賣自取） */
  fulfillmentType?: string | null;
  occurredAt?: string | null;
  timeline?: { created?: string | null } | { createdAt?: string | null } | null;
  [key: string]: unknown;
}

/** 平台單要寫入 `pos_orders` 嘅一列（只列我們會設嘅欄位）。 */
export interface GrabberOrderRow {
  id: string;
  store_id: string;
  local_order_no: string;
  table_id: string;
  table_name: string;
  status: PosOrder["status"];
  items: OrderItem[];
  order_note: string | null;
  subtotal: number;
  tax_amount: number;
  service_charge_amount: number;
  discount_amount: number;
  total: number;
  prepaid_amount: number;
  payment_method: string | null;
  source: GrabberSource;
  created_at: string;
  updated_at: string;
  client_updated_at: string;
  external_order_id: string;
  raw_json: GrabberOrder;
}

export interface ProjectResult {
  ok: boolean;
  reason?: string;
  row?: GrabberOrderRow;
  /** 對唔到 POS 餐牌嘅菜名 —— 🔴 caller **必須**將佢顯示出嚟，唔可以靜靜略過 */
  unmatched: string[];
  warnings: string[];
}

const PLATFORM_LABEL: Record<GrabberSource, string> = {
  aomi: "澳覓",
  mfood: "MFOOD",
};

/** 平台單一律係外賣／自取 → 掛喺快餐枱（POS 既有慣例，見 `kiosk-order.ts`）。 */
const COUNTER_TABLE_ID = "counter";

// ─────────────────────────────────────────────────────────────
// ① 生命週期：唔可以靜靜地當「正常」
// ─────────────────────────────────────────────────────────────

/**
 * 澳覓狀態 → 生命週期。
 *
 * **用 ASCII enum 判斷，唔用中文字串** —— 中文隨時改字（同一個狀態有
 * 「訂單已送達」／「客戶已確認收餐」兩種寫法），用 `includes` 硬猜一定會錯。
 * 中文只作最後 fallback，且只認最明確嘅「取消」「退款」字眼。
 */
export function normalizeAomiLifecycle(
  stateEnum?: string | null,
  stateRaw?: string | null,
): GrabberLifecycle {
  const e = String(stateEnum ?? "").toUpperCase();
  if (e) {
    if (e.includes("CANCEL")) return "cancelled";
    if (e.includes("REFUND")) return "refunded";
    if (e.includes("ORDER")) return "active";
    return "unknown";
  }

  const raw = String(stateRaw ?? "");
  if (raw) {
    if (raw.includes("取消")) return "cancelled";
    if (raw.includes("退款") || raw.includes("退回")) return "refunded";
    return "active";
  }
  return "unknown";
}

/**
 * mfood 狀態 → 生命週期。
 *
 * ⚠️ 插件手上嘅 mfood 狀態表**只有一個已知值**：`orderStatus: "completed"`
 * 同 `transactionStatus: "paid"`（見 `mfood-bridge.js` 嘅 ORDER_STATUS /
 * TRANSACTION_STATUS）。其他值一概係 `null` → 呢度返 `unknown`，
 * 由 caller 記錄，唔會當成正常。
 */
export function normalizeMfoodLifecycle(
  orderStatus?: string | null,
  transactionStatus?: string | null,
): GrabberLifecycle {
  const o = String(orderStatus ?? "").toLowerCase();
  const t = String(transactionStatus ?? "").toLowerCase();

  if (o.includes("cancel") || t.includes("cancel")) return "cancelled";
  if (o.includes("refund") || t.includes("refund")) return "refunded";
  if (o === "completed" || t === "paid") return "active";
  return "unknown";
}

export function grabberLifecycle(order: GrabberOrder): GrabberLifecycle {
  const src = normalizeGrabberSource(order.source);
  if (!src) return "unknown";
  return src === "aomi"
    ? normalizeAomiLifecycle(order.stateEnum, order.stateRaw)
    : normalizeMfoodLifecycle(order.orderStatus, order.transactionStatus);
}

export function normalizeGrabberSource(v: unknown): GrabberSource | null {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "aomi" || s === "mfood" ? s : null;
}

// ─────────────────────────────────────────────────────────────
// ② 單號：對得上後台顯示
// ─────────────────────────────────────────────────────────────

/**
 * `localOrderNo` = 平台前綴 + 後台「訂單編號」原文。
 *
 * 澳覓後台顯示 `#3`（本身就帶 `#`）→ `澳覓#3`
 * mfood 後台顯示 `#2`（原始值係數字 2）→ `MFOOD#2`
 *
 * 目的：印喺收據／廚房單上同後台一模一樣，對單最快。
 * ⚠️ 每日會重來（唔唯一），但 `pos_orders.local_order_no` 冇唯一約束，
 *    而 POS 排序已改用 `createdAt`（見 pos-order-filters 註解），所以安全。
 */
export function grabberLocalOrderNo(order: GrabberOrder): string {
  const src = normalizeGrabberSource(order.source);
  const prefix = src ? PLATFORM_LABEL[src] : "外賣";

  const seq = String(order.storeSeqNo ?? "").trim();
  if (seq) return prefix + (seq.startsWith("#") ? seq : `#${seq}`);

  const num = order.orderNumber;
  if (num !== null && num !== undefined && String(num).trim() !== "") {
    const s = String(num).trim();
    return prefix + (s.startsWith("#") ? s : `#${s}`);
  }

  // 兩個都冇 → 用外部單號尾 6 位，起碼唔會兩張單撞同一個顯示名
  return `${prefix}#${String(order.externalOrderId ?? "").slice(-6)}`;
}

// ─────────────────────────────────────────────────────────────
// ③ 金額：一律用「營業額」
// ─────────────────────────────────────────────────────────────

function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 訂單總額 = **營業額**（唔係客人實付）。
 *   澳覓 `turnoverAmount`（已扣商家活動支出）
 *   mfood `businessAmount`
 * 兩個都冇（舊 payload）→ 退回 `payAmount`，並由 caller 記一個 warning。
 */
export function grabberTurnover(order: GrabberOrder): { total: number; fellBack: boolean } {
  const a = order.amount ?? {};
  const turnover = num(a.turnoverAmount);
  if (turnover > 0) return { total: turnover, fellBack: false };

  const business = num(a.businessAmount);
  if (business > 0) return { total: business, fellBack: false };

  return { total: num(a.payAmount), fellBack: true };
}

/** 菜品原價合計（items 加總）—— 用嚟同營業額對比，差額入 discountAmount。 */
function itemsSubtotal(items: OrderItem[]): number {
  return items.reduce((sum, it) => {
    const price = num(it.price);
    const qty = num(it.quantity);
    return sum + price * qty;
  }, 0);
}

// ─────────────────────────────────────────────────────────────
// ④ 菜單比對：對唔到要回報，唔可以靜靜當數
// ─────────────────────────────────────────────────────────────

/** 同 `ledger-pos-bridge` 同款正規化（該檔為 private，唔改動佢，度留一份）。 */
function normalizeMenuName(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

/**
 * 🔴 平台菜名一律當 **free text** 處理。
 *
 * 使用者 2026-09-24 明確指出：**平台嘅菜名同 POS 餐牌一定唔會一樣**
 * （平台嘅 `itemCode` 亦只係自由文字，唔係菜品標記），
 * 所以**唔應該去猜編號**（曾經加過「去 `A16.` 前綴再比」嘅邏輯，已移除）。
 *
 * ⇒ 保留嘅只有「字面相同 / 去空白同大小寫後相同」呢兩級 —— 佢哋係純字面比對，
 *    唔涉及任何格式假設，命中就係真命中。
 * ⇒ **預期大部分品項都對唔到**（呢個係正常，唔係錯誤）→ 靠「平台訂單分區」
 *    （方案 A）統一分流，唔靠逐項比對。
 */
export interface MenuLike {
  id: string;
  name: string;
  price?: number;
  printerGroup?: string;
}

export function buildMenuIndex(menuItems: MenuLike[]) {
  const byName = new Map<string, MenuLike>();
  const byNormalized = new Map<string, MenuLike>();
  for (const row of menuItems) {
    if (!byName.has(row.name)) byName.set(row.name, row);
    const key = normalizeMenuName(row.name);
    if (key && !byNormalized.has(key)) byNormalized.set(key, row);
  }
  return { byName, byNormalized };
}

export type MatchKind = "name" | "normalized" | null;

/** 品項 → POS 菜品（純字面比對，唔猜格式；對唔到係常態）。 */
export function matchMenuItem(
  item: GrabberItem,
  index: ReturnType<typeof buildMenuIndex>,
): { menu: MenuLike | undefined; matchedBy: MatchKind } {
  const candidates = [item.displayName, item.name, item.skuName]
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);

  for (const name of candidates) {
    const exact = index.byName.get(name);
    if (exact) return { menu: exact, matchedBy: "name" };
  }
  for (const name of candidates) {
    const norm = index.byNormalized.get(normalizeMenuName(name));
    if (norm) return { menu: norm, matchedBy: "normalized" };
  }
  return { menu: undefined, matchedBy: null };
}

// ─────────────────────────────────────────────────────────────
// ⑤ 投影：payload → pos_orders 一列
// ─────────────────────────────────────────────────────────────

export interface ProjectInput {
  order: GrabberOrder;
  storeId: string;
  /** POS 本地餐牌（用嚟取 printerGroup 同菜品 id）。冇傳 = 全部當未命中。 */
  menuItems?: MenuLike[];
  /**
   * 🔴 「平台訂單用邊個分區」（方案 A）。有值 = 平台單**所有**品項都用佢，
   * 唔理餐牌比對結果 —— 因為平台菜單唔存在於 POS，逐項分流根本做唔到。
   * 留空 = 照餐牌比對，對唔到用 `defaultPrinterGroup`。
   */
  platformZone?: string | null;
  /** 對唔到餐牌時嘅分區 fallback（預設 `kitchen`）。 */
  defaultPrinterGroup?: string;
  /** 自動接單開（＝免人手確認）→ 直接 `sent_to_kitchen`；否則 `draft`。 */
  autoAccept?: boolean;
  /** 測試用嘅固定時間。 */
  now?: Date;
}

export function projectGrabberOrder(input: ProjectInput): ProjectResult {
  const { order, storeId } = input;
  const warnings: string[] = [];

  const source = normalizeGrabberSource(order.source);
  if (!source) {
    return { ok: false, reason: `未知嘅來源：${String(order.source)}`, unmatched: [], warnings };
  }

  const externalOrderId = String(order.externalOrderId ?? "").trim();
  if (!externalOrderId) {
    return { ok: false, reason: "缺少 externalOrderId", unmatched: [], warnings };
  }
  if (!storeId) {
    return { ok: false, reason: "缺少 storeId", unmatched: [], warnings };
  }

  const lifecycle = grabberLifecycle(order);
  if (lifecycle === "cancelled" || lifecycle === "refunded") {
    // 正常情況下插件唔會推呢兩種（已取消／待退款係 observedOnly），
    // 但真係收到就唔可以當成正常單建立。
    return {
      ok: false,
      reason: `已${lifecycle === "cancelled" ? "取消" : "退款"}嘅單唔會建立（${String(
        order.stateEnum ?? order.orderStatus ?? "",
      )}）`,
      unmatched: [],
      warnings,
    };
  }
  if (lifecycle === "unknown") {
    warnings.push(
      `狀態無法辨識（${String(order.stateEnum ?? order.orderStatus ?? "(空)")}）—— 已用最保守方式建立，請人手核對`,
    );
  }

  const index = buildMenuIndex(input.menuItems ?? []);
  const defaultZone = input.defaultPrinterGroup || "kitchen";
  const platformZone = input.platformZone ? String(input.platformZone) : null;
  const unmatched: string[] = [];

  const rawItems = Array.isArray(order.items) ? order.items : [];
  const items: OrderItem[] = [];

  for (const it of rawItems) {
    const name = String(it.displayName ?? it.name ?? "").trim();
    if (!name) continue;

    const qty = num(it.quantity) > 0 ? num(it.quantity) : 1;
    const price = num(it.unitPrice);
    const { menu, matchedBy } = matchMenuItem(it, index);
    if (!menu) unmatched.push(name);

    // 規格：平台只給純文字（冇 groupId / optionId / priceDelta），
    // 所以只能當「顯示文字」塞入 optionLabel，唔可以當加價規則。
    const specTexts = Array.isArray(it.specs)
      ? it.specs.map((s) => String(s ?? "").trim()).filter(Boolean)
      : [];
    const selectedSpecs = specTexts.map((label) => ({
      groupId: "platform",
      groupName: "規格",
      optionId: label,
      optionLabel: label,
      priceDelta: 0,
    }));

    items.push({
      menuItemId: menu?.id ?? `ext-${name}`,
      name,
      quantity: qty,
      price,
      printerGroup: platformZone ?? menu?.printerGroup ?? defaultZone,
      ...(selectedSpecs.length > 0 ? { selectedSpecs } : {}),
    });
  }

  if (items.length === 0) {
    return { ok: false, reason: "payload 內冇可用品項", unmatched: [], warnings };
  }
  // 🔴 對唔到餐牌係**常態**，唔係錯誤 —— 平台菜名一律當 free text，
  //    同 POS 餐牌唔會一樣（使用者 2026-09-24 明確指出）。
  //    所以：
  //      · 有設「平台訂單分區」（方案 A）→ **唔告警**。否則每張單都出一條警告
  //        ＝噪音，真問題反而冇人睇。
  //      · 冇設分區（＝逐項靠餐牌比對）→ 才告警，因為嗰陣對唔到就真係會打錯機。
  //    無論如何 `unmatched` 都會照回傳，畀 caller 做匯總統計。
  if (unmatched.length > 0 && !platformZone) {
    warnings.push(
      `${unmatched.length} 個品項對唔到 POS 餐牌（分區退回「${defaultZone}」）：${unmatched
        .slice(0, 5)
        .join("、")}${unmatched.length > 5 ? " …" : ""}`,
    );
  }

  const subtotal = itemsSubtotal(items);
  const { total, fellBack } = grabberTurnover(order);
  if (fellBack) warnings.push("payload 冇營業額欄位（turnoverAmount / businessAmount），已退回 payAmount");

  // 差額 = 菜品原價合計 − 營業額（包含平台補貼與商家活動）。
  // 唔可以係負數（平台價有時會高過 POS 價）。
  const discountAmount = Math.max(0, Math.round((subtotal - total) * 100) / 100);

  const now = input.now ?? new Date();
  const at = String(
    order.occurredAt ?? (order.timeline as { created?: string | null } | null)?.created ?? "",
  ).trim();
  const createdAt = at || now.toISOString();
  const stamp = now.toISOString();

  const row: GrabberOrderRow = {
    id: `${source}-${externalOrderId}`,
    store_id: storeId,
    local_order_no: grabberLocalOrderNo(order),
    table_id: COUNTER_TABLE_ID,
    table_name: "外賣",
    // 自動接單開 → 直接製作中；否則 draft（待確認），等員工按接受
    status: input.autoAccept ? "sent_to_kitchen" : "draft",
    items,
    order_note: String(order.customer?.remark ?? "").trim() || null,
    subtotal,
    tax_amount: 0,
    service_charge_amount: 0,
    discount_amount: discountAmount,
    total,
    // 平台單一律線上已付
    prepaid_amount: total,
    payment_method: "外賣平台",
    source,
    created_at: createdAt,
    updated_at: stamp,
    client_updated_at: stamp,
    external_order_id: externalOrderId,
    raw_json: order,
  };

  return { ok: true, row, unmatched, warnings };
}
