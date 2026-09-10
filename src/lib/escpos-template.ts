import { formatMacauDateTime, formatMoney } from "@/lib/format";
import { RECEIPT_PAPER_COLUMNS, RECEIPT_PAPER_COLUMNS_58MM } from "@/lib/escpos-render";
import {
  DEFAULT_LABEL_PAPER_ID,
  EscPosBlockStyle,
  EscPosItemsLayout,
  EscPosTemplateSnapshot,
  KitchenTemplate,
  LabelPaperPreset,
  LabelTemplate,
  PosOrder,
  PrintTemplateKind,
  ReceiptTemplate,
  LABEL_PAPER_PRESETS,
  KitchenSectionId,
  LabelSectionId,
  ReceiptSectionId,
  ShiftSectionId,
  ShiftSettlementSnapshot,
  ShiftTemplate,
  ShiftTemplateVariant,
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
  /** 分格線：設定型區塊（唔會自己印一行），淨控制菜品明細前後 / 每件菜之間嗰啲 `----` 線嘅字體大小。 */
  { id: "divider", label: "分格線" },
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
  /** 分格線：設定型區塊（唔會自己印一行），淨控制菜品明細前後 / 每件菜之間嗰啲 `----` 線嘅字體大小。 */
  { id: "divider", label: "分格線" },
  { id: "items", label: "菜品明細" },
  { id: "order_note", label: "全單備註" },
  { id: "footer", label: "頁尾文案" },
];

/**
 * 交班結算單嘅區塊清單（2026-09-10「交班模板」）。
 *
 * 順序同呢度一致 = 預設出紙順序；`section_*` 係分節標題，可以獨立改名 / 熄掉。
 * 標籤文案刻意寫得白啲（例如「應收金額合計（線下 POS）」），方便商家喺設計介面
 * 一眼認得邊個區塊對應紙本邊一行。
 */
export const SHIFT_SECTION_META: { id: ShiftSectionId; label: string }[] = [
  { id: "header", label: "抬頭" },
  { id: "store_name", label: "門店名" },
  { id: "shift_no", label: "交班單號" },
  { id: "employee", label: "班次員工" },
  { id: "close_time", label: "交班時間" },
  { id: "open_time", label: "開工時間" },
  { id: "section_store", label: "分節標題：店內（今日）" },
  { id: "settled_count", label: "已結帳訂單" },
  { id: "revenue", label: "營業額" },
  { id: "receivable_total", label: "應收金額合計（線下 POS）" },
  { id: "paid_total", label: "實收金額合計（線下 POS）" },
  { id: "prepaid", label: "線上已支付（店內單）" },
  { id: "refund", label: "退款" },
  { id: "section_online", label: "分節標題：會員通線上（今日）" },
  { id: "online_order_count", label: "線上訂單" },
  { id: "online_paid", label: "已付線上營業額" },
  { id: "online_balance", label: "餘額扣點" },
  { id: "online_in_store", label: "到店／貨到付款" },
  { id: "online_total", label: "線上線下合計" },
  { id: "section_payment", label: "分節標題：支付方式分項" },
  { id: "payment_breakdown", label: "支付方式明細" },
  { id: "section_purchase", label: "分節標題：買貨成本（今日）" },
  { id: "purchase_paid", label: "今日買貨成本（已付）" },
  { id: "section_cash", label: "分節標題：現金箱核對" },
  { id: "expected_cash", label: "應收現金" },
  { id: "actual_cash", label: "實收現金" },
  { id: "cash_diff", label: "現金差額" },
  { id: "note", label: "備註" },
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
  /**
   * 分格線（設定型）。`size` = 分格線嘅字體大小；`visible=false` = 全張單唔印任何分格線。
   * 預設 `m`：對齊而家大多數店嘅實際出紙（廚房/收據 items 預設都係 m，實體線本來就繼承呢個 size）。
   * 想「一條幼線」就揀 `s`（48 個 dash 啱啱印一行；m/l 雙闊會 wrap 成兩行 —— 預覽同步模擬）。
   */
  divider: block(true, "m", false, "left"),
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
  /** 分格線（設定型）：`size` 控制 `----` 線嘅字體大小，`visible=false` = 全張單唔印分格線。 */
  divider: block(true, "m", false, "left"),
  items: block(true, "m", true, "left", "s", "card"),
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
    "divider",
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
  // 二維碼打印大小預設「中」。
  qrSize: "m",
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
  qrSize: DEFAULT_RECEIPT_TEMPLATE.qrSize ?? "m",
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
  // 缺省 62mm：舊商戶手上可能真係有 62mm 卷，唔改佢哋嘅版面。
  paperSize: DEFAULT_LABEL_PAPER_ID,
};
export const DEFAULT_KITCHEN_TEMPLATE: KitchenTemplate = {
  blocks: { ...KITCHEN_BLOCK_DEFAULTS },
  order: ["store_name", "order_no", "table_name", "order_type", "time", "divider", "items", "order_note", "footer"],
  headerText: "",
  footerText: "廚房留底",
};

