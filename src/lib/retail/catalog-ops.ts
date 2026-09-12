/**
 * 零售商品主檔操作 —— **純函式，零 runtime 依賴**。
 *
 * I/O（localStorage）喺 `@/lib/storage`（`loadRetailProducts` / `saveRetailProducts`）；
 * 呢度只做**陣列轉換**，所以可以 `node --test` 直接測。
 *
 * ⚠️ 所有函式都**回傳新陣列**，唔會改傳入嘅（React 要 reference 比對）。
 * 未改動嘅商品保留原 reference，唔會無謂 re-render。
 */

import type { RetailProduct, RetailVariant } from "@/lib/retail/types";
import type { ImportPlan } from "./csv-import.ts";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round3 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000;

/**
 * 穩定排序比較器（code point）。
 *
 * ⚠️ **刻意唔用 `localeCompare`** —— 佢嘅結果跟執行環境嘅 locale / ICU 版本變
 * （Node 同瀏覽器、唔同 OS 都可能唔同）。純函式唔應該有環境依賴，而且會令測試不穩。
 * 收銀台嘅商品排序只需要**穩定一致**，唔需要語言學排序。
 */
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ─────────────────────────────────────────────────────────────
// 查詢
// ─────────────────────────────────────────────────────────────

export function findRetailProduct(
  products: readonly RetailProduct[],
  id: string,
): RetailProduct | undefined {
  return (products ?? []).find((p) => p.id === id);
}

export function findRetailVariant(
  product: RetailProduct | undefined,
  variantId: string,
): RetailVariant | undefined {
  return (product?.variants ?? []).find((v) => v.id === variantId);
}

/** 商品（或指定變體）嘅實際可售總量；有變體 = 各變體相加 */
export function totalStockOf(product: RetailProduct, variantId?: string): number {
  if (variantId) {
    const v = findRetailVariant(product, variantId);
    return round3(num(v?.stockQty));
  }
  const variants = (product.variants ?? []).filter((v) => v.isActive !== false);
  if (variants.length > 0) {
    return round3(variants.reduce((s, v) => s + num(v.stockQty), 0));
  }
  return round3(num(product.stockQty));
}

export function variantCountOf(product: RetailProduct): number {
  return (product?.variants ?? []).filter((v) => v.isActive !== false).length;
}

// ─────────────────────────────────────────────────────────────
// 建立 / 更新 / 刪除
// ─────────────────────────────────────────────────────────────

