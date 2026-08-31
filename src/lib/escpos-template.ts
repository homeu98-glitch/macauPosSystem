import { formatMacauDateTime, formatMoney } from "@/lib/format";
import { unitBasePrice } from "@/lib/escpos-render";
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
  store_tel: block(false, "s", false, "center"),
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
    "footer",
  ],
  footerText: "多謝惠顧，歡迎再次光臨",
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

/** 將商家 template 解析成自包含快照（順序 + 開關 + 字型），拼接落 PrintJob.template */
export function buildSnapshot(kind: PrintTemplateKind, template: ReceiptTemplate | LabelTemplate | KitchenTemplate): EscPosTemplateSnapshot {
  return {
    kind,
    blocks: template.order.map((id) => ({ id, ...template.blocks[id as keyof typeof template.blocks] })),
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
  const subtotalBefore = clampMoney(computeSubtotalBeforeDiscount(order));
  const itemSavings = clampMoney(computeItemSavings(order));
  const orderDiscount = clampMoney(order.discountAmount ?? 0);
  const totalDiscount = clampMoney(orderDiscount + itemSavings);
  const subtotalAfter = clampMoney(subtotalBefore - itemSavings);

  const lines: string[] = [];
  for (const it of order.items) {
    const rate = it.discountRate;
    if (rate == null || !Number.isFinite(rate) || rate >= 100 || rate <= 0) continue;
    const base = unitBasePrice(it);
    const saving = clampMoney(base * it.quantity * (rate / 100));
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
    // 防御：优惠合計絕對唔可以大過 subtotal（曾經見到 -72 神秘數值），
    // 一旦 order.discountAmount 同 savings 加埋 > subtotalBefore → 警告並截頂。
    // 觸發通常代表 discount preset 被亂填 / 數據 corruption，唔會爆炸，但會喺 dev console 留痕。
    discount_amount: totalDiscount > 0 ? `優惠合計: ${formatMoney(-totalDiscount, opts.currency)}` : "",
    total: `總金額: ${formatMoney(clampMoney(order.total), opts.currency)}`,
    cash_tendered: (order.cashTendered ?? 0) > 0 ? `实收: ${formatMoney(order.cashTendered ?? 0, opts.currency)}` : "",
    change_amount: (order.changeAmount ?? 0) > 0 ? `找零: ${formatMoney(order.changeAmount ?? 0, opts.currency)}` : "",
    payment_method: order.paymentMethod ?? "現金",
    order_note: order.orderNote ?? "",
    footer: opts.footerText,
  };
}

/**
 * 防御：金額上限保護。`order.discountAmount` 曾經無故被填成好大嘅值
 * （客戶截圖見到「優惠合計 MOP -72」但實際 savings = 8），
 * 呢度統一做「> subtotal 時截頂」防止神秘負數印上細張收據。
 * 同時輸出 dev-only console warn 方便嗣後追溯。
 */
function clampMoney(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 100) / 100;
}

/**
 * 原價合計：Σ (unitBasePrice(it) × quantity)，未扣任何折扣（全單 / 單品都未計）。
 * 唔用 `order.subtotal`（pos-app.tsx 入面 subtotal 已經係 post-單品折扣值），
 * 收據「原價合計」要係 100% 原價先啱。見 docs/88 §4.3。
 */
export function computeSubtotalBeforeDiscount(order: PosOrder): number {
  return order.items.reduce((sum, it) => sum + unitBasePrice(it) * it.quantity, 0);
}

/**
 * 單品折扣 savings 總和（全單折扣唔計在內）。與 `computeTotalDiscount` 拆開，
 * 等收據可以分兩行表達：「單品折讓明細」（每菜逐項） + 「優惠合計」（總和）。
 */
export function computeItemSavings(order: PosOrder): number {
  return order.items.reduce((sum, it) => {
    const rate = it.discountRate ?? 0;
    if (rate <= 0 || rate >= 100) return sum;
    return sum + (unitBasePrice(it) * it.quantity * rate) / 100;
  }, 0);
}

/**
 * 優惠合計：全單折扣（PosOrder.discountAmount = §19「減多少」）＋ 各單品折扣 savings。
 * 單品折扣率 80 = 收 80 元 / 原價 100 → savings = 原價 × 20%。見 docs/88 §3.3 / §4.3。
 *
 * 防御：永遠嘗試 max(0, min(totalDiscount, subtotalBefore))，避免 discountAmount 入咗唔合理值時
 * 印出 -72 等神秘負數（截圖出現過嘅情況）。
 */
export function computeTotalDiscount(order: PosOrder): number {
  const subtotalBefore = computeSubtotalBeforeDiscount(order);
  const orderDiscount = Math.max(0, order.discountAmount ?? 0);
  const itemSavings = Math.max(0, computeItemSavings(order));
  const raw = orderDiscount + itemSavings;
  // 截頂到 subtotalBefore（唔會大過應減）— 同時 printf 用嘅 formatMoney 唔會出負數
  return Math.max(0, Math.min(raw, subtotalBefore));
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
