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
  /**
   * 澳覓：訂單編號（`#2` 連 #）。
   *
   * ⚠️ **實際 `aomi-bridge.js::normalizeDetail()` 冇發呢個名** —— 佢發 `storeSeq`
   * （`"10"`）同 `localOrderNo`（`"#10"`）。呢個名只有插件嘅假單生成器會寫。
   * 所以 `grabberLocalOrderNo()` **唔可以只認佢**（否則真單永遠走 fallback）。
   */
  storeSeqNo?: string | null;
  /** 澳覓：`aomi-bridge.js` 真正發嘅訂單編號（唔帶 `#`）。 */
  storeSeq?: string | null;
  /** 澳覓：`aomi-bridge.js` 真正發嘅顯示單號（帶 `#`）。 */
  localOrderNo?: string | null;
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
  fulfillment_status: PosOrder["fulfillmentStatus"] | null;
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
  /** 非菜品費用明細（餐盒／膠袋／服務費）。migration 0056 嘅 `platform_fees`。 */
  platform_fees: Array<{ label: string; amount: number; excluded?: boolean }>;
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

  /** 統一補 `#`：`#3` / `3` 都要出 `澳覓#3`。 */
  const withHash = (v: unknown): string => {
    const s = String(v ?? "").trim();
    if (!s) return "";
    return prefix + (s.startsWith("#") ? s : `#${s}`);
  };

  // 🔴 呢三個名**全部要試**（順序：POS 已知名 → bridge 真正發嘅名）。
  //    實際 payload 出嘅係：
  //      · 澳覓 `aomi-bridge.js::normalizeDetail()` → `storeSeq`（`"10"`）＋ `localOrderNo`（`"#10"`）
  //      · mfood `mfood-bridge.js::normalizeDetail()` → `orderNumber`（數字）
  //      · `storeSeqNo` **只有插件嘅假單生成器會寫**
  //    只認 `storeSeqNo` 嘅後果：真單永遠走最後嗰條 fallback →
  //    單號變 `澳覓#<外部單號尾6位>`，同平台後台對唔上 → 對單即失效。
  //    （2026-09-24 由「假單 payload vs 真 bridge payload 命名對比」發現。）
  for (const candidate of [order.storeSeqNo, order.storeSeq, order.localOrderNo]) {
    const out = withHash(candidate);
    if (out) return out;
  }

  const num = order.orderNumber;
  if (num !== null && num !== undefined && String(num).trim() !== "") {
    return withHash(num);
  }

  // 全部冇 → 用外部單號尾 6 位，起碼唔會兩張單撞同一個顯示名
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

/**
 * 由 payload 抽出**計入營業額**嘅非菜品費用（逐項顯示用）。
 *
 * 🔴 規則由真實單據反推，兩個平台都符合：
 *   澳覓 172 + 5(餐盒) + 1(膠袋) − 21(商家活動) = 157 ✓
 *   mfood 118 + 3(餐盒) + 1(膠袋) − 4(商家滿減)  = 118 ✓
 *   ⇒ 只計「餐盒費 + 膠袋費 + 服務費」；**配送費唔計入營業額**，唔列。
 *
 * 平台欄位名：澳覓用 `*Amt`、mfood 用 `*Fee`，所以兩邊都試。
 */
