/**
 * 零售商品 CSV 批量匯入 —— **純函式，零 runtime 依賴**。
 *
 * 2026-09-12 商家定案：商品「應該都要有條碼，然後需要批量匯入」。
 *
 * 【設計原則】
 *   ① **手寫 parser，唔加外部依賴** —— 匯入係一次性動作，唔值得為佢背一個 library，
 *      而且倉庫慣例係純模組零依賴（`node --test` 直接載入）。
 *   ② **唔會靜默覆蓋**：先出「新增 / 更新 / 唔變 / 錯誤 / 警告」計劃，商家確認先寫入。
 *   ③ **中文表頭自動對照** —— 商家由 Excel 出 CSV，表頭一定係中文（「售價」「條碼」…）。
 *   ④ 金額同庫存一律**驗證 + 正規化**，唔可以將 `$9.50` 或者空白當成 0 靜默寫入。
 */

import type { RetailProduct } from "@/lib/retail/types";

// ─────────────────────────────────────────────────────────────
// CSV parser
// ─────────────────────────────────────────────────────────────

/**
 * 解析 CSV。
 *
 * 支援：BOM、CRLF / LF / 舊式 CR、雙引號包住嘅欄位（內含逗號 / 換行 / 轉義 `""`）。
 * 尾隨全空行會被剔走（Excel 出 CSV 經常多一行）。
 */
export function parseCsv(text: string, opts: { delimiter?: string } = {}): string[][] {
  const delim = opts.delimiter ?? ",";
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  return rows;
}

