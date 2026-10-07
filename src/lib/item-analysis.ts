/**
 * 「庫存 › 品項分析」嘅**列組裝 / 排序 / 篩選 / 摘要**（零 import 純函式）。
 *
 * 🔴 為何獨立一個檔：
 *    本專案 `npm test` 係 `node --test`，**唔識解析 `@/` alias**。
 *    呢個檔要畀守衛測試直接 import ⇒ 必須零 import（`item-price-baseline.ts` 都唔可以 import）。
 *    故此下面嘅 `round2` / `computeChange` 係**刻意自己一份**，唔 re-export 另一支
 *    —— 兩支都係 10 行以內嘅算術，重複成本遠低於「測唔到」嘅代價。
 *    ⚠️ 口徑漂移風險喺 `item-price-baseline.test.ts` 有一條「兩邊算術一致」嘅對照測試守住。
 *
 * 對應線框圖：`docs/mockups/inventory-item-analysis-wireframe-2026-10-07.html`
 *   ・區塊 2 篩選／排序（`filterItemAnalysisRows()`）
 *   ・區塊 3 KPI（`summarizeItemAnalysis()`）
 *   ・區塊 4 圖表（`buildAmountRanking()` / `buildCategoryBreakdown()`）
 *   ・區塊 5 漲價清單（`buildItemAnalysisRows()`）
 *   ・區塊 6 手機版（同一批 row，只係版面唔同）
 */

/* ───────────────────────── 型別 ───────────────────────── */

/** 輸入：庫存品（`inv_products` 嘅子集；其餘欄位用 index signature 放行）。 */
export type AnalysisProductInput = {
  name: string;
  category?: string | null;
  unit?: string | null;
  current_qty?: number | null;
  /** 加權平均進價 —— 即「最新單價」。 */
  avg_unit_cost?: number | null;
  /** 基準價（首次進貨單價）；`null` ＝ 未有基準。 */
  baseline_unit_cost?: number | null;
  /** 基準價生效日（首次進貨收據日期）；只供顯示。 */
  baseline_at?: string | null;
  last_supplier?: string | null;
  is_active?: boolean | null;
  [key: string]: unknown;
};

export type AnalysisDirection = "up" | "down" | "same" | "new";

/** 一行品項分析（＝線框圖漲價清單嘅一行）。 */
export type ItemAnalysisRow = {
  id: string;
  name: string;
  /** `null` ⇒ UI 顯示「未分類」，**唔可以填假值**。 */
  category: string | null;
  /** `null` ⇒ UI 顯示「—」。 */
  supplier: string | null;
  unit: string;
  currentQty: number;
  /** `current_qty × avg_unit_cost`（round2）。 */
  stockValue: number;
  /** 只計 is_active＝true 嘅本店品項總值；總值為 0 ⇒ `null`（**唔可以報 0%**）。 */
  valueSharePercent: number | null;
  /** 基準價（首次進貨單價）；`null` ＝ 首次記錄。 */
  baselineUnitCost: number | null;
  /** 基準價生效日。 */
  baselineAt: string | null;
  /** 最新單價（加權平均進價）。 */
  latestUnitCost: number;
  /** 單價漲跌額 `latest − baseline`；`null` ＝ 未有基準。 */
  deltaUnitCost: number | null;
  /** 漲跌幅 %；`null` ＝ 未有基準或基準 ≤ 0（**唔會出 Infinity**）。 */
  changePercent: number | null;
  /** 受影響金額 `delta × currentQty`；`null` ＝ 未有基準。 */
  changeAmount: number | null;
  direction: AnalysisDirection;
};

export type ItemAnalysisSummary = {
  /** Σ 全部 active 品項嘅庫存金額。 */
  stockTotal: number;
  /** active 品項數。 */
  itemCount: number;
  categoryCount: number;
  supplierCount: number;
  /** Σ 庫存數量（**只做參考**：單位唔同唔可以混用，UI 唔應該顯示）。 */
  qtyTotal: number;
  /** direction === "up" 嘅品項數（唔計「首次記錄」）。 */
  upCount: number;
  downCount: number;
  sameCount: number;
  /** 「首次記錄」品項數 —— **唔入漲跌統計**。 */
  newCount: number;
  /** Σ 漲價影響金額（只加正數）。 */
  totalUpAmount: number;
  /** Σ 跌價影響金額（**負數**）。 */
  totalDownAmount: number;
  /** 漲價品項佔全部 active 品項嘅百分比；itemCount ＝ 0 ⇒ 0。 */
  upSharePercent: number;
  /** 有可比基準嘅品項嘅平均漲幅 %；無可比品項 ⇒ `null`。 */
  avgChangePercent: number | null;
};