const SHIFT_BLOCK_DEFAULTS: Record<ShiftSectionId, EscPosBlockStyle> = {
  header: block(true, "m", true, "center"),
  store_name: block(true, "s", false, "left"),
  shift_no: block(true, "s", false, "left"),
  employee: block(true, "s", false, "left"),
  close_time: block(true, "s", false, "left"),
  open_time: block(true, "s", false, "left"),
  section_store: block(true, "s", true, "left"),
  settled_count: block(true, "s", false, "left"),
  revenue: block(true, "s", true, "left"),
  receivable_total: block(true, "s", false, "left"),
  paid_total: block(true, "s", true, "left"),
  prepaid: block(true, "s", false, "left"),
  refund: block(true, "s", false, "left"),
  section_online: block(true, "s", true, "left"),
  online_order_count: block(true, "s", false, "left"),
  online_paid: block(true, "s", false, "left"),
  online_balance: block(true, "s", false, "left"),
  online_in_store: block(true, "s", false, "left"),
  online_total: block(true, "s", true, "left"),
  section_payment: block(true, "s", true, "left"),
  payment_breakdown: block(true, "s", false, "left"),
  section_purchase: block(true, "s", true, "left"),
  purchase_paid: block(true, "s", false, "left"),
  section_cash: block(true, "s", true, "left"),
  expected_cash: block(true, "s", true, "left"),
  actual_cash: block(true, "s", false, "left"),
  cash_diff: block(true, "s", false, "left"),
  note: block(true, "s", false, "left"),
  footer: block(true, "s", false, "center"),
};

/**
 * 分節標題嘅出廠文字。商家可以喺設計介面逐個改（存喺 `ShiftTemplate.sectionTitles`），
 * 呢度只係缺省值。改成空字串 = 該區塊唔印（`buildShiftContent` 會回空字串，
 * renderer `if (!text) continue` 直接跳過）。
 */
export const SHIFT_SECTION_TITLES: Record<
  Extract<ShiftSectionId, `section_${string}`>,
  string
> = {
  section_store: "— 店內（今日）—",
  section_online: "— 會員通線上（今日）—",
  section_payment: "— 支付方式分項（線下 POS）—",
  section_purchase: "— 買貨成本（今日）—",
  section_cash: "— 現金箱核對 —",
};

/**
 * 交班結算單模板嘅預設內容。
 *
 * 順序 = 舊硬編 `shiftDetailToLines()` 嘅出紙順序（原封保留，令升級後出紙唔會突變），
 * 只係多咗一個 `header` 抬頭（舊版冇標題，令紙本唔知係咩單）。
 */
