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
  { id: "order_no", label: "單號" },
  { id: "table_name", label: "類型 / 桌台" },
  { id: "order_time", label: "下單時間" },
  { id: "checkout_time", label: "結帳時間" },
  { id: "items", label: "菜品明細" },
  { id: "total", label: "總計" },
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
  order_no: block(true, "s", false, "left"),
  table_name: block(true, "s", false, "left"),
  order_time: block(true, "s", false, "left"),
  checkout_time: block(false, "s", false, "left"),
  items: block(true, "m", true, "left", "s", "card"),
  total: block(true, "l", true, "right"),
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
  order: ["store_name", "order_no", "table_name", "order_time", "checkout_time", "items", "total", "payment_method", "order_note", "footer"],
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
  currency: string;
  footerText: string;
}
export function buildReceiptContent(order: PosOrder, opts: ReceiptContentOpts): Record<string, string> {
  return {
    store_name: opts.storeName,
    order_no: order.localOrderNo,
    table_name: order.tableName,
    order_time: order.createdAt ? `下單時間: ${formatMacauDateTime(order.createdAt)}` : "",
    checkout_time: checkoutTimeLabelWithPrefix(order),
    total: `總金額: ${formatMoney(order.total, opts.currency)}`,
    payment_method: order.paymentMethod ?? "現金",
    order_note: order.orderNote ?? "",
    footer: opts.footerText,
  };
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
