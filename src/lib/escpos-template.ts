import { formatMacauDateTime, formatMoney } from "@/lib/format";
import {
  EscPosBlockStyle,
  EscPosItemsLayout,
  EscPosTemplateSnapshot,
  KitchenTemplate,
  LabelTemplate,
  PosOrder,
  PrintTemplateKind,
  ReceiptTemplate,
  KitchenSectionId,
  LabelSectionId,
  ReceiptSectionId,
} from "@/lib/types";

// ── 區塊中繼資料（id + 中文標籤），設計介面 / 預覽共用 ──
export const RECEIPT_SECTION_META: { id: ReceiptSectionId; label: string }[] = [
  { id: "store_name", label: "門店名" },
  { id: "store_tel", label: "店家電話" },
  { id: "order_no", label: "單號" },
  { id: "table_name", label: "類型 / 桌台" },
  { id: "order_time", label: "下單時間" },
  { id: "checkout_time", label: "結帳時間" },
  { id: "server", label: "服務員" },
  { id: "items", label: "菜品明細" },
  { id: "discount_breakdown", label: "單品折扣明細" },
  { id: "subtotal_before_discount", label: "原價合計" },
  { id: "service_charge_amount", label: "服務費" },
  { id: "tax_amount", label: "稅金" },
  { id: "rounding_amount", label: "系統抹零" },
  { id: "discount_amount", label: "優惠合計" },
  { id: "total", label: "總計" },
  { id: "cash_tendered", label: "实收" },
  { id: "change_amount", label: "找零" },
  { id: "payment_method", label: "付款方式" },
  { id: "order_note", label: "全單備註" },
  /** 收據二維碼：網址喺「二維碼網址」輸入框設定；空白 = 唔印（連區塊都唔會出現）。 */
  { id: "qr_code", label: "二維碼" },
  { id: "footer", label: "頁尾文案" },
];
export const LABEL_SECTION_META: { id: LabelSectionId; label: string }[] = [
  { id: "header", label: "標題" },
  { id: "item_name", label: "菜品名" },
  { id: "temperature", label: "熱 / 冷" },
  { id: "cup_type", label: "杯型" },
  { id: "sugar", label: "甜度" },
  { id: "ice", label: "冰量" },
  { id: "sugar_tag", label: "甜度標籤" },
  { id: "ice_tag", label: "冰量標籤" },
  { id: "addons", label: "加料" },
  { id: "specs", label: "規格" },
  { id: "item_note", label: "單品備註" },
  { id: "order_no", label: "單號" },
  { id: "footer", label: "頁尾文案" },
];
export const KITCHEN_SECTION_META: { id: KitchenSectionId; label: string }[] = [
  { id: "store_name", label: "門店名" },
  { id: "order_no", label: "單號" },
  { id: "table_name", label: "桌台" },
  { id: "order_type", label: "單據類型" },
  { id: "time", label: "時間" },
  { id: "server", label: "店員" },
  { id: "items", label: "菜品明細" },
  { id: "customer_count", label: "人數" },
  { id: "order_note", label: "全單備註" },
  { id: "footer", label: "頁尾文案" },
];

function block(
  visible: boolean,
  size: "s" | "m" | "l",
  bold: boolean,
  align: "left" | "center" | "right",
  subSize: "s" | "m" | "l" = "s",
  layout?: EscPosItemsLayout,
): EscPosBlockStyle {
  return { visible, size, bold, align, subSize, layout };
}