export const DEFAULT_SHIFT_TEMPLATE: ShiftTemplate = {
  blocks: { ...SHIFT_BLOCK_DEFAULTS },
  order: [
    "header",
    "store_name",
    "shift_no",
    "employee",
    "close_time",
    "open_time",
    "section_store",
    "settled_count",
    "revenue",
    "receivable_total",
    "paid_total",
    "prepaid",
    "refund",
    "section_online",
    "online_order_count",
    "online_paid",
    "online_balance",
    "online_in_store",
    "online_total",
    "section_payment",
    "payment_breakdown",
    "section_purchase",
    "purchase_paid",
    "section_cash",
    "expected_cash",
    "actual_cash",
    "cash_diff",
    "note",
    "footer",
  ],
  headerText: "＊＊＊ 交班結算單 ＊＊＊",
  footerText: "交班人簽名：＿＿＿＿＿＿＿＿",
  sectionTitles: { ...SHIFT_SECTION_TITLES },
};

/**
 * 範本庫嘅出廠內容：一套「標準交班單」（= 預設排版）。
 *
 * 刻意唔留空 —— 商家一入「交班模板」頁就見到「範本」係咩概念，
 * 亦即刻有得試「套用」。範本係**可刪**嘅（刪光都唔影響出紙，因為出紙讀
 * `printTemplates.shift` 呢個工作中模板，唔係讀範本庫）。
 */
export const DEFAULT_SHIFT_TEMPLATE_PRESETS: ShiftTemplateVariant[] = [
  {
    id: "shift-preset-standard",
    name: "標準交班單",
    template: DEFAULT_SHIFT_TEMPLATE,
  },
];

/**
 * 範本庫嘅「預設 id」：新店 / 舊 localStorage 冇 `activeShiftTemplateId` 時用呢個。
 * 同 `DEFAULT_SHIFT_TEMPLATE_PRESETS[0].id` 對應。
 */
export const DEFAULT_SHIFT_TEMPLATE_PRESET_ID = DEFAULT_SHIFT_TEMPLATE_PRESETS[0].id;

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

/** 分格線區塊嘅預設樣式（設定型區塊：`size` = `----` 線嘅字體大小，`visible` = 全張單出唔出線）。 */
const DIVIDER_BLOCK_DEFAULT: EscPosBlockStyle = block(true, "m", false, "left");

/**
 * 舊模板補 `divider` 區塊（向前兼容）。
 *
 * 商家嘅 `printTemplates` 係 localStorage 快照，舊設定冇 `divider` 呢個 key。
 * 缺就補返（插落 `items` 前，`size` 預設 `"m"`），等設計介面見到「分格線」、
 * 出紙／預覽都行「明確 size」嘅新邏輯。已有就原封不動（唔改商家設定）。
 *
 * ⚠️ 標籤模板（62mm）**唔好**加：標籤冇分格線，加咗會污染固定紙寬嘅區塊列表。
 */
export function ensureDividerSection<T extends { blocks: Record<string, EscPosBlockStyle>; order: string[] }>(template: T): T {
  if (template.blocks?.divider && template.order.includes("divider")) return template;
  const blocks: Record<string, EscPosBlockStyle> = {
    ...template.blocks,
    divider: template.blocks?.divider ?? DIVIDER_BLOCK_DEFAULT,
  };
  const order = [...template.order];
  if (!order.includes("divider")) {
    const at = order.indexOf("items");
    if (at >= 0) order.splice(at, 0, "divider");
    else order.push("divider");
  }
  return { ...template, blocks, order } as T;
}

/**
 * 標籤實體尺寸固定 → 將標籤模板每個區塊嘅字型檔位鎖死為預設嗰組（禁止動態變更）。
 *
 * 就算 localStorage 儲存咗唔同 size（舊版可改），讀取／出紙／預覽都會強制用
 * `LABEL_BLOCK_DEFAULTS` 嗰組，保證文字排得落固定尺寸標籤紙。返回新對象，唔改入參。
 */