/** 排序選項（線框圖 §2）。 */
export type ItemAnalysisSortKey =
  | "change_desc"
  | "change_asc"
  | "value_desc"
  | "share_desc"
  | "name_asc";

export type ItemAnalysisFilters = {
  /** false = 全部；true = 只看漲價品項。 */
  onlyUp?: boolean;
  /** 空 = 全部分類。 */
  category?: string;
  /** 空 = 全部供應商。 */
  supplier?: string;
  /** 品項名搜尋（大小寫、首尾空白唔敏感）。 */
  query?: string;
};

/** 金額排名（長條圖）一點。 */
export type AmountRankPoint = {
  name: string;
  value: number;
  /** 佔庫存總值 %；總值為 0 ⇒ `null`。 */
  sharePercent: number | null;
};

/** 分類佔比（環圖）一點。 */
export type CategorySharePoint = {
  /** `null` ＝ 未分類（UI 顯示「未分類」）。 */
  label: string | null;
  value: number;
  sharePercent: number | null;
};

/* ───────────────────────── 內部工具 ───────────────────────── */

function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/,/g, "").replace(/[^\d.-]/g, "").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** 空字串 / 全空白 → null。`"  "` 唔可以當成一個真分類。 */
function nullIfBlank(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 計單一品項可否比較（基準 ≤ 0 一律當「未有基準」）= `item-price-baseline.computePriceChange()` 嘅濃縮版。
 *
 * 🔴 分母保護：`base <= 0` ⇒ `changePercent` 回 `null`，**唔會出 Infinity／NaN**。
 *    呢種情況同「未有基準」一樣，因為兩者都冇可比嘅起點。
 */
function computeChange(latest: number, base: number | null, qty: number): {
  latestUnitCost: number;
  deltaUnitCost: number | null;
  changePercent: number | null;
  changeAmount: number | null;
  direction: AnalysisDirection;
} {
  const latestR = round2(latest);
  if (base === null || base <= 0) {
    return {
      latestUnitCost: latestR,
      deltaUnitCost: null,
      changePercent: null,
      changeAmount: null,
      direction: "new",
    };
  }
  const delta = round2(latestR - base);
  return {
    latestUnitCost: latestR,
    deltaUnitCost: delta,
    changePercent: (delta / base) * 100,
    changeAmount: round2(delta * qty),
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "same",
  };
}

/* ───────────────────────── 主體 ───────────────────────── */

/**
 * 由 `inv_products` 組出分析列。
 *
 * ⚠️ 只計 `is_active !== false` 嘅品項 —— 已停用品項唔應該出現喺分析、亦唔應該計入分母。
 * ⚠️ `id` 缺席時（例如純函式測試只傳 name）用 `name` 做 fallback key。
 */
export function buildItemAnalysisRows(products: AnalysisProductInput[]): ItemAnalysisRow[] {
  const active = (products ?? []).filter((p) => p && p.is_active !== false);

  let stockTotal = 0;
  for (const p of active) {
    stockTotal += round2(toNumber(p.current_qty, 0) * toNumber(p.avg_unit_cost, 0));
  }
  stockTotal = round2(stockTotal);

  const rows: ItemAnalysisRow[] = active.map((p) => {
    const name = String(p.name ?? "").trim();
    const qty = toNumber(p.current_qty, 0);
    const latest = toNumber(p.avg_unit_cost, 0);
    const stockValue = round2(qty * latest);
    /*
     * 🔴 基準價：`null` / 空 ⇒ 未有基準；**唔可以 `?? 0`**
     *    —— 0 會被當成「基準 ＝ 0」而令 direction 變 new 之外，仲會污染 below 嘅比較。
     */
    const rawBase = p.baseline_unit_cost;
    const base = rawBase === null || rawBase === undefined ? null : round2(toNumber(rawBase, 0));
    const change = computeChange(latest, base, qty);

    return {
      id: typeof p.id === "string" && p.id ? p.id : name,
      name,
      category: nullIfBlank(p.category),
      supplier: nullIfBlank(p.last_supplier),
      unit: nullIfBlank(p.unit) ?? "unit",
      currentQty: qty,
      stockValue,
      // 總值為 0 ⇒ null（唔可以報 0%，會渲染假零）
      valueSharePercent: stockTotal > 0 ? (stockValue / stockTotal) * 100 : null,
      baselineUnitCost: base,
      baselineAt: nullIfBlank(p.baseline_at),
      latestUnitCost: change.latestUnitCost,
      deltaUnitCost: change.deltaUnitCost,
      changePercent: change.changePercent,
      changeAmount: change.changeAmount,
      direction: change.direction,
    };
  });

  return rows;
}

/**
 * 摘要（KPI 四卡）。
 *
 * 🔴 `new`（首次記錄）**完全唔入**漲跌統計 —— 唔當 0% 報（避免虛高／假零）。
 * 🔴 `totalUpAmount` / `totalDownAmount` **分開累加**，唔可以互相抵消
 *    （否則睇唔出真實影響；線框圖 §5 合計列寫得明）。
 * 🔴 `avgChangePercent` 只平均**有可比基準**嘅品項（up／down／same 都算，因為 same ＝ 0% 係真數據）；
 *    一個可比品項都冇 ⇒ `null`（唔可以報 0）。
 */
export function summarizeItemAnalysis(rows: ItemAnalysisRow[]): ItemAnalysisSummary {
  const list = rows ?? [];
  let stockTotal = 0;
  let qtyTotal = 0;
  let upCount = 0;
  let downCount = 0;
  let sameCount = 0;
  let newCount = 0;
  let totalUpAmount = 0;
  let totalDownAmount = 0;
  let changePercentSum = 0;
  let comparableCount = 0;

  const categories = new Set<string>();
  const suppliers = new Set<string>();

  for (const r of list) {
    stockTotal += r.stockValue;
    qtyTotal += r.currentQty;
    if (r.category !== null) categories.add(r.category);
    if (r.supplier !== null) suppliers.add(r.supplier);

    if (r.direction === "new") {
      newCount += 1;
      continue; // 🔴 首次記錄唔入任何漲跌數字
    }
    if (r.direction === "up") upCount += 1;
    else if (r.direction === "down") downCount += 1;
    else sameCount += 1;

    const amt = r.changeAmount ?? 0;
    if (amt > 0) totalUpAmount = round2(totalUpAmount + amt);
    else if (amt < 0) totalDownAmount = round2(totalDownAmount + amt);

    if (r.changePercent !== null && Number.isFinite(r.changePercent)) {
      changePercentSum += r.changePercent;
      comparableCount += 1;
    }
  }

  const itemCount = list.length;
  return {
    stockTotal: round2(stockTotal),
    itemCount,
    categoryCount: categories.size,
    supplierCount: suppliers.size,
    qtyTotal: round2(qtyTotal),
    upCount,
    downCount,
    sameCount,
    newCount,
    totalUpAmount,
    totalDownAmount,
    upSharePercent: itemCount > 0 ? (upCount / itemCount) * 100 : 0,
    avgChangePercent: comparableCount > 0 ? changePercentSum / comparableCount : null,
  };
}

/**
 * 篩選 + 排序（**回新陣列**，唔改傳入嘅）。
 *
 * ⚠️ 排序一定要**穩定**：`Array.prototype.sort` 喺 V8 已經穩定，
 *    但 `change_desc` 遇到一堆 `changePercent === null`（首次記錄）時，
 *    若唔做 null 排序，嗰批會散落在中間、睇落似「亂序」。故此一律將 null 推到最後。
 * 🔴 `valueSharePercent` 為 null（總值 0）時亦同樣推最後，唔當 0 排。
 */
export function filterItemAnalysisRows(
  rows: ItemAnalysisRow[],
  filters: ItemAnalysisFilters = {},
  sortKey: ItemAnalysisSortKey = "change_desc",
): ItemAnalysisRow[] {
  const q = (filters.query ?? "").trim().toLowerCase();
  const cat = (filters.category ?? "").trim();
  const sup = (filters.supplier ?? "").trim();

  const filtered = (rows ?? []).filter((r) => {
    if (filters.onlyUp && r.direction !== "up") return false;
    if (cat && (r.category ?? "") !== cat) return false;
    if (sup && (r.supplier ?? "") !== sup) return false;
    if (q && !r.name.toLowerCase().includes(q)) return false;
    return true;
  });

  /** null 永遠排最後嘅比較器（回 -1 ＝ a 先）。 */
  const nullLast = (a: number | null, b: number | null, dir: "asc" | "desc"): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return dir === "desc" ? b - a : a - b;
  };

  const sorted = [...filtered];
  sorted.sort((a, b) => {
    let primary = 0;
    switch (sortKey) {
      case "change_asc":
        primary = nullLast(a.changePercent, b.changePercent, "asc");
        break;
      case "value_desc":
        primary = nullLast(a.stockValue, b.stockValue, "desc");
        break;
      case "share_desc":
        primary = nullLast(a.valueSharePercent, b.valueSharePercent, "desc");
        break;
      case "name_asc":
        primary = a.name.localeCompare(b.name, "zh-Hant");
        break;
      case "change_desc":
      default:
        primary = nullLast(a.changePercent, b.changePercent, "desc");
        break;
    }
    if (primary !== 0) return primary;
    // 次要：金額大者先（令同漲幅嘅品項有可預測次序），最後用名穩定
    return b.stockValue - a.stockValue || a.name.localeCompare(b.name, "zh-Hant");
  });
  return sorted;
}