export function platformFeeLines(order: GrabberOrder): Array<{ label: string; amount: number; excluded?: boolean }> {
  const a = order.amount ?? {};
  const pick = (...keys: string[]): number => {
    for (const k of keys) {
      const v = num(a[k]);
      if (v > 0) return v;
    }
    return 0;
  };

  const out: Array<{ label: string; amount: number }> = [];
  const add = (label: string, amount: number) => {
    if (Number.isFinite(amount) && amount !== 0) out.push({ label, amount });
  };

  // ── 正數費用（計入營業額）──
  add("餐盒費", pick("boxAmt", "boxFee"));
  add("膠袋費", pick("plasticAmt", "plasticBagFee"));
  add("服務費", pick("serviceFee"));
  // 澳覓：節假日服務費
  add("節假日服務費", pick("holidayServiceAmt"));

  // ── 商家承擔嘅優惠（負數；公式係「減」呢幾項）──
  //
  // 🔴 每個都試**兩個名**：
  //    · 插件 bridge 正規化之後嘅名（`*Amount`）—— 實際 payload 用嘅就係佢
  //    · 平台原始名（`*Amt`）—— 保留做保險，萬一有人直接送原始 payload
  //    之前只寫原始名 → 真實單入到 POS 全部搵唔到（2026-09-24 實案）。
  // 澳覓：商家活動支出（代金券 + 滿減…已合併為一個數）
  add("商家活動支出", -pick("merchantActAmt", "merchantActAmount"));
  // mfood：公式 = − 商家代金券 − 商家滿減 − 月卡紅包升級金額
  add("商家代金券", -pick("voucherAmount", "voucherAmtn"));
  add("商家滿減", -pick("fullReductionAmount", "fullReductionAmtn"));
  add("月卡紅包升級", -pick("memberUpAmount", "memberUpMoneyAmt"));

  // ── 唔計入營業額嘅資訊行（只作對數用）──
  //    配送費係**顧客付**嘅，官方公式冇將佢計入營業額。
  //    真實 payload：澳覓 `sendAmt`（屬 payAmt 公式）、
  //                mfood `deliveryFee` 同 `merchantDisDeliveryAmtn`。
  const excluded: Array<{ label: string; amount: number; excluded?: boolean }> = [];
  const addExcluded = (label: string, amount: number) => {
    if (Number.isFinite(amount) && amount !== 0) {
      excluded.push({ label, amount, excluded: true });
    }
  };
  addExcluded("配送費", pick("sendAmt", "deliveryFee", "basicDeliveryFee"));
  addExcluded("商家配送費減免", -pick("merchantDeliveryAmount", "merchantDisDeliveryAmtn"));

  return out.concat(excluded);
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
    const { menu } = matchMenuItem(it, index);
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

  // 非菜品費用（餐盒／膠袋／服務費）：逐項顯示，令收據同平台單一致。
  const fees = platformFeeLines(order);
  // 🔴 只計「計入營業額」嘅行；excluded 行（配送費）唔可以入加總。
  const feeSum = fees.reduce((n, x) => (x.excluded ? n : n + x.amount), 0);

  // 逐項列出費用（含負數嘅商家優惠）之後，理論上已經加得起來：
  //   澳覓 172 + 5 + 1 + 0 − 21 = 157 ✓
  //   mfood 118 + 3 + 1 + 0 − 0 − 4 − 0 = 118 ✓
  // 所以呢度只係**殘差保險**（正常係 0）：萬一平台新增費用種類而我們未識別，
  // 收據嗰邊仲有一行「外送費／餐盒費」兜底，加總永遠對得上。
  const discountAmount = Math.max(
    0,
    Math.round((subtotal + feeSum - total) * 100) / 100,
  );
  // 殘差 > 0 代表「仲有未識別嘅費用」→ 由收據嗰行兜底

  const now = input.now ?? new Date();
  const at = String(
    order.occurredAt ?? (order.timeline as { created?: string | null } | null)?.created ?? "",
  ).trim();
  const createdAt = at || now.toISOString();
  const stamp = now.toISOString();

  const row: GrabberOrderRow = {
    /**
     * 🔴 **一定要含 `storeId`**（2026-09-25 實案）。
     *
     * 舊寫法係 `${source}-${externalOrderId}` —— 同一張平台單推去**兩間唔同嘅店**
     * 就會產生**同一個 `id`**：
     *   ① 店 A 入咗 → `pos_orders.id = "mfood-XXX"`；
     *   ② 店 B 再入 → PK 撞，但 `ON CONFLICT (store_id, source, external_order_id)`
     *      嘅目標係 `(B, mfood, XXX)`，同既有行 `(A, mfood, XXX)` **唔相同**
     *      ⇒ ON CONFLICT **救唔到 PK 衝突** ⇒ Postgres 回 23505
     *      ⇒ POS route 回 500「duplicate key value violates unique constraint "pos_orders_pkey"」
     *      ⇒ 商家見到「送出失敗」，而該店永遠收唔到呢張單（靜默卡死）。
     *
     * 商户實況：同一部機試唔同店（`storeId` 由 A 改成 B）就會即刻中。
     *
     * ⚠️ 改格式係安全嘅：`pos_orders` 對 `(store_id, source, external_order_id)`
     *    有唯一索引，所以舊格式嘅既有行仍然會令 upsert `DO NOTHING`（唔會出兩張）。
     *    亦冇任何代碼靠 `mfood-` / `aomi-` 前綴解析（`order-id-guard` 係黑名單機制）。
     */
    id: `${source}-${storeId}-${externalOrderId}`,
    store_id: storeId,
    local_order_no: grabberLocalOrderNo(order),
    table_id: COUNTER_TABLE_ID,
    table_name: "外賣",
    // 🔴 平台單一律**線上已付款** → status 用 `paid`。
    //
    //    點解唔可以用 `draft` / `sent_to_kitchen`：
    //    `pos-order-filters.getPaymentBadge()` 只認
    //    `paid | settled | refunded | partially_refunded` 為「已結帳」，
    //    其餘一律顯示「未結帳」→ 收銀員會以為仲要收錢，仲會出現「結帳」掣。
    //    平台單嘅錢一早由平台收咗，POS 冇嘢可以再收。
    //
    //    出餐階段改用 `fulfillmentStatus`（preparing = 製作中），
    //    呢個亦係 POS 既有設計（見 pos-order-filters 嘅註解：
    //    「已結帳 + 製作中」＝正常流程）。
    status: "paid",
    fulfillment_status: input.autoAccept ? "preparing" : null,
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
    platform_fees: fees,
    raw_json: order,
  };

  return { ok: true, row, unmatched, warnings };
}