const RECEIPT_BLOCK_DEFAULTS: Record<ReceiptSectionId, EscPosBlockStyle> = {
  store_name: block(true, "m", true, "center"),
  // 2026-09-01 改 default 做 visible：以前因為 `pos_stores` 冇電話欄，長期搵唔到值
  // 所以預設收起；而家 `resolveStoreTel()` 一定 fallback 到商家登入號碼，
  // 即係「只要有登入就一定印到電話」（57.doc 嘅抬頭格式）。
  // 唔想印嘅商家照舊可以去 列印中心 → 收據模板 撳熄 `store_tel`。
  store_tel: block(true, "s", false, "center"),
  order_no: block(true, "s", false, "left"),
  table_name: block(true, "s", false, "left"),
  order_time: block(true, "s", false, "left"),
  checkout_time: block(false, "s", false, "left"),
  server: block(false, "s", false, "left"),
  items: block(true, "m", true, "left", "s", "card"),
  discount_breakdown: block(true, "s", false, "left"),
  subtotal_before_discount: block(true, "s", false, "right"),
  service_charge_amount: block(false, "s", false, "right"),
  tax_amount: block(false, "s", false, "right"),
  rounding_amount: block(false, "s", false, "right"),
  discount_amount: block(false, "s", false, "right"),
  total: block(true, "l", true, "right"),
  cash_tendered: block(false, "s", false, "right"),
  change_amount: block(false, "s", false, "right"),
  payment_method: block(true, "s", false, "left"),
  order_note: block(true, "s", false, "left"),
  // 二維碼：只有 align 有意義（size / bold 對點陣圖無效）。網址空白就唔會出現。
  qr_code: block(true, "s", false, "center"),
  footer: block(true, "s", false, "center"),
};
const LABEL_BLOCK_DEFAULTS: Record<LabelSectionId, EscPosBlockStyle> = {
  header: block(true, "m", true, "center"),
  item_name: block(true, "l", true, "left"),
  temperature: block(true, "s", false, "center"),
  cup_type: block(true, "s", false, "center"),
  sugar: block(true, "s", false, "center"),
  ice: block(true, "s", false, "center"),
  sugar_tag: block(true, "s", true, "center"),
  ice_tag: block(true, "s", true, "center"),
  addons: block(true, "s", false, "left"),
  specs: block(true, "s", false, "left"),
  item_note: block(true, "s", false, "left"),
  order_no: block(true, "s", false, "center"),
  footer: block(true, "s", false, "center"),
};
const KITCHEN_BLOCK_DEFAULTS: Record<KitchenSectionId, EscPosBlockStyle> = {
  store_name: block(true, "m", true, "center"),
  order_no: block(true, "s", false, "left"),
  table_name: block(true, "s", false, "left"),
  order_type: block(true, "s", true, "left"),
  time: block(true, "s", false, "left"),
  server: block(false, "s", false, "left"),
  items: block(true, "m", true, "left", "s", "card"),
  customer_count: block(false, "s", false, "left"),
  order_note: block(true, "s", false, "left"),
  footer: block(true, "s", false, "center"),
};

export const DEFAULT_RECEIPT_TEMPLATE: ReceiptTemplate = {
  blocks: { ...RECEIPT_BLOCK_DEFAULTS },
  // 排版參考 57.doc（內地餐廳收銀小票典型格式）：抬頭 → 單號 → 時間 → 菜單 → 折扣明細 → 金額流水 → 收款員結算 → 付款 → 備註 → 頁尾。
  order: [
    "store_name",
    "store_tel",
    "order_no",
    "table_name",
    "order_time",
    "checkout_time",
    "server",
    "items",
    "discount_breakdown",
    "subtotal_before_discount",
    "service_charge_amount",
    "tax_amount",
    "rounding_amount",
    "discount_amount",
    "total",
    "cash_tendered",
    "change_amount",
    "payment_method",
    "order_note",
    "qr_code",
    "footer",
  ],
  footerText: "多謝惠顧，歡迎再次光臨",
  // 二維碼預設留空：商家自己去「打印 → 收據模板」填網址先會印 QR。
  qrUrl: "",
};

/**
 * 自助點餐機模版（第四個槽位，`PrintTemplates.kiosk`）嘅預設內容。
 *
 * 規格 8：小票格式同現有小票完全一致、無需額外設計 → 呢度直接深拷貝
 * `DEFAULT_RECEIPT_TEMPLATE`（連 `footerText` 都一樣）。商家之後可以喺「打印」頁
 * 第四個分頁自行改，改咗都唔會影響收銀台收據（兩個係獨立槽位）。
 *
 * ⚠️ 呢個係**模版內容**，同渲染時用嘅 `kind` 係兩回事：
 * 渲染嗰陣要 `buildSnapshot("receipt", kioskTemplate)`，kind 保持 `"receipt"`，
 * 三個 repo（POS / desktop-companion / print-agent-android）先會印到同一個格式。
 * 見 `PrintTemplates.kiosk` 嘅註釋同 docs/87 §2.3。
 */