/** 猜分隔符（Excel 中文環境有時出 tab / 分號） */
export function guessDelimiter(text: string): string {
  const head = String(text ?? "").split(/\r?\n/).slice(0, 3).join("\n");
  const counts: Array<[string, number]> = [
    [",", (head.match(/,/g) ?? []).length],
    [";", (head.match(/;/g) ?? []).length],
    ["\t", (head.match(/\t/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

// ─────────────────────────────────────────────────────────────
// 欄位對照
// ─────────────────────────────────────────────────────────────

export type RetailImportField =
  | "id"
  | "name"
  | "categoryId"
  | "barcode"
  | "extraBarcodes"
  | "plu"
  | "sku"
  | "price"
  | "originalPrice"
  | "cost"
  | "unit"
  | "trackStock"
  | "stockQty"
  | "reorderLevel"
  | "isWeighed"
  | "isSerialized"
  | "minAge"
  | "requiresRecord"
  | "batchNo"
  | "expiryDate";

export interface ImportFieldMeta {
  key: RetailImportField;
  label: string;
  /** 中文 / 英文表頭別名（比對時會 lowercase + 去空白） */
  aliases: string[];
}

export const RETAIL_IMPORT_FIELDS: ImportFieldMeta[] = [
  { key: "id", label: "商品 ID", aliases: ["id", "商品id", "产品id", "編號", "编号"] },
  { key: "name", label: "商品名", aliases: ["商品名", "商品名稱", "商品名称", "名稱", "名称", "品名", "name", "product", "productname"] },
  { key: "categoryId", label: "分類", aliases: ["分類", "分类", "類別", "类别", "category", "categoryid", "分類id"] },
  { key: "barcode", label: "主條碼", aliases: ["條碼", "条码", "主條碼", "主条码", "barcode", "ean", "ean13", "upc"] },
  { key: "extraBarcodes", label: "額外條碼", aliases: ["額外條碼", "额外条码", "其他條碼", "其他条码", "附加條碼", "extrabarcodes", "多條碼"] },
  { key: "plu", label: "PLU", aliases: ["plu", "店內碼", "店内码", "自編碼", "自编码", "秤碼", "称码"] },
  { key: "sku", label: "SKU", aliases: ["sku", "貨號", "货号", "商品編號", "商品编号"] },
  { key: "price", label: "售價", aliases: ["售價", "售价", "價格", "价格", "單價", "单价", "price", "sellprice"] },
  { key: "originalPrice", label: "原價", aliases: ["原價", "原价", "牌價", "牌价", "originalprice", "listprice"] },
  { key: "cost", label: "成本", aliases: ["成本", "成本價", "成本价", "來貨價", "来货价", "cost"] },
  { key: "unit", label: "單位", aliases: ["單位", "单位", "unit", "計價單位"] },
  { key: "trackStock", label: "追蹤庫存", aliases: ["追蹤庫存", "追踪库存", "管理庫存", "trackstock"] },
  { key: "stockQty", label: "庫存", aliases: ["庫存", "库存", "現有庫存", "现有库存", "數量", "数量", "stock", "stockqty", "qty"] },
  { key: "reorderLevel", label: "警戒線", aliases: ["警戒線", "警戒线", "補貨點", "补货点", "安全庫存", "reorderlevel", "minstock"] },
  { key: "isWeighed", label: "稱重", aliases: ["稱重", "称重", "計重", "计重", "秤重", "isweighed"] },
  { key: "isSerialized", label: "序號商品", aliases: ["序號", "序号", "序號商品", "序列号", "isserialized", "imei"] },
  { key: "minAge", label: "年齡限制", aliases: ["年齡", "年龄", "年齡限制", "年龄限制", "minage"] },
  { key: "requiresRecord", label: "需登記", aliases: ["需登記", "需登记", "受管制", "管制", "requiresrecord"] },
  { key: "batchNo", label: "批次", aliases: ["批次", "批號", "批号", "batchno", "lot"] },
  { key: "expiryDate", label: "有效日期", aliases: ["有效日期", "有效期", "到期日", "保質期", "保质期", "expirydate", "expiry"] },
];

const normHeader = (s: string) => String(s ?? "").trim().toLowerCase().replace(/[\s_\-（）()]/g, "");

/** 自動把表頭對照去欄位（搵唔到 → null，由 UI 畀商家手動揀） */
export function autoMapHeaders(headers: readonly string[]): Array<RetailImportField | null> {
  const used = new Set<RetailImportField>();
  return (headers ?? []).map((h) => {
    const n = normHeader(h);
    if (!n) return null;
    for (const meta of RETAIL_IMPORT_FIELDS) {
      if (used.has(meta.key)) continue;
      if (meta.aliases.some((a) => normHeader(a) === n)) {
        used.add(meta.key);
        return meta.key;
      }
    }
    return null;
  });
}

/** 第一行係唔係表頭 */
export function detectHeaderRow(firstRow: readonly string[], mapping?: ReadonlyArray<RetailImportField | null>): boolean {
  const m = mapping ?? autoMapHeaders(firstRow ?? []);
  return m.some((x) => x !== null);
}

// ─────────────────────────────────────────────────────────────
// 值正規化
// ─────────────────────────────────────────────────────────────

/** 金額：剝走 `$` `,` `MOP` 同空白 */
export function parseMoney(raw: string): number | null {
  const s = String(raw ?? "").replace(/[$mopMOP\s,，]/g, "");
  if (!s) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** 數量（稱重商品可以有 3 位小數） */
export function parseQty(raw: string): number | null {
  const s = String(raw ?? "").replace(/[\s,，kgKG千克斤]/g, "");
  if (!s) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

/** 布林：接受中英文常見寫法；空白 → null（= 冇填，唔好當 false） */
export function parseBool(raw: string): boolean | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["是", "y", "yes", "true", "1", "v", "✓", "✔", "有", "要", "開", "开"].includes(s)) return true;
  if (["否", "n", "no", "false", "0", "x", "✗", "冇", "無", "无", "不", "關", "关"].includes(s)) return false;
  return null;
}

/** 日期 → `YYYY-MM-DD`；接受 `YYYY/M/D`、`YYYY.M.D`、`YYYYMMDD` */
export function parseDate(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 一條商品可以多個條碼：用 `|` `;` `、` `,` 分隔（CSV 裡面包住引號就可以用逗號） */
export function splitBarcodes(raw: string): string[] {
  return String(raw ?? "")
    .split(/[|;、,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// 匯入計劃
// ─────────────────────────────────────────────────────────────

export interface ImportRowError {
  /** 1-based，**同 Excel 行號一致**（含表頭行）— 商家要搵得到 */
  rowNumber: number;
  field?: RetailImportField;
  message: string;
}

export interface ParsedImportRow {
  rowNumber: number;
  /** 由 CSV 砌出嚟嘅商品（未寫入） */
  product: Partial<RetailProduct> & { name: string; price: number };
  /** 原始文字（錯誤顯示 / 除錯用） */
  raw: Record<string, string>;
}

export interface ImportUpdate {
  existing: RetailProduct;
  row: ParsedImportRow;
  /** 有變嘅欄位（畀商家睇「會改咩」） */
  changedFields: string[];
}

export interface ImportPlan {
  delimiter: string;
  headers: string[];
  mapping: Array<RetailImportField | null>;
  unmappedHeaders: string[];
  hasHeader: boolean;
  rows: ParsedImportRow[];
  creates: ParsedImportRow[];
  updates: ImportUpdate[];
  unchanged: ParsedImportRow[];
  errors: ImportRowError[];
  /** 唔阻擋匯入，但商家應該睇（例如冇任何識別碼、價格係 0） */
  warnings: ImportRowError[];
  /** 同一個檔案內重複嘅條碼 / PLU */
  duplicatesInFile: Array<{ code: string; rowNumbers: number[] }>;
}

const COLUMN_LETTER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface BuildImportPlanOpts {
  delimiter?: string;
  /** 強制指定表頭行（預設自動偵測） */
  hasHeader?: boolean;
  /** 手動欄位對照（索引 → 欄位）；唔傳就用自動對照 */
  mapping?: Array<RetailImportField | null>;
}

/**
 * 由 CSV 文字砌出匯入計劃。
 *
 * **唔會改任何資料** —— 商家睇完計劃（新增 / 更新 / 錯誤）確認先寫入。
 */
export function buildImportPlan(
  csvText: string,
  existing: readonly RetailProduct[] = [],
  opts: BuildImportPlanOpts = {},
): ImportPlan {
  const delimiter = opts.delimiter ?? guessDelimiter(csvText);
  const table = parseCsv(csvText, { delimiter });
  const first = table[0] ?? [];
  const autoMapping = autoMapHeaders(first);
  const hasHeader = opts.hasHeader ?? detectHeaderRow(first, autoMapping);
  const headers = hasHeader ? first : first.map((_, i) => `第 ${i + 1} 欄`);
  const mapping = opts.mapping ?? (hasHeader ? autoMapping : headers.map(() => null));

  const dataRows = hasHeader ? table.slice(1) : table;
  const startRowNumber = hasHeader ? 2 : 1;

  const rows: ParsedImportRow[] = [];
  const errors: ImportRowError[] = [];
  const warnings: ImportRowError[] = [];

  // 索引現有商品（用嚟配對）
  const byId = new Map<string, RetailProduct>();
  const byCode = new Map<string, RetailProduct>();
  for (const p of existing ?? []) {
    if (p.id) byId.set(p.id, p);
    for (const c of [p.barcode, ...(p.extraBarcodes ?? [])]) {
      const k = String(c ?? "").trim();
      if (k && !byCode.has(k)) byCode.set(k, p);
    }
  }

  const seenCodes = new Map<string, number[]>();

  dataRows.forEach((cells, idx) => {
    const rowNumber = startRowNumber + idx;
    // 全空行跳過（Excel 常見）
    if (cells.every((c) => c.trim() === "")) return;

    const raw: Record<string, string> = {};
    const p: Partial<RetailProduct> = {};
    let rowHasBlockingError = false;

    const err = (field: RetailImportField | undefined, message: string) => {
      errors.push({ rowNumber, field, message });
      rowHasBlockingError = true;
    };
    const warn = (field: RetailImportField | undefined, message: string) => {
      warnings.push({ rowNumber, field, message });
    };

    const fieldCols = new Map<RetailImportField, { value: string; letter: string }>();
    mapping.forEach((field, col) => {
      if (!field) return;
      const value = String(cells[col] ?? "").trim();
      raw[field] = value;
      if (!fieldCols.has(field)) fieldCols.set(field, { value, letter: COLUMN_LETTER[col] ?? String(col + 1) });
    });

    const get = (f: RetailImportField) => fieldCols.get(f)?.value ?? "";

    // id
    const id = get("id");
    if (id) p.id = id;

    // name（必要）
    const name = get("name");
    if (!name) err("name", "商品名唔可以空白");
    else p.name = name;

    // price（必要；只有 name 而冇價錢 = 唔可以賣）
    const priceRaw = get("price");
    if (!priceRaw) {
      err("price", "售價唔可以空白");
    } else {
      const price = parseMoney(priceRaw);
      if (price === null || price < 0) err("price", `售價「${priceRaw}」唔係有效金額`);
      else {
        p.price = price;
        if (price === 0) warn("price", "售價係 0（確認係贈品 / 免費才正確）");
      }
    }

    // 可選金額
    (["originalPrice", "cost"] as const).forEach((f) => {
      const v = get(f);
      if (!v) return;
      const n = parseMoney(v);
      if (n === null || n < 0) err(f, `${RETAIL_IMPORT_FIELDS.find((x) => x.key === f)!.label}「${v}」唔係有效金額`);
      else p[f] = n;
    });

    // 識別碼
    const barcode = get("barcode");
    if (barcode) {
      const list = splitBarcodes(barcode);
      if (list.length === 0) err("barcode", "主條碼格式唔正確");
      else p.barcode = list[0];
    }
    const extras = splitBarcodes(get("extraBarcodes"));
    if (extras.length > 0) p.extraBarcodes = extras;

    const plu = get("plu");
    if (plu) p.plu = plu;
    const sku = get("sku");
    if (sku) p.sku = sku;

    if (!p.barcode && !p.plu && !p.sku && !p.id) {
      warn(undefined, "冇條碼 / PLU / SKU / ID —— 收銀只可以靠搜尋搵到呢件商品");
    }

    // 基本欄位
    const categoryId = get("categoryId");
    if (categoryId) p.categoryId = categoryId;
    const unit = get("unit");
    if (unit) p.unit = unit;

    // 布林
    (["trackStock", "isWeighed", "isSerialized", "requiresRecord"] as const).forEach((f) => {
      const v = get(f);
      if (!v) return;
      const b = parseBool(v);
      if (b === null) err(f, `${RETAIL_IMPORT_FIELDS.find((x) => x.key === f)!.label}「${v}」唔係有效嘅是/否`);
      else p[f] = b;
    });

    // 數字
    (["reorderLevel", "minAge"] as const).forEach((f) => {
      const v = get(f);
      if (!v) return;
      const n = parseQty(v);
      if (n === null || n < 0) err(f, `${RETAIL_IMPORT_FIELDS.find((x) => x.key === f)!.label}「${v}」唔係有效數字`);
      else p[f] = Math.round(n);
    });

    const stockRaw = get("stockQty");
    if (stockRaw) {
      const n = parseQty(stockRaw);
      if (n === null || n < 0) err("stockQty", `庫存「${stockRaw}」唔係有效數量`);
      else p.stockQty = n;
    }

    // 日期
    const exp = get("expiryDate");
    if (exp) {
      const d = parseDate(exp);
      if (!d) err("expiryDate", `有效日期「${exp}」唔係有效日期（YYYY-MM-DD）`);
      else p.expiryDate = d;
    }
    const batch = get("batchNo");
    if (batch) p.batchNo = batch;

    // 稱重商品一定要 PLU（秤端只認 PLU；冇 PLU 嘅稱重商品等於廢）
    if (p.isWeighed && !p.plu) {
      const col = fieldCols.get("plu")?.letter;
      err("plu", `稱重商品一定要填 PLU${col ? `（第 ${col} 欄）` : "（CSV 缺少 PLU 欄）"}`);
    }
    // 稱重單位提示
    if (p.isWeighed && p.unit && !/kg|公斤|千克/i.test(p.unit)) {
      warn("unit", `稱重商品嘅單位係「${p.unit}」，一般應該係 kg`);
    }

    if (rowHasBlockingError) return;

    // 檔案內重複識別碼（唔可以靜默：同一條碼兩行 = 掃碼收錯錢）
    for (const code of [p.barcode, p.plu].filter(Boolean) as string[]) {
      const key = String(code);
      const list = seenCodes.get(key);
      if (list) {
        list.push(rowNumber);
        errors.push({ rowNumber, message: `識別碼「${key}」喺檔案內重複出現（第 ${list.join(", ")} 行）` });
        rowHasBlockingError = true;
      } else {
        seenCodes.set(key, [rowNumber]);
      }
    }
    if (rowHasBlockingError) return;

    rows.push({
      rowNumber,
      product: p as ParsedImportRow["product"],
      raw,
    });
  });

  // 配對現有商品
  const creates: ParsedImportRow[] = [];
  const updates: ImportUpdate[] = [];
  const unchanged: ParsedImportRow[] = [];

  for (const row of rows) {
    const p = row.product;
    let match: RetailProduct | undefined;
    if (p.id) match = byId.get(p.id);
    if (!match && p.barcode) match = byCode.get(String(p.barcode));
    if (!match && p.sku) match = (existing ?? []).find((x) => x.sku === p.sku);

    if (!match) {
      creates.push(row);
      continue;
    }
    const changedFields = diffFields(match, p);
    if (changedFields.length === 0) unchanged.push(row);
    else updates.push({ existing: match, row, changedFields });
  }

  const duplicatesInFile: ImportPlan["duplicatesInFile"] = [];
  for (const [code, nums] of seenCodes) {
    if (nums.length > 1) duplicatesInFile.push({ code, rowNumbers: nums });
  }

  return {
    delimiter,
    headers,
    mapping,
    unmappedHeaders: headers.filter((_, i) => !mapping[i]),
    hasHeader,
    rows,
    creates,
    updates,
    unchanged,
    errors,
    warnings,
    duplicatesInFile,
  };
}

/** 邊啲欄位真係會改（冇改就唔應該無謂寫入） */
export function diffFields(existing: RetailProduct, incoming: Partial<RetailProduct>): string[] {
  const out: string[] = [];
  const keys: Array<keyof RetailProduct> = [
    "name",
    "categoryId",
    "barcode",
    "plu",
    "sku",
    "price",
    "originalPrice",
    "cost",
    "unit",
    "trackStock",
    "stockQty",
    "reorderLevel",
    "isWeighed",
    "isSerialized",
    "minAge",
    "requiresRecord",
    "batchNo",
    "expiryDate",
  ];
  for (const k of keys) {
    const inc = (incoming as unknown as Record<string, unknown>)[k];
    if (inc === undefined) continue; // CSV 冇填 → 唔改
    const cur = (existing as unknown as Record<string, unknown>)[k];
    if (k === "extraBarcodes") continue;
    if (cur !== inc) out.push(String(k));
  }
  const incExtras = incoming.extraBarcodes;
  if (incExtras) {
    const cur = existing.extraBarcodes ?? [];
    if (cur.length !== incExtras.length || cur.some((x, i) => x !== incExtras[i])) {
      out.push("extraBarcodes");
    }
  }
  return out;
}

/** 匯入計劃摘要（UI 頂部一行睇晒） */
export function describeImportPlan(plan: ImportPlan): string {
  const parts = [
    `新增 ${plan.creates.length}`,
    `更新 ${plan.updates.length}`,
    `唔變 ${plan.unchanged.length}`,
  ];
  if (plan.errors.length) parts.push(`錯誤 ${plan.errors.length}`);
  if (plan.warnings.length) parts.push(`警告 ${plan.warnings.length}`);
  return parts.join(" · ");
}