export function withLabelFixedSizes<T extends LabelTemplate>(template: T): T {
  const blocks = { ...template.blocks };
  for (const id of LABEL_SECTION_META.map((m) => m.id)) {
    const def = LABEL_BLOCK_DEFAULTS[id];
    if (blocks[id] && def) blocks[id] = { ...blocks[id], size: def.size };
  }
  return { ...template, blocks };
}

/**
 * 將商家 template 解析成自包含快照（順序 + 開關 + 字型），拼接落 PrintJob.template。
 *
 * `kind` 會原封寫入快照：`receipt | label | kitchen | shift`。
 * 三個下游 repo（POS / desktop-companion / print-agent-android）嘅 TITLE 表只認
 * receipt / label / kitchen —— 傳 `"shift"` 會 fall through 去空字串，
 * 即係**唔會印錯標題**，交班單嘅抬頭由 `header` 區塊自己帶（商家可改）。
 * 呢個係刻意設計：唔加跨 repo 改動都可以做到「零錯標題 + 可自訂抬頭」。
 */
export function buildSnapshot(
  kind: PrintTemplateKind,
  template: ReceiptTemplate | LabelTemplate | KitchenTemplate | ShiftTemplate,
  /**
   * 每行可印字符數。缺省：標籤用模板嘅 `paperSize`，其餘用 48（80mm）。
   * 出紙路徑請由**打印機**嘅 `paperSize` 推算（`paperColumnsFromSize`），
   * 預覽路徑用商家喺設計頁揀嘅紙闊。
   */
  cols?: number,
): EscPosTemplateSnapshot {
  // 收據（含自助點餐機槽位，兩者都係 kind="receipt"）先補新區塊，
  // 等舊 localStorage 設定都可以用到後來加嘅 `qr_code`。
  // 收據（含自助點餐機）先補 `qr_code`；收據 / 廚房再補 `divider`（分格線 size）。
  // ⚠️ 交班模板**唔補 divider**：交班單冇 `items` 區塊，而三個 repo 嘅分格線都係
  // 跟 items 自動生成 → 補咗只會多個撳咗冇反應嘅死開關（見 ShiftSectionId 註釋）。
  // 標籤同樣唔補 divider（標籤紙冇分格線，且字型鎖死）。
  const withReceipt = kind === "receipt" ? ensureReceiptSections(template as ReceiptTemplate) : template;
  const source =
    kind === "label"
      ? withLabelFixedSizes(template as LabelTemplate)   // 標籤字型鎖死
      : kind === "shift"
        ? normalizeShiftTemplate(withReceipt as Partial<ShiftTemplate>)  // 交班：補齊區塊、唔補 divider
        : ensureDividerSection(withReceipt as unknown as { blocks: Record<string, EscPosBlockStyle>; order: string[] });
  return {
    kind,
    blocks: source.order.map((id) => ({ id, ...source.blocks[id as keyof typeof source.blocks] })),
    cols: cols ?? (kind === "label" ? labelPaperPreset((template as LabelTemplate).paperSize).columns : RECEIPT_PAPER_COLUMNS),
  };
}

/**
 * 由標籤紙尺寸 id 攞 preset；未知 / 缺省一律回 62mm（舊預設），
 * 保證舊 localStorage 設定唔會因為多咗呢欄而變形。
 */
export function labelPaperPreset(id: string | undefined | null): LabelPaperPreset {
  return (
    LABEL_PAPER_PRESETS.find((p) => p.id === id) ??
    LABEL_PAPER_PRESETS.find((p) => p.id === DEFAULT_LABEL_PAPER_ID) ??
    LABEL_PAPER_PRESETS[0]!
  );
}

/**
 * 由打印機 `paperSize` 字串推每行字符數（收據 / 廚房 / 交班用）。
 *
 * 同 `print hub` `EscPosRenderer.kt` 既有的 `paperColumns()` 同一套規則
 * （`contains("58")` → 32，否則 48），只係搬到 POS 計一次寫入快照，
 * 等三個 repo 唔使各自判斷（2026-09-10）。
 */