export const DEFAULT_KIOSK_TEMPLATE: ReceiptTemplate = {
  blocks: Object.fromEntries(
    Object.entries(DEFAULT_RECEIPT_TEMPLATE.blocks).map(([id, style]) => [id, { ...style }]),
  ) as ReceiptTemplate["blocks"],
  order: [...DEFAULT_RECEIPT_TEMPLATE.order],
  footerText: DEFAULT_RECEIPT_TEMPLATE.footerText,
  qrUrl: DEFAULT_RECEIPT_TEMPLATE.qrUrl ?? "",
};
export const DEFAULT_LABEL_TEMPLATE: LabelTemplate = {
  blocks: { ...LABEL_BLOCK_DEFAULTS },
  order: [
    "header",
    "item_name",
    "temperature",
    "cup_type",
    "sugar",
    "ice",
    "sugar_tag",
    "ice_tag",
    "addons",
    "specs",
    "item_note",
    "order_no",
    "footer",
  ],
  headerText: "飲品標籤",
  footerText: "請盡快出品",
};
export const DEFAULT_KITCHEN_TEMPLATE: KitchenTemplate = {
  blocks: { ...KITCHEN_BLOCK_DEFAULTS },
  order: ["store_name", "order_no", "table_name", "order_type", "time", "server", "items", "customer_count", "order_note", "footer"],
  headerText: "",
  footerText: "廚房留底",
};

/**
 * 舊模版補新區塊（向前兼容）。
 *
 * 商家嘅 `printTemplates` 係存喺 localStorage：`order` 陣列同 `blocks` map 係**當初儲存時**
 * 嘅快照。之後我哋新增區塊（例如 `qr_code`），舊設定唔會自動多到呢一項 →
 * 設計介面見唔到、出紙亦唔會印。
 *
 * 呢度做「缺乜補乜」：冇 `qr_code` 就插落 `footer` 之前（收據底部、頁尾之上，
 * 同新模版預設位置一致），並用 `RECEIPT_BLOCK_DEFAULTS` 補返 style，
 * 唔改動商家任何既有設定。
 */
export function ensureReceiptSections(template: ReceiptTemplate): ReceiptTemplate {
  if (template.order.includes("qr_code") && template.blocks.qr_code) return template;
  // ⚠️ 唔好用 `order.filter((id) => id !== "qr_code")` 去重：TS 5.5 會由 callback
  // 推斷出 type predicate，令 `order` 嘅元素類型收窄成 `Exclude<…,"qr_code">`，
  // 之後再 splice("qr_code") 就 compile 唔到。用顯式型別註釋 + indexOf 去重就冇事。
  const order: ReceiptSectionId[] = [...template.order];
  const dup = order.indexOf("qr_code");
  if (dup >= 0) order.splice(dup, 1);
  const at = order.indexOf("footer");
  if (at >= 0) order.splice(at, 0, "qr_code");
  else order.push("qr_code");
  return {
    ...template,
    order,
    blocks: { ...template.blocks, qr_code: template.blocks.qr_code ?? RECEIPT_BLOCK_DEFAULTS.qr_code },
  };
}

/** 將商家 template 解析成自包含快照（順序 + 開關 + 字型），拼接落 PrintJob.template */
export function buildSnapshot(kind: PrintTemplateKind, template: ReceiptTemplate | LabelTemplate | KitchenTemplate): EscPosTemplateSnapshot {
  // 收據（含自助點餐機槽位，兩者都係 kind="receipt"）先補新區塊，
  // 等舊 localStorage 設定都可以用到後來加嘅 `qr_code`。
  const source = kind === "receipt" ? ensureReceiptSections(template as ReceiptTemplate) : template;
  return {
    kind,
    blocks: source.order.map((id) => ({ id, ...source.blocks[id as keyof typeof source.blocks] })),
  };
}

