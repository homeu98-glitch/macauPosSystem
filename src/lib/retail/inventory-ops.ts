/**
 * 零售庫存 / 盤點操作 —— **純函式，零 runtime 依賴**。
 *
 * 呢個模組只做**陣列轉換**（計數、估算、批量改動計劃），實際寫入仍由呼叫端
 * 用 `saveRetailProducts()` 做 —— 同 `catalog-ops.ts` 完全同一個口徑。
 *
 * 【同 `stock.ts` 嘅分工】
 *   - `stock.ts`：**交易**引起嘅庫存變動（售出扣、退貨補），帶 `shortfall` 語義
 *   - `inventory-ops.ts`：**盤點 / 補貨**引起嘅庫存變動（人手改），帶「盤盈盤虧」語義
 * 兩者都會經 `applyStockDeltas()` 落手，但**呢度唔會靜默**：
 * 盤點係人手輸入，改動前一律回傳 `before` / `after` 畀 UI 確認。
 */

import type { RetailProduct } from "@/lib/retail/types";
import { applyStockDeltas, lowStockItems, type LowStockItem } from "./stock.ts";
import { totalStockOf } from "./catalog-ops.ts";

const round3 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * 庫存健康度分級。
 *
 * ⚠️ 唔追蹤庫存（`trackStock === false`）嘅商品一律當 `"untracked"`，
 * **唔可以**當成「無限庫存」或者「缺貨」—— 兩者都會製造假警報。
 */
export type StockHealth = "out" | "low" | "ok" | "untracked";

export function stockHealthOf(
  product: RetailProduct,
  variantId?: string,
  reorderLevel?: number,
): StockHealth {
  if (!product.trackStock) return "untracked";
  const qty = round3(totalStockOf(product, variantId));
  if (qty <= 0) return "out";
  const threshold = round3(
    num(reorderLevel ?? (variantId ? undefined : product.reorderLevel)),
  );
  if (threshold > 0 && qty <= threshold) return "low";
  return "ok";
}

/** 一個庫存列（可能係母體商品，亦可能係某個變體） */
export interface InventoryRow {
  productId: string;
  variantId?: string;
  /** 顯示名（有變體時已接上「· 黑 / L」） */
  label: string;
  categoryId: string;
  unit: string;
  qty: number;
  reorderLevel: number;
  /** 有變體商品嘅母體 = true（母體數字只作參考，唔可以直接改） */
  isParent: boolean;
  health: StockHealth;
  /** 成本 × 數量；冇成本 = 0 */
  stockValue: number;
  isActive: boolean;
}

/**
 * 攤平所有商品成為庫存列。
 *
 * 有變體商品**逐個變體出列**，母體列標記 `isParent: true`（UI 要禁止直接改母體）。
 * 稱重商品嘅 `qty` 係 kg（唔係件）—— 單位由 `unit` 表達，UI 要一齊顯示。
 */
export function inventoryRows(
  products: readonly RetailProduct[],
  opts: { includeInactive?: boolean; includeUntracked?: boolean } = {},
): InventoryRow[] {
  const out: InventoryRow[] = [];
  for (const p of products ?? []) {
    if (!opts.includeInactive && p.isActive === false) continue;
    if (!opts.includeUntracked && !p.trackStock) continue;

    const cost = num(p.cost);
    const threshold = num(p.reorderLevel);
    const variants = (p.variants ?? []).filter((v) => opts.includeInactive || v.isActive !== false);

    if (variants.length > 0) {
      for (const v of variants) {
        const qty = round3(num(v.stockQty));
        out.push({
          productId: p.id,
          variantId: v.id,
          label: `${p.name}${v.label ? ` · ${v.label}` : ""}`,
          categoryId: p.categoryId,
          unit: p.unit,
          qty,
          reorderLevel: num(v.reorderLevel ?? threshold),
          isParent: false,
          health: stockHealthOf(p, v.id, num(v.reorderLevel ?? threshold)),
          stockValue: round3(qty * cost),
          isActive: p.isActive !== false,
        });
      }
      // 母體列（只作參考；唔追蹤庫存時 qty 無意義，但仍然出列以便睇總值）
      const parentQty = round3(num(p.stockQty));
      out.push({
        productId: p.id,
        label: `${p.name}（母體 · 只作參考）`,
        categoryId: p.categoryId,
        unit: p.unit,
        qty: parentQty,
        reorderLevel: threshold,
        isParent: true,
        health: "ok",
        stockValue: round3(parentQty * cost),
        isActive: p.isActive !== false,
      });
      continue;
    }

    const qty = round3(num(p.stockQty));
    out.push({
      productId: p.id,
      label: p.name,
      categoryId: p.categoryId,
      unit: p.unit,
      qty,
      reorderLevel: threshold,
      isParent: false,
      health: stockHealthOf(p),
      stockValue: round3(qty * cost),
      isActive: p.isActive !== false,
    });
  }
  return out;
}

export interface InventorySummary {
  /** 有追蹤庫存嘅商品（母體 + 變體）總列數 */
  trackedRows: number;
  skuCount: number;
  outCount: number;
  lowCount: number;
  /** 庫存總值（成本價計）；冇填成本嘅商品貢獻 0 */
  totalValue: number;
  /** 有幾多商品完全冇填成本（庫存值會偏低，UI 要提示） */
  missingCostCount: number;
}

