/**
 * 零售庫存扣減 / 回補 —— **純函式，零 runtime 依賴**。
 *
 * 2026-09-12 商家定案：**要即時扣減庫存**（所以呢部分由 Phase 2 拉入 Phase 1）。
 *
 * 【重要口徑】
 *   - 普通商品：扣 `quantity`（件）
 *   - **稱重商品：扣 `weightKg`（kg）**，唔係扣 1 —— 扣錯單位會令庫存永遠錯
 *   - 有變體商品：扣**變體**嘅庫存，母體 `stockQty` 只作參考
 *
 * 【唔可以靜默】扣到唔夠 → `after` 夾喺 0，但**一定要報 `shortfall`**
 * （超賣係真實現象：盤點未做、秤有誤差）。UI 要提示，唔可以靜靜變負數或者靜靜拒絕。
 */

import type { RetailProduct, RetailVariant } from "@/lib/retail/types";
import type { RetailCartLine } from "./retail-cart.ts";

const round3 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000;

export interface StockTarget {
  productId: string;
  /** 有變體商品一定要指明 */
  variantId?: string;
}

export interface StockDelta extends StockTarget {
  /** 正數 = 入庫 / 回補；負數 = 扣減 */
  delta: number;
}

export interface StockChange extends StockTarget {
  label: string;
  before: number;
  after: number;
  delta: number;
  /** 扣唔夠嘅差額（正數）→ 超賣，UI 要提示 */
  shortfall: number;
}

export type StockSkipReason = "not-found" | "no-track" | "no-variant" | "inactive";

export interface StockApplyResult {
  /** 只會有改動過嘅商品被換成新物件（其餘保留原 reference，方便 React 比對） */
  products: RetailProduct[];
  changes: StockChange[];
  skipped: Array<StockTarget & { reason: StockSkipReason }>;
}

/** 索引鍵（同一個商品嘅唔同變體分開計） */
export function stockKey(target: StockTarget): string {
  return target.variantId ? `${target.productId}::${target.variantId}` : target.productId;
}

/** 目前庫存（母體 / 變體）；唔追蹤庫存或對唔中 → undefined */
export function currentStock(
  product: RetailProduct,
  variantId?: string,
): number | undefined {
  if (!product.trackStock) return undefined;
  if (variantId) {
    const v = (product.variants ?? []).find((x) => x.id === variantId);
    return v?.stockQty;
  }
  return product.stockQty;
}

/** 將同一個目標嘅多筆 delta 合併（同一商品掃兩次唔應該做兩次物件複製） */
export function mergeStockDeltas(deltas: readonly StockDelta[]): StockDelta[] {
  const m = new Map<string, StockDelta>();
  for (const d of deltas ?? []) {
    const k = stockKey(d);
    const prev = m.get(k);
    if (prev) prev.delta = round3(prev.delta + d.delta);
    else m.set(k, { ...d, delta: round3(d.delta) });
  }
  return Array.from(m.values()).filter((d) => Math.abs(d.delta) > 1e-9);
}

function variantLabel(v: RetailVariant | undefined): string {
  return v?.label ?? "";
}

/**
 * 套用庫存變動。
 *
 * 回傳新陣列；只有真正改動過嘅商品會換新物件。
 */
export function applyStockDeltas(
  products: readonly RetailProduct[],
  deltas: readonly StockDelta[],
): StockApplyResult {
  const merged = mergeStockDeltas(deltas);
  const changes: StockChange[] = [];
  const skipped: StockApplyResult["skipped"] = [];

  // 先 index by productId
  const targetByProduct = new Map<string, StockDelta[]>();
  for (const d of merged) {
    const list = targetByProduct.get(d.productId);
    if (list) list.push(d);
    else targetByProduct.set(d.productId, [d]);
  }

  const nextProducts = (products ?? []).map((product) => {
    const myDeltas = targetByProduct.get(product.id);
    if (!myDeltas || myDeltas.length === 0) return product;

    if (product.isActive === false) {
      for (const d of myDeltas) skipped.push({ ...d, reason: "inactive" });
      return product;
    }
    if (!product.trackStock) {
      for (const d of myDeltas) skipped.push({ ...d, reason: "no-track" });
      return product;
    }

    let variants = product.variants;
    let stockQty = product.stockQty;
    let touched = false;

    for (const d of myDeltas) {
      if (d.variantId) {
        const idx = (variants ?? []).findIndex((v) => v.id === d.variantId);
        if (idx < 0) {
          skipped.push({ ...d, reason: "no-variant" });
          continue;
        }
        const v = variants![idx];
        const before = round3(Number(v.stockQty ?? 0));
        const raw = round3(before + d.delta);
        const after = Math.max(0, raw);
        const label = `${product.name}${variantLabel(v) ? ` · ${variantLabel(v)}` : ""}`;
        changes.push({
          productId: product.id,
          variantId: v.id,
          label,
          before,
          after,
          delta: round3(after - before),
          shortfall: raw < 0 ? round3(-raw) : 0,
        });
        variants = variants!.map((x, i) => (i === idx ? { ...x, stockQty: after } : x));
        touched = true;
      } else {
        if ((product.variants ?? []).length > 0) {
          // 有變體商品唔可以用母體數字扣 —— 靜默扣母體 = 帳實不符
          skipped.push({ ...d, reason: "no-variant" });
          continue;
        }
        const before = round3(Number(stockQty ?? 0));
        const raw = round3(before + d.delta);
        const after = Math.max(0, raw);
        changes.push({
          productId: product.id,
          label: product.name,
          before,
          after,
          delta: round3(after - before),
          shortfall: raw < 0 ? round3(-raw) : 0,
        });
        stockQty = after;
        touched = true;
      }
    }

    if (!touched) return product;
    return { ...product, stockQty, ...(variants ? { variants } : {}) };
  });

  // 對唔中商品（已刪 / 停售 / 唔喺呢批）
  const knownIds = new Set((products ?? []).map((p) => p.id));
  for (const d of merged) {
    if (!knownIds.has(d.productId)) skipped.push({ ...d, reason: "not-found" });
  }

  return { products: nextProducts, changes, skipped };
}