// ── 標籤規格解析（飲品溫度 / 杯型 / 甜度 / 冰量 / 加料）──
type SpecLike = { groupName: string; optionLabel: string };

export function getLabelSpecValue(specs: SpecLike[] | undefined, keywords: string[]) {
  const hit = (specs ?? []).find((spec) => keywords.some((keyword) => spec.groupName.includes(keyword)));
  return hit?.optionLabel ?? "";
}
export function getLabelOptionByKeywords(specs: SpecLike[] | undefined, optionKeywords: string[]) {
  const hit = (specs ?? []).find((spec) => optionKeywords.some((keyword) => spec.optionLabel.includes(keyword)));
  return hit?.optionLabel ?? "";
}
export function getLabelAddonValues(specs: SpecLike[] | undefined) {
  return (specs ?? [])
    .filter((spec) =>
      ["加料", "配料", "小料", "附加", "addon"].some((keyword) => spec.groupName.toLowerCase().includes(keyword.toLowerCase())),
    )
    .map((spec) => spec.optionLabel)
    .filter(Boolean);
}
export function getLabelTextTag(note: string | undefined, keywords: string[]) {
  const text = note ?? "";
  return keywords.find((keyword) => text.includes(keyword)) ?? "";
}

export interface ReceiptContentOpts {
  storeName: string;
  storeTel?: string;
  currency: string;
  footerText: string;
  serverName?: string;
}
export function buildReceiptContent(order: PosOrder, opts: ReceiptContentOpts): Record<string, string> {
  const subtotalBefore = roundMoney(computeSubtotalBeforeDiscount(order));
  const itemSavings = roundMoney(computeItemSavings(order));
  const orderDiscount = roundMoney(Math.max(0, order.discountAmount ?? 0));
  const serviceCharge = roundMoney(Math.max(0, order.serviceChargeAmount ?? 0));
  const tax = roundMoney(Math.max(0, order.taxAmount ?? 0));
  const rounding = roundMoney(Math.max(0, order.roundingAmount ?? 0));
  const orderTotal = roundMoney(Math.max(0, order.total ?? 0));

  // 雙軌對帳（見 resolveTotalDiscount）：理論值 vs 由收據自己印出嚟嘅數反推嘅值。
  const naive = roundMoney(orderDiscount + itemSavings);
  const derived = roundMoney(subtotalBefore + serviceCharge + tax - rounding - orderTotal);
  const totalDiscount = resolveTotalDiscount({ naive, derived, subtotalBefore });
  if (process.env.NODE_ENV !== "production" && Math.abs(naive - totalDiscount) > 0.01) {
    // 兩邊唔夾 = 張單有 stale 金額（退菜 / 加單 / 返結 之後 discountAmount 冇按新基數重計）。
    // 留 console 紀錄方便追溯「優惠合計 -81」呢類神秘數字嘅來源。
    console.warn("[escpos-template] 「優惠合計」雙軌對帳唔夾，已自動取細值。", {
      localOrderNo: order.localOrderNo,
      orderId: order.id,
      // 來源好緊要：線上單（`source !== "pos"` / 有 onlineOrderId）嘅 discountAmount
      // 係由 Ledger 提供，基數同 POS 本地 items 未必同一口徑。
      source: order.source,
      onlineOrderId: order.onlineOrderId,
      subtotalBefore,
      itemSavings,
      orderDiscount,
      serviceCharge,
      tax,
      rounding,
      orderTotal,
      naive,
      derived,
      used: totalDiscount,
      orderSubtotal: order.subtotal,
    });
  }

  const lines: string[] = [];
  for (const it of order.items) {
    const rate = it.discountRate;
    if (rate == null || !Number.isFinite(rate) || rate >= 100 || rate <= 0) continue;
    // ⚠️ base 用 `it.price`（已包加購 spec delta），同 `orderTotals()` 摺 subtotal 嘅基數一致。
    // 唔好用 `unitBasePrice(it)`（會剝走加購 → 折讓計少咗，對唔返「原價合計 − 總金額」）。
    const base = it.price;
    // ⚠️ saving = 原價 × (100 - rate) / 100，唔好用 × rate / 100。
    // rate 85 = 收 85% → 折讓 15%（原價 × 15%）。同 `computeItemSavings` 公式一致。
    const saving = roundMoney(base * it.quantity * ((100 - rate) / 100));
    if (saving > 0) {
      // 仿 57.doc 嘅「折扣率 X% / 折扣金額 Y」格式。
      // 中文小數點：rate 為整數時顯示「80%」否則「80.0%」（保持視覺一致）。
      const rateText = Number.isInteger(rate) ? `${rate}%` : `${rate.toFixed(1)}%`;
      lines.push(`${it.name}  折扣率 ${rateText}  折讓 ${formatMoney(saving, opts.currency)}`);
    }
  }
  const discountBreakdown = lines.join("\n");

  return {
    store_name: opts.storeName,
    store_tel: opts.storeTel ? `電話: ${opts.storeTel}` : "",
    order_no: order.localOrderNo,
    table_name: order.tableName,
    order_time: order.createdAt ? `下單時間: ${formatMacauDateTime(order.createdAt)}` : "",
    checkout_time: checkoutTimeLabelWithPrefix(order),
    server: opts.serverName ? `服務員: ${opts.serverName}` : "",
    discount_breakdown: discountBreakdown,
    subtotal_before_discount: `原價合計: ${formatMoney(subtotalBefore, opts.currency)}`,
    service_charge_amount: (order.serviceChargeAmount ?? 0) > 0 ? `服務費: ${formatMoney(order.serviceChargeAmount ?? 0, opts.currency)}` : "",
    tax_amount: (order.taxAmount ?? 0) > 0 ? `稅金: ${formatMoney(order.taxAmount ?? 0, opts.currency)}` : "",
    rounding_amount: (order.roundingAmount ?? 0) > 0 ? `系統抹零: ${formatMoney(-(order.roundingAmount ?? 0), opts.currency)}` : "",
    // 防御：優惠合計經 `resolveTotalDiscount` 雙軌對帳 + 截頂，
    // 保證「原價合計 + 服務費 + 稅 − 抹零 − 優惠合計 === 總金額」永遠成立。
    // 歷史上出現過 -72 / -81 呢類對唔到數嘅神秘數字（stale `order.discountAmount`）。
    discount_amount: totalDiscount > 0 ? `優惠合計: ${formatMoney(-totalDiscount, opts.currency)}` : "",
    total: `總金額: ${formatMoney(orderTotal, opts.currency)}`,
    cash_tendered: (order.cashTendered ?? 0) > 0 ? `实收: ${formatMoney(order.cashTendered ?? 0, opts.currency)}` : "",
    change_amount: (order.changeAmount ?? 0) > 0 ? `找零: ${formatMoney(order.changeAmount ?? 0, opts.currency)}` : "",
    // 其他金額區塊一律係「標題: 值」（原價合計: / 結帳時間: / 服務員: …），
    // 得呢一格以前淨印值（「現金」），顧客睇唔出嗰個係乜。補返「支付方式: 」前綴保持一致。
    payment_method: `支付方式: ${order.paymentMethod ?? "現金"}`,
    order_note: order.orderNote ?? "",
    footer: opts.footerText,
  };
}