export function paperColumnsFromSize(paperSize: string | undefined | null): number {
  return (paperSize ?? "").includes("58") ? RECEIPT_PAPER_COLUMNS_58MM : RECEIPT_PAPER_COLUMNS;
}

/**
 * 交班模板補齊區塊（向前兼容 + 防呆）。
 *
 * 交班模板係新功能，理論上唔會有「舊設定缺區塊」；但雲端 DB 可能存咗
 * 由舊版本 / 手改過嘅殘缺 JSON，所以讀取時一律補齊：
 * - `order` 過濾無效 id、去重，再按 `SHIFT_SECTION_META` 補回缺失嘅區塊（插喺原位置之後）；
 * - `blocks` 逐 id merge 預設，保證每個 id 都有完整 style（唔會 undefined 炸預覽）。
 *
 * 唔會改動商家任何既有設定（有嘅值一律保留）。
 */
export function normalizeShiftTemplate(input: Partial<ShiftTemplate> | null | undefined): ShiftTemplate {
  const storedBlocks = (input?.blocks ?? {}) as Partial<Record<ShiftSectionId, EscPosBlockStyle>>;
  const blocks = {} as Record<ShiftSectionId, EscPosBlockStyle>;
  for (const { id } of SHIFT_SECTION_META) {
    blocks[id] = { ...SHIFT_BLOCK_DEFAULTS[id], ...(storedBlocks[id] ?? {}) };
  }
  const canonical = SHIFT_SECTION_META.map((m) => m.id);
  const stored = Array.isArray(input?.order) ? input.order : [];
  const seen = new Set<ShiftSectionId>();
  const order: ShiftSectionId[] = [];
  for (const id of stored) {
    // 過濾未知 id（舊版 / 手改）同重複項，否則 renderer 會 emit 一行 `undefined`
    if (canonical.includes(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  // 缺失區塊補喺「同 META 順序一致」嘅位置：逐個 canonical 檢查，未出現就插入。
  for (const id of canonical) {
    if (seen.has(id)) continue;
    seen.add(id);
    // 插喺「canonical 入面排喺佢後面、而 order 已存在」嗰個之前；冇就補落尾
    const nextExisting = canonical
      .slice(canonical.indexOf(id) + 1)
      .find((later) => order.includes(later));
    const at = nextExisting ? order.indexOf(nextExisting) : -1;
    if (at >= 0) order.splice(at, 0, id);
    else order.push(id);
  }
  return {
    blocks,
    order,
    headerText: typeof input?.headerText === "string" ? input.headerText : DEFAULT_SHIFT_TEMPLATE.headerText,
    footerText: typeof input?.footerText === "string" ? input.footerText : DEFAULT_SHIFT_TEMPLATE.footerText,
    sectionTitles: normalizeShiftSectionTitles(input?.sectionTitles),
  };
}

/**
 * 分節標題 normalize：只保留「合法 section id + 字串值」，缺 key 一律補出廠文字。
 *
 * 刻意**唔**用 `?? 出廠值` 逐個硬寫 —— 咁樣商家改成空字串（想唔印）時就會被
 * 誤判成「未設定」而還原返出廠文字。改用「key 存在（即使係空字串）→ 尊重商家」。
 */
function normalizeShiftSectionTitles(
  input: Partial<Record<ShiftSectionId, string>> | null | undefined,
): Partial<Record<ShiftSectionId, string>> {
  const out: Partial<Record<ShiftSectionId, string>> = {};
  for (const id of Object.keys(SHIFT_SECTION_TITLES) as (keyof typeof SHIFT_SECTION_TITLES)[]) {
    const stored = input?.[id];
    out[id] = typeof stored === "string" ? stored : SHIFT_SECTION_TITLES[id];
  }
  return out;
}

/**
 * 範本庫 normalize：過濾壞項（缺 id / name / template）、補齊每個範本嘅模板結構。
 *
 * 回傳**保證非空**：input 係空陣列 / 全部壞項 → 回傳出廠預設範本，
 * 令「範本庫」永遠有嘢揀（商家之後可以再刪）。
 */
export function normalizeShiftTemplatePresets(input: unknown): ShiftTemplateVariant[] {
  if (!Array.isArray(input)) return DEFAULT_SHIFT_TEMPLATE_PRESETS.map(cloneVariant);
  const seen = new Set<string>();
  const out: ShiftTemplateVariant[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Partial<ShiftTemplateVariant>;
    const id = typeof v.id === "string" ? v.id.trim() : "";
    const name = typeof v.name === "string" ? v.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, template: normalizeShiftTemplate(v.template) });
  }
  return out.length > 0 ? out : DEFAULT_SHIFT_TEMPLATE_PRESETS.map(cloneVariant);
}

/** 深拷貝一個範本（避免範本庫同工作中模板不小心共用同一個物件參照）。 */
export function cloneShiftTemplate(template: ShiftTemplate): ShiftTemplate {
  const blocks = {} as Record<ShiftSectionId, EscPosBlockStyle>;
  for (const { id } of SHIFT_SECTION_META) {
    blocks[id] = { ...template.blocks[id] };
  }
  return {
    blocks,
    order: [...template.order],
    headerText: template.headerText,
    footerText: template.footerText,
    sectionTitles: { ...(template.sectionTitles ?? SHIFT_SECTION_TITLES) },
  };
}

function cloneVariant(v: ShiftTemplateVariant): ShiftTemplateVariant {
  return { id: v.id, name: v.name, template: cloneShiftTemplate(v.template) };
}

/**
 * 由 active id 揾返範本名（純介面提示用）。
 *
 * 對唔上（範本已被刪 / 從未套用）→ 回傳 null，介面就唔顯示「基於範本：XXX」。
 * **唔會 throw、唔會影響出紙** —— 出紙一律讀 `printTemplates.shift`。
 */
export function resolveActiveShiftPresetName(
  presets: ShiftTemplateVariant[],
  activeId: string | null | undefined,
): string | null {
  if (!activeId) return null;
  return presets.find((p) => p.id === activeId)?.name ?? null;
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
    order_note: opts.orderNote ?? "",
    footer: opts.footerText,
  };
}