/** 金額排名（長條圖 Top N）。 */
export function buildAmountRanking(rows: ItemAnalysisRow[], limit = 6): AmountRankPoint[] {
  const total = (rows ?? []).reduce((sum, r) => sum + r.stockValue, 0);
  return [...(rows ?? [])]
    .sort((a, b) => b.stockValue - a.stockValue || a.name.localeCompare(b.name, "zh-Hant"))
    .slice(0, Math.max(0, limit))
    .map((r) => ({
      name: r.name,
      value: r.stockValue,
      sharePercent: total > 0 ? (r.stockValue / total) * 100 : null,
    }));
}

/** 分類佔比（環圖）。 */
export function buildCategoryBreakdown(rows: ItemAnalysisRow[]): CategorySharePoint[] {
  const buckets = new Map<string, { label: string | null; value: number }>();
  let total = 0;
  for (const r of rows ?? []) {
    const key = r.category ?? "\u0000unclassified";
    const bucket = buckets.get(key) ?? { label: r.category, value: 0 };
    bucket.value = round2(bucket.value + r.stockValue);
    buckets.set(key, bucket);
    total += r.stockValue;
  }
  total = round2(total);
  return [...buckets.values()]
    .sort((a, b) => b.value - a.value)
    .map((b) => ({
      label: b.label,
      value: b.value,
      sharePercent: total > 0 ? (b.value / total) * 100 : null,
    }));
}