/** 金額四捨五入到 2 位小數；NaN / 負數一律當 0（收據唔會印負數金額）。 */
function roundMoney(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100) / 100;
}

/**
 * 優惠合計嘅「雙軌對帳」取值（docs/95 §用戶反饋 R3-2）。
 *
 * 優惠合計有兩個計法，數據健康時兩邊一定相等：
 * - `naive`   = 全單折扣（`order.discountAmount`）+ Σ 單品折讓（理論值）
 * - `derived` = 原價合計 + 服務費 + 稅 − 抹零 − 總金額（用收據自己印出嚟嘅數反推）
 *
 * 一旦唔相等，代表張單有 stale 金額：退菜 / 加單 / 返結 之後
 * `order.discountAmount` 冇按新基數重計（客戶見過「優惠合計 -72」、
 * 「-81」呢類對唔到數嘅神秘數字，而實際折讓得 2 / 5 蚊）。
 *
 * 取值策略：**取細嗰個，再截頂到原價合計**。
 * 寧願少報折讓，都唔好印一張「原價合計 − 優惠合計 ≠ 總金額」嘅收據畀客。
 */
export function resolveTotalDiscount(parts: {
  /** 理論值：全單折扣 + Σ 單品折讓。 */
  naive: number;
  /** 反推值：原價合計 + 服務費 + 稅 − 抹零 − 總金額。NaN / 負數 = 唔可信，忽略。 */
  derived: number;
  /** 硬上限：折讓永遠唔可以大過原價合計。 */
  subtotalBefore: number;
}): number {
  const { naive, derived, subtotalBefore } = parts;
  const safeNaive = Number.isFinite(naive) ? Math.max(0, naive) : 0;
  const cap = Number.isFinite(subtotalBefore) ? Math.max(0, subtotalBefore) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(derived) || derived < 0) return Math.min(safeNaive, cap);
  return Math.max(0, Math.min(safeNaive, derived, cap));
}