/** 產生新商品 id（唔用時間戳做唯一鍵嘅一部分，避免同一次批量匯入撞號） */
export function nextProductId(
  products: readonly RetailProduct[],
  prefix = "rp",
): string {
  let max = 0;
  for (const p of products ?? []) {
    const m = /^rp-(\d+)$/.exec(p.id ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  // 同時要避開非 rp-N 格式嘅 id（例如 CSV 帶入嘅自訂 id）
  const used = new Set((products ?? []).map((p) => p.id));
  let n = max + 1;
  while (used.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

/** 新商品嘅安全預設（唔會留 `undefined` 令下游要不停 null check） */
export function emptyProductDraft(storeId?: string, id?: string): RetailProduct {
  return {
    id: id ?? "",
    ...(storeId ? { storeId } : {}),
    name: "",
    categoryId: "",
    price: 0,
    unit: "件",
    trackStock: true,
    stockQty: 0,
    isActive: true,
  };
}

/** 只把「有定義」嘅欄位覆寫過去 —— CSV 冇填嘅欄位唔可以當成清空 */
function mergeDefined<T extends object>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out as T;
}

/** 補齊新商品（借 `emptyProductDraft` 嘅預設） */
export function normalizeNewProduct(
  draft: Partial<RetailProduct> & { name: string },
  products: readonly RetailProduct[],
): RetailProduct {
  const base = emptyProductDraft(draft.storeId, draft.id || nextProductId(products));
  const merged = mergeDefined(base, draft as Partial<RetailProduct>);
  return {
    ...merged,
    id: merged.id || nextProductId(products),
    name: String(merged.name ?? "").trim(),
    price: Math.max(0, num(merged.price)),
    stockQty: merged.stockQty == null ? 0 : round3(num(merged.stockQty)),
    variants: (merged.variants ?? []).map((v) => ({
      ...v,
      stockQty: v.stockQty == null ? 0 : round3(num(v.stockQty)),
    })),
  };
}

export function upsertRetailProduct(
  products: readonly RetailProduct[],
  product: RetailProduct,
): RetailProduct[] {
  const list = [...(products ?? [])];
  const idx = list.findIndex((p) => p.id === product.id);
  if (idx < 0) list.push(product);
  else list[idx] = product;
  return list;
}

export function removeRetailProduct(
  products: readonly RetailProduct[],
  id: string,
): RetailProduct[] {
  return (products ?? []).filter((p) => p.id !== id);
}

export function removeRetailProducts(
  products: readonly RetailProduct[],
  ids: readonly string[],
): RetailProduct[] {
  const set = new Set(ids ?? []);
  return (products ?? []).filter((p) => !set.has(p.id));
}

/** 停售 / 恢復（停售唔刪，保留歷史訂單引用） */
export function setProductActive(
  products: readonly RetailProduct[],
  id: string,
  active: boolean,
): RetailProduct[] {
  return (products ?? []).map((p) => (p.id === id ? { ...p, isActive: active } : p));
}

/** 直接改庫存（盤點 / 收貨用）；有變體商品要指明 variantId */
export function setProductStock(
  products: readonly RetailProduct[],
  id: string,
  qty: number,
  variantId?: string,
): RetailProduct[] {
  const next = Math.max(0, round3(num(qty)));
  return (products ?? []).map((p) => {
    if (p.id !== id) return p;
    if (variantId) {
      return {
        ...p,
        variants: (p.variants ?? []).map((v) => (v.id === variantId ? { ...v, stockQty: next } : v)),
      };
    }
    return { ...p, stockQty: next };
  });
}

// ─────────────────────────────────────────────────────────────
// 搜尋 / 篩選 / 排序
// ─────────────────────────────────────────────────────────────

export interface ProductFilter {
  /** 關鍵字：商品名 / 條碼（含額外條碼）/ PLU / SKU 都搵 */
  keyword?: string;
  categoryId?: string;
  /** 只出低庫存（<= reorderLevel） */
  onlyLowStock?: boolean;
  /** 只出有效商品（預設 true；設 false 就連停售都出） */
  onlyActive?: boolean;
}

/**
 * 收銀台「快速搜尋」用。
 *
 * 排序刻意係「完全匹配優先 → 前綴匹配 → 包含」，因為收銀員打嘅多數係
 * **完整條碼**或者商品名開頭；若純按字串包含排序，打一串數字會撈到一堆無關商品。
 */
export function filterProducts(
  products: readonly RetailProduct[],
  filter: ProductFilter = {},
): RetailProduct[] {
  const onlyActive = filter.onlyActive ?? true;
  const kw = (filter.keyword ?? "").trim().toLowerCase();
  const scored: Array<{ p: RetailProduct; score: number }> = [];

  for (const p of products ?? []) {
    if (onlyActive && p.isActive === false) continue;
    if (filter.categoryId && p.categoryId !== filter.categoryId) continue;
    if (filter.onlyLowStock) {
      const threshold = num(p.reorderLevel);
      const variants = (p.variants ?? []).filter((v) => v.isActive !== false);
      const low =
        variants.length > 0
          ? variants.some((v) => num(v.stockQty) <= num(v.reorderLevel ?? threshold))
          : num(p.stockQty) <= threshold;
      if (!low) continue;
    }

    if (!kw) {
      scored.push({ p, score: 0 });
      continue;
    }

    const codes = [p.barcode, ...(p.extraBarcodes ?? []), p.plu, p.sku]
      .filter(Boolean)
      .map((c) => String(c).toLowerCase());
    const name = String(p.name ?? "").toLowerCase();

    if (codes.some((c) => c === kw)) scored.push({ p, score: 0 });
    else if (codes.some((c) => c.startsWith(kw))) scored.push({ p, score: 1 });
    else if (name === kw) scored.push({ p, score: 0 });
    else if (name.startsWith(kw)) scored.push({ p, score: 1 });
    else if (codes.some((c) => c.includes(kw)) || name.includes(kw)) scored.push({ p, score: 2 });
  }

  return scored
    .sort((a, b) => (a.score !== b.score ? a.score - b.score : byCodePoint(a.p.name, b.p.name)))
    .map((x) => x.p);
}

export type ProductSortMode = "name" | "price" | "stock" | "recent";

export function sortProducts(
  products: readonly RetailProduct[],
  mode: ProductSortMode = "name",
): RetailProduct[] {
  const list = [...(products ?? [])];
  switch (mode) {
    case "price":
      return list.sort((a, b) => num(a.price) - num(b.price));
    case "stock":
      return list.sort((a, b) => totalStockOf(a) - totalStockOf(b));
    case "recent":
      // 冇 updatedAt 欄位時退回 id 降序（新 id 較大）→ 穩定、唔會亂
      return list.sort((a, b) => byCodePoint(String(b.id), String(a.id)));
    default:
      return list.sort((a, b) => byCodePoint(String(a.name), String(b.name)));
  }
}

// ─────────────────────────────────────────────────────────────
// CSV 匯入套用
// ─────────────────────────────────────────────────────────────

export interface ApplyImportResult {
  products: RetailProduct[];
  createdCount: number;
  updatedCount: number;
  /** 更新時對唔中 existing（理論上唔會，但唔可以靜默漏） */
  missing: string[];
}

/**
 * 套用匯入計劃（呼叫端應該喺商家確認計劃之後才叫）。
 *
 * 更新時**只覆寫 CSV 有填嘅欄位** —— `diffFields()` 已經保證 `changedFields` 準確，
 * 但呢度唔靠佢，寧可再保守一次（`mergeDefined` 只覆寫非 `undefined`）。
 */
export function applyImportPlan(
  products: readonly RetailProduct[],
  plan: ImportPlan,
): ApplyImportResult {
  let list = [...(products ?? [])];
  let createdCount = 0;
  let updatedCount = 0;
  const missing: string[] = [];

  for (const row of plan.creates ?? []) {
    list = [...list, normalizeNewProduct(row.product, list)];
    createdCount += 1;
  }

  for (const u of plan.updates ?? []) {
    const idx = list.findIndex((p) => p.id === u.existing.id);
    if (idx < 0) {
      missing.push(u.existing.id);
      continue;
    }
    list[idx] = mergeDefined(list[idx], u.row.product as Partial<RetailProduct>);
    updatedCount += 1;
  }

  return { products: list, createdCount, updatedCount, missing };
}

// ─────────────────────────────────────────────────────────────
// 統計
// ─────────────────────────────────────────────────────────────

export interface RetailProductStats {
  total: number;
  active: number;
  variantCount: number;
  lowStock: number;
  outOfStock: number;
}

/** 商品頁頂部統計（缺貨優先睇） */
export function productStats(products: readonly RetailProduct[]): RetailProductStats {
  let active = 0;
  let variantCount = 0;
  let lowStock = 0;
  let outOfStock = 0;

  for (const p of products ?? []) {
    if (p.isActive === false) continue;
    active += 1;
    variantCount += variantCountOf(p);
    if (!p.trackStock) continue;

    const threshold = num(p.reorderLevel);
    const variants = (p.variants ?? []).filter((v) => v.isActive !== false);
    if (variants.length > 0) {
      for (const v of variants) {
        const q = num(v.stockQty);
        if (q <= 0) outOfStock += 1;
        else if (q <= num(v.reorderLevel ?? threshold)) lowStock += 1;
      }
      continue;
    }
    const q = num(p.stockQty);
    if (q <= 0) outOfStock += 1;
    else if (q <= threshold) lowStock += 1;
  }

  return { total: (products ?? []).length, active, variantCount, lowStock, outOfStock };
}

/** 商品分類清單（由商品推導，唔另設主檔 —— 分類可以由 CSV / 商品編輯自由填） */
export function categoriesOf(products: readonly RetailProduct[]): string[] {
  const set = new Set<string>();
  for (const p of products ?? []) {
    const c = String(p.categoryId ?? "").trim();
    if (c) set.add(c);
  }
  return Array.from(set).sort(byCodePoint);
}