/**
 * 由分析列抽出篩選選項（分類 / 供應商）。
 *
 * 🔴 分類係 `inv_products.category` 嘅**自由文字**，選項必須由實際資料 distinct 得出，
 *    **唔可以**用寫死清單（否則商家自己打嘅分類永遠揀唔到）。
 * 排序跟傳入嘅 `preferredOrder`（商家拖過嘅次序），未排過嘅跟名稱。
 */
export function collectAnalysisFilterOptions(
  rows: ItemAnalysisRow[],
  preferredOrder: { categories?: string[]; suppliers?: string[] } = {},
): { categories: string[]; suppliers: string[] } {
  const catSet = new Set<string>();
  const supSet = new Set<string>();
  for (const r of rows ?? []) {
    if (r.category) catSet.add(r.category);
    if (r.supplier) supSet.add(r.supplier);
  }

  const order = (values: Set<string>, preferred?: string[]): string[] => {
    const pref = (preferred ?? []).filter((v) => values.has(v));
    const prefSet = new Set(pref);
    const rest = [...values].filter((v) => !prefSet.has(v)).sort((a, b) => a.localeCompare(b, "zh-Hant"));
    return [...pref, ...rest];
  };

  return {
    categories: order(catSet, preferredOrder.categories),
    suppliers: order(supSet, preferredOrder.suppliers),
  };
}

/**
 * 庫存數量顯示（3 位小數 + 單位）—— 線框圖 §7 格式對照。
 * `unit` 為空／"unit" 時唔顯示單位（避免出「12.000 unit」）。
 */
export function formatAnalysisQty(qty: number, unit: string): string {
  const n = Number(qty) || 0;
  const text = n.toLocaleString("zh-MO", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const u = (unit ?? "").trim();
  if (!u || u === "unit") return text;
  return `${text} ${u}`;
}