/**
 * 原價合計：Σ (it.price × quantity)，未扣任何折扣（全單 / 單品都未計），
 * **包括加購（spec delta）**。
 *
 * `it.price` 喺 `pos-app.tsx::priceWithSpecs` 入面已經包埋 spec delta：
 * - 非折扣菜：`item.price + specDelta`
 * - 折扣菜：`item.originalPrice + specDelta`（`priceWithSpecs` §菜品層折扣時用 originalPrice）
 * 所以直接 `it.price` 就係「100% 原價」，唔再用 `unitBasePrice(it)`（會剝走加購）。
 * 收據「原價合計」要係加埋加購先啱（docs/95 §用戶反饋 R1）。
 */
export function computeSubtotalBeforeDiscount(order: PosOrder): number {
  return order.items.reduce((sum, it) => sum + it.price * it.quantity, 0);
}

/**
 * 單品折扣 savings 總和（全單折扣唔計在內）。與 `computeTotalDiscount` 拆開，
 * 等收據可以分兩行表達：「單品折讓明細」（每菜逐項） + 「優惠合計」（總和）。
 *
 * ⚠️ **savings 公式係 `(100 - rate)` 唔好用 `rate`**：
 * - rate 80 = 收 80 / 原價 100 → 折讓 20 = 原價 × 20%
 * - rate 85 = 收 85 / 原價 15 → 折讓 2.25 = 原價 × 15%
 * 用咗 `rate` 會算成「折後價」（80% / 85% of original），唔係「折讓金額」。
 * 曾踩過：客戶截圖「優惠合計 MOP -13」但實際 savings 應該係 -2（見 docs/95 §用戶反饋 R3）。
 *
 * ⚠️ **基數用 `it.price`（包埋加購 spec delta）**，同 `pos-app.tsx::orderTotals()`
 * 摺 subtotal 嘅基數一致。用 `unitBasePrice(it)` 會剝走加購 → 折讓計少咗，
 * 「原價合計 − 優惠合計」對唔返「總金額」。
 */
export function computeItemSavings(order: PosOrder): number {
  return order.items.reduce((sum, it) => {
    const rate = it.discountRate ?? 0;
    if (rate <= 0 || rate >= 100) return sum;
    return sum + (it.price * it.quantity * (100 - rate)) / 100;
  }, 0);
}

/**
 * 優惠合計：全單折扣（PosOrder.discountAmount = §19「減多少」）＋ 各單品折扣 savings。
 * 單品折扣率 80 = 收 80 元 / 原價 100 → savings = 原價 × 20%。見 docs/88 §3.3 / §4.3。
 *
 * 防御：經 `resolveTotalDiscount` 做雙軌對帳 + 截頂，避免 stale `discountAmount`
 * 印出 -72 / -81 等對唔到數嘅負數（客戶截圖出現過）。
 */