export function inventorySummary(products: readonly RetailProduct[]): InventorySummary {
  const rows = inventoryRows(products);
  let totalValue = 0;
  let outCount = 0;
  let lowCount = 0;
  for (const r of rows) {
    totalValue += r.stockValue;
    if (r.health === "out") outCount += 1;
    else if (r.health === "low") lowCount += 1;
  }
  const missingCostCount = (products ?? []).filter(
    (p) => p.trackStock && p.isActive !== false && (p.cost == null || num(p.cost) <= 0),
  ).length;
  return {
    trackedRows: rows.length,
    skuCount: new Set(rows.map((r) => (r.variantId ? `${r.productId}::${r.variantId}` : r.productId))).size,
    outCount,
    lowCount,
    totalValue: round3(totalValue),
    missingCostCount,
  };
}

/** 補貨建議：補到警戒線之上，並加一個安全緩衝（預設補到警戒線 × 2） */
export interface ReplenishSuggestion {
  productId: string;
  variantId?: string;
  label: string;
  /** 計量單位（稱重商品為 kg → 建議量亦係 kg） */
  unit: string;
  qty: number;
  reorderLevel: number;
  severity: "out" | "low";
  /** 建議補貨量（補到 target 為止；target 至少 1） */
  suggestQty: number;
  /** 建議補到嘅目標量 */
  targetQty: number;
}

/**
 * 由缺貨 / 低庫存清單計出補貨建議。
 *
 * 目標量 = `max(1, 警戒線 × multiplier)`；若警戒線係 0（冇設）→ 目標 1。
 * ⚠️ 稱重商品嘅單位係 kg → `suggestQty` 亦係 kg，呼叫端要跟 `unit` 顯示。
 */
export function replenishSuggestions(
  products: readonly RetailProduct[],
  multiplier = 2,
): ReplenishSuggestion[] {
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 2;
  const byKey = new Map(products.map((p) => [p.id, p]));

  return lowStockItems(products).map((item: LowStockItem) => {
    const p = byKey.get(item.productId);
    const target = Math.max(1, Math.ceil(item.reorderLevel * m));
    return {
      productId: item.productId,
      variantId: item.variantId,
      label: item.label,
      unit: p?.unit ?? "",
      qty: item.qty,
      reorderLevel: item.reorderLevel,
      severity: item.severity,
      targetQty: target,
      suggestQty: round3(Math.max(0, target - item.qty)),
    };
  });
}

export interface StockEditRow {
  productId: string;
  variantId?: string;
  label: string;
  before: number;
  after: number;
  /** 正數 = 盤盈，負數 = 盤虧 */
  diff: number;
}

export interface InventoryApplyResult {
  products: RetailProduct[];
  edits: StockEditRow[];
  skipped: Array<{ productId: string; variantId?: string; reason: string }>;
}

/**
 * 批量設定庫存（盤點用）。
 *
 * 輸入係「目標數量」而唔係「delta」—— 盤點係**絕對值**語義（數到幾多就係幾多），
 * 用 delta 會令重複提交變成累加（好易錯）。
 *
 * ⚠️ 母體（有變體商品）一律跳過：改母體數字唔會影響真實庫存，只會製造混亂。
 */
export function applyInventoryCounts(
  products: readonly RetailProduct[],
  counts: readonly { productId: string; variantId?: string; qty: number }[],
): InventoryApplyResult {
  const skipped: InventoryApplyResult["skipped"] = [];
  const deltas: Array<{ productId: string; variantId?: string; delta: number }> = [];

  // 冇任何改動 → 原樣回傳（保留原 reference，避免無謂 re-render）
  if (!counts || counts.length === 0) {
    return { products: products as RetailProduct[], edits: [], skipped };
  }
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const c of counts ?? []) {
    const p = byId.get(c.productId);
    if (!p) {
      skipped.push({ productId: c.productId, variantId: c.variantId, reason: "not-found" });
      continue;
    }
    if (!p.trackStock) {
      skipped.push({ productId: c.productId, variantId: c.variantId, reason: "no-track" });
      continue;
    }
    const hasVariants = (p.variants ?? []).length > 0;
    if (hasVariants && !c.variantId) {
      skipped.push({ productId: c.productId, reason: "parent-of-variant" });
      continue;
    }
    const before = round3(c.variantId ? num((p.variants ?? []).find((v) => v.id === c.variantId)?.stockQty) : num(p.stockQty));
    const after = Math.max(0, round3(num(c.qty)));
    if (Math.abs(after - before) < 1e-9) continue;
    deltas.push({ productId: c.productId, variantId: c.variantId, delta: round3(after - before) });
  }

  const applied = applyStockDeltas(products, deltas);
  // 用 applyStockDeltas 嘅 changes 做審計（已經帶 before / after，唔另計一次）
  const edits: StockEditRow[] = applied.changes.map((c) => ({
    productId: c.productId,
    variantId: c.variantId,
    label: c.label,
    before: c.before,
    after: c.after,
    diff: c.delta,
  }));

  return { products: applied.products, edits, skipped };
}

/**
 * 匯出盤點表（CSV 文字）。
 *
 * 只有**追蹤庫存**嘅列會出 —— 否則匯入返去會多一堆無意義嘅 0。
 * 欄位刻意用中文表頭，令商家可以直接喺 Excel 改完再匯入（配合 `csv-import.ts`）。
 */
export function inventoryToCsv(products: readonly RetailProduct[]): string {
  const rows = inventoryRows(products);
  const header = "商品ID,變體ID,商品名,分類,單位,現有庫存,警戒線";
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = rows.map((r) =>
    [
      esc(r.productId),
      esc(r.variantId ?? ""),
      esc(r.label),
      esc(r.categoryId),
      esc(r.unit),
      String(r.qty),
      String(r.reorderLevel),
    ].join(","),
  );
  return [header, ...lines].join("\n");
}