export interface ShiftContentOpts {
  storeName: string;
  /** 抬頭文字（模板 `headerText`）。 */
  headerText: string;
  footerText: string;
  /** 分節標題（模板 `sectionTitles`）；缺省用 `SHIFT_SECTION_TITLES`。 */
  sectionTitles?: Partial<Record<ShiftSectionId, string>>;
  currency?: string;
}

/**
 * 交班結算單：資料快照 → content map（`ShiftSectionId` → 文字）。
 *
 * 呢個係交班單內容嘅**唯一真源**：交班即印、歷史重打、設計頁預覽三條路徑都行呢度。
 * （以前有兩份近似但唔一致嘅 builder —— `shiftDetailToLines()` 同 `buildShiftPrintLines()`，
 * 令「交班即印」同「歷史重打」出紙內容唔同；今次一併收斂成一份。）
 *
 * 缺失 / 唔適用嘅區塊一律回**空字串**：`renderEscPosLines()` 同三個通道嘅 renderer
 * 見到空字串都會直接跳過，唔會留空行。所以商家唔需要為「當日冇線上單」特登熄區塊。
 *
 * @param data 交班快照（見 `ShiftSettlementSnapshot`）。
 * @param opts 模板層級設定（抬頭 / 頁尾 / 分節標題 / 幣別）。
 */