export function computeTotalDiscount(order: PosOrder): number {
  const subtotalBefore = computeSubtotalBeforeDiscount(order);
  const orderDiscount = Math.max(0, order.discountAmount ?? 0);
  const itemSavings = Math.max(0, computeItemSavings(order));
  const serviceCharge = Math.max(0, order.serviceChargeAmount ?? 0);
  const tax = Math.max(0, order.taxAmount ?? 0);
  const rounding = Math.max(0, order.roundingAmount ?? 0);
  const orderTotal = Math.max(0, order.total ?? 0);
  return resolveTotalDiscount({
    naive: orderDiscount + itemSavings,
    derived: subtotalBefore + serviceCharge + tax - rounding - orderTotal,
    subtotalBefore,
  });
}

/**
 * 結帳時間 raw：settled / partially_refunded / refunded → `originalSettledAt`（首次結帳，重結後保留）；
 * sent_to_kitchen / paid（counter 標記可取餐）→ `servedAt`；未結帳 → 空字串。
 */
function checkoutTimeLabel(order: PosOrder): string {
  if (order.originalSettledAt) return formatMacauDateTime(order.originalSettledAt);
  if (order.servedAt) return formatMacauDateTime(order.servedAt);
  return "";
}

/**
 * 結帳時間區塊：已結帳 → `結帳時間: YYYY-MM-DD HH:MM`；未結帳 → 空字串（隱藏區塊）。
 * 同 `order_time` 一樣用「標題: 值」嘅格式，方便顧客一眼睇到時間軸。
 */
function checkoutTimeLabelWithPrefix(order: PosOrder): string {
  const raw = checkoutTimeLabel(order);
  return raw ? `結帳時間: ${raw}` : "";
}

export interface KitchenContentOpts {
  storeName: string;
  footerText: string;
  typeLabel: string;
  time: string;
  orderNote?: string;
}
export function buildKitchenContent(order: PosOrder, opts: KitchenContentOpts): Record<string, string> {
  return {
    store_name: opts.storeName,
    order_no: order.localOrderNo,
    table_name: order.tableName,
    order_type: opts.typeLabel,
    time: opts.time,
    server: "",
    customer_count: "",
    order_note: opts.orderNote ?? "",
    footer: opts.footerText,
  };
}

export interface LabelContentOpts {
  storeName: string;
  headerText: string;
  footerText: string;
}
export function buildLabelContent(order: PosOrder, item: PosOrder["items"][number], opts: LabelContentOpts): Record<string, string> {
  const specs = item.selectedSpecs;
  const temperature =
    getLabelSpecValue(specs, ["溫度", "熱冷", "冷热", "冷熱"]) ||
    getLabelOptionByKeywords(specs, ["熱", "凍", "冷"]) ||
    getLabelTextTag(item.note, ["熱", "凍", "冷"]);
  const cupType = getLabelSpecValue(specs, ["杯", "杯型", "大小", "尺寸"]);
  const sugar = getLabelSpecValue(specs, ["甜"]);
  const ice = getLabelSpecValue(specs, ["冰"]);
  const sugarTag =
    getLabelOptionByKeywords(specs, ["半糖", "少甜", "微糖", "走糖", "無糖"]) || getLabelTextTag(item.note, ["半糖", "少甜", "微糖", "走糖", "無糖"]);
  const iceTag =
    getLabelOptionByKeywords(specs, ["少冰", "微冰", "走冰", "去冰"]) || getLabelTextTag(item.note, ["少冰", "微冰", "走冰", "去冰"]);
  const addonsFromNote = ["珍珠", "椰果", "奶蓋", "布丁", "仙草", "紅豆"].filter((keyword) => (item.note ?? "").includes(keyword));
  const addons = Array.from(new Set([...getLabelAddonValues(specs), ...addonsFromNote]));
  const specsText = (specs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`).join(" / ");
  return {
    header: opts.headerText,
    item_name: item.name,
    temperature,
    cup_type: cupType,
    sugar,
    ice,
    sugar_tag: sugarTag,
    ice_tag: iceTag,
    addons: addons.join(" / "),
    specs: specsText,
    item_note: item.note ?? "",
    order_no: order.localOrderNo,
    footer: opts.footerText,
  };
}

/** 類型標籤：落單 / 加單 / 退菜 / 收據 */
export function ticketTypeLabel(type: "normal" | "addon" | "void") {
  if (type === "addon") return "加單";
  if (type === "void") return "退菜";
  return "落單";
}