/** 由購物車行計出要扣幾多（稱重商品扣重量，唔係扣 1） */
export function stockDeltasForLines(
  lines: readonly RetailCartLine[],
  sign: 1 | -1 = -1,
): StockDelta[] {
  const out: StockDelta[] = [];
  for (const line of lines ?? []) {
    const remove = line.isWeighed
      ? Math.max(0, Number(line.weightKg ?? 0))
      : Math.max(0, Number(line.quantity ?? 0));
    if (remove <= 0) continue;
    out.push({
      productId: line.productId,
      variantId: line.variantId,
      delta: round3(sign * remove),
    });
  }
  return mergeStockDeltas(out);
}

/** 售出扣減 */
export function deductStockForLines(
  products: readonly RetailProduct[],
  lines: readonly RetailCartLine[],
): StockApplyResult {
  return applyStockDeltas(products, stockDeltasForLines(lines, -1));
}

/** 退貨回補（按重量回補，唔會只退金額） */
export function restoreStockForLines(
  products: readonly RetailProduct[],
  lines: readonly RetailCartLine[],
): StockApplyResult {
  return applyStockDeltas(products, stockDeltasForLines(lines, 1));
}

export interface LowStockItem {
  productId: string;
  variantId?: string;
  label: string;
  qty: number;
  /** 警戒線（未設定 = 0，即係「冇貨才提示」） */
  reorderLevel: number;
  severity: "out" | "low";
}

/**
 * 缺貨 / 低庫存清單。
 *
 * 有變體商品**逐個變體列**（因為缺一個碼就要補貨，唔可以只報總數）。
 * 唔追蹤庫存嘅商品一律唔列（否則會出現一堆永遠「低庫存」嘅假警報）。
 */
export function lowStockItems(products: readonly RetailProduct[]): LowStockItem[] {
  const out: LowStockItem[] = [];
  for (const p of products ?? []) {
    if (p.isActive === false || !p.trackStock) continue;
    const threshold = Number(p.reorderLevel ?? 0);

    const variants = p.variants ?? [];
    if (variants.length > 0) {
      for (const v of variants) {
        if (v.isActive === false) continue;
        const qty = round3(Number(v.stockQty ?? 0));
        // 變體自己嘅警戒線優先；缺省才跟母體（服裝每個尺碼補貨點唔同）
        const vt = Number(v.reorderLevel ?? threshold);
        if (qty <= vt) {
          out.push({
            productId: p.id,
            variantId: v.id,
            label: `${p.name}${v.label ? ` · ${v.label}` : ""}`,
            qty,
            reorderLevel: vt,
            severity: qty <= 0 ? "out" : "low",
          });
        }
      }
      continue;
    }

    const qty = round3(Number(p.stockQty ?? 0));
    if (qty <= threshold) {
      out.push({
        productId: p.id,
        label: p.name,
        qty,
        reorderLevel: threshold,
        severity: qty <= 0 ? "out" : "low",
      });
    }
  }
  // 缺貨優先，其次數量少嘅先
  return out.sort((a, b) => (a.severity === b.severity ? a.qty - b.qty : a.severity === "out" ? -1 : 1));
}

/** 商品（或變體）可唔可以賣指定數量 —— 缺貨商品唔應該入到購物車 */
export function canFulfill(
  product: RetailProduct,
  qty: number,
  variantId?: string,
): boolean {
  if (!product.trackStock) return true;
  const have = currentStock(product, variantId);
  if (have == null) return true;
  return round3(have) >= round3(qty);
}