export function buildShiftContent(data: ShiftSettlementSnapshot, opts: ShiftContentOpts): Record<string, string> {
  const currency = opts.currency ?? "MOP";
  const money = (value: number) => formatMoney(Number.isFinite(value) ? value : 0, currency);
  const titles = { ...SHIFT_SECTION_TITLES, ...(opts.sectionTitles ?? {}) };
  const online = data.online;
  const purchase = data.purchase;
  const cash = data.cash ?? { expected: 0 };
  // 支付方式明細：一個方式一行，用 `\n` 串埋（同收據 discount_breakdown 同一手法）。
  // 預覽用 `whitespace-pre-wrap`、出紙 `buf.line()` 兩邊都照印成多行。
  const breakdown =
    data.payments.length === 0
      ? "（今日暫無已結帳線下訂單）"
      : data.payments
          .map((b) => `${b.method}：應收 ${money(b.receivable)} / 實收 ${money(b.paid)} · ${b.count} 張`)
          .join("\n");

  return {
    header: opts.headerText,
    store_name: data.storeName,
    shift_no: data.shiftNo ? `單號：交班單 ${data.shiftNo}` : "",
    employee: data.employee ? `班次員工：${data.employee}` : "",
    close_time: data.closedAt ? `交班時間：${formatMacauDateTime(data.closedAt)}` : "",
    open_time: data.openedAt ? `開工時間：${formatMacauDateTime(data.openedAt)}` : "",
    section_store: titles.section_store ?? "",
    settled_count: `已結帳訂單：${data.store.count} 張`,
    revenue: `營業額：${money(data.store.revenue)}`,
    receivable_total: `應收金額合計（線下 POS）：${money(data.store.receivableTotal)}`,
    paid_total: `實收金額合計（線下 POS）：${money(data.store.paidTotal)}`,
    prepaid: `線上已支付（店內單）：${money(data.store.prepaid)}`,
    refund: `退款：${data.store.refundCount} 張 / ${money(data.store.refundAmount)}`,
    // 線上區塊整組跟 `online` 有冇值：未登入會員通 / 冇 Ledger 資料 → 全部空字串（唔印）。
    section_online: online ? (titles.section_online ?? "") : "",
    online_order_count: online ? `線上訂單：${online.orderCount} 張` : "",
    online_paid: online ? `已付線上營業額：${money(online.paidMop)}` : "",
    online_balance: online ? `餘額扣點：${money(online.balancePaidMop)}` : "",
    online_in_store: online ? `到店／貨到付款：${money(online.inStorePaidMop)}` : "",
    online_total: online ? `線上線下合計（實收金額合計）：${money(data.store.paidTotal + online.paidMop)}` : "",
    section_payment: titles.section_payment ?? "",
    payment_breakdown: breakdown,
    section_purchase: purchase ? (titles.section_purchase ?? "") : "",
    purchase_paid: purchase
      ? // 未付成本唔計入，但一定要講清楚，否則商家會以為買貨成本漏咗（原硬編行為，保留）
        `今日買貨成本（已付）：${money(purchase.paid)}` +
        (purchase.unpaid > 0 ? `\n（未付 ${money(purchase.unpaid)} 不計入）` : "")
      : "",
    section_cash: titles.section_cash ?? "",
    expected_cash: `應收現金：${money(cash.expected)}`,
    actual_cash: typeof cash.actual === "number" ? `實收現金：${money(cash.actual)}` : "",
    cash_diff: typeof cash.diff === "number" ? `現金差額：${money(cash.diff)}` : "",
    note: data.note ? `備註：${data.note}` : "",
    footer: opts.footerText,
  };
}

/**
 * 交班模板設計頁嘅**示例快照**（唔依賴任何真實交班記錄）。
 *
 * 刻意用一個「乜都有值」嘅例子（有線上單、有買貨成本、有現金差額、有多個支付方式），
 * 咁商家喺設計頁就一眼睇齊所有區塊嘅實際效果；唔會因為店未有交班記錄而見到空白預覽。
 */
// ⚠️ 交班示例快照已搬到 `src/lib/preview-fixtures.ts`（`SHIFT_PREVIEW_SAMPLE`）。
// 呢度係 lib（server 都會 import），唔應該夾住一份純 UI 用嘅假資料。

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
