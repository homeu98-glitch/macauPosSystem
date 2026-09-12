/**
 * 零售商品條碼索引 + 掃碼解析 —— **純函式，零 runtime 依賴**。
 *
 * ⚠️ 同層模組之間嘅 runtime import 一定要用**相對路徑 + 顯式 `.ts`**
 * （`./weighed-barcode.ts`）。用 `@/...` 會令 `node --test` 載入唔到
 * （ERR_MODULE_NOT_FOUND）。repo 已有先例：`src/lib/pos/quick-labels.ts`、`src/lib/kds/*`。
 *
 * 【設計】一次建索引（`createCatalog`），每次掃碼只係 Map lookup。
 * 「一商品多條碼」係刻意支援嘅（廠碼 + 店內自編碼 + 舊包裝碼），
 * 索引係 `barcode → productId`（**多對一**：多個條碼指向同一商品）。
 */

import type {
  RetailProduct,
  RetailVariant,
  ScannedHit,
  WeighedBarcodeRule,
} from "@/lib/retail/types";
import { normalizeScanInput, parseWeighedBarcode } from "./weighed-barcode.ts";

export interface BarcodeEntry {
  productId: string;
  /** 掃到嘅係變體條碼時有值 */
  variantId?: string;
  /** 係唔係商品嘅主條碼（供顯示 / 除錯；額外條碼同變體條碼 = false） */
  primary: boolean;
}

/**
 * 資料衝突（兩件商品撞同一個條碼 / PLU）。
 *
 * 🔴 **一定要報出嚟，唔可以靜默取其一**：撞碼 = 掃 A 收 B 嘅錢。
 * 設定頁同 CSV 匯入預覽都要顯示呢個清單。
 */
export interface CatalogConflict {
  kind: "barcode" | "plu";
  code: string;
  productIds: string[];
}

export interface BarcodeIndex {
  /** 條碼 → 商品（+變體） */
  byBarcode: Map<string, BarcodeEntry>;
  /** PLU → productId（變重條碼靠呢個反查商品） */
  byPlu: Map<string, string>;
}

export interface RetailCatalog {
  index: BarcodeIndex;
  byId: Map<string, RetailProduct>;
  conflicts: CatalogConflict[];
  /** 有效商品數（已剔除 `isActive === false`） */
  activeCount: number;
}

/** 商品係咪可以賣（未停用） */
export function isSellable(product: Pick<RetailProduct, "isActive">): boolean {
  return product.isActive !== false;
}

/** 變體係咪可以賣 */
export function isVariantSellable(variant: Pick<RetailVariant, "isActive">): boolean {
  return variant.isActive !== false;
}

/**
 * 建立索引。
 *
 * 撞碼處理：**先入者為準**（`byBarcode` 保留第一個），同時把**所有**涉及嘅 productId
 * 記入 `conflicts` 交畀 UI 提示。唔會覆寫 —— 覆寫會令問題更難追。
 */
export function createCatalog(products: readonly RetailProduct[]): RetailCatalog {
  const byBarcode = new Map<string, BarcodeEntry>();
  const byPlu = new Map<string, string>();
  const byId = new Map<string, RetailProduct>();

  // code → 所有聲稱擁有佢嘅 productId（用嚟捉撞碼）
  const barcodeOwners = new Map<string, string[]>();
  const pluOwners = new Map<string, string[]>();

  let activeCount = 0;

  const claim = (
    raw: string | undefined,
    entry: BarcodeEntry,
    owners: Map<string, string[]>,
  ) => {
    const code = normalizeScanInput(raw);
    if (!code) return;
    const list = owners.get(code);
    if (list) {
      if (!list.includes(entry.productId)) list.push(entry.productId);
    } else {
      owners.set(code, [entry.productId]);
    }
    if (!byBarcode.has(code)) byBarcode.set(code, entry);
  };

  for (const product of products ?? []) {
    if (!isSellable(product)) continue;
    activeCount += 1;
    byId.set(product.id, product);

    claim(product.barcode, { productId: product.id, primary: true }, barcodeOwners);
    for (const b of product.extraBarcodes ?? []) {
      claim(b, { productId: product.id, primary: false }, barcodeOwners);
    }
    for (const v of product.variants ?? []) {
      if (!isVariantSellable(v)) continue;
      claim(v.barcode, { productId: product.id, variantId: v.id, primary: false }, barcodeOwners);
    }

    const plu = normalizeScanInput(product.plu);
    if (plu) {
      const list = pluOwners.get(plu);
      if (list) list.push(product.id);
      else pluOwners.set(plu, [product.id]);
      if (!byPlu.has(plu)) byPlu.set(plu, product.id);
    }
  }

  const conflicts: CatalogConflict[] = [];
  for (const [code, ids] of barcodeOwners) {
    if (ids.length > 1) conflicts.push({ kind: "barcode", code, productIds: ids });
  }
  for (const [code, ids] of pluOwners) {
    if (ids.length > 1) conflicts.push({ kind: "plu", code, productIds: ids });
  }

  return { index: { byBarcode, byPlu }, byId, conflicts, activeCount };
}

/** 由商品陣列直接解析（唔想自己管 catalog 時嘅方便版；每次都會重建索引） */
export function resolveScannedCodeIn(
  code: string,
  products: readonly RetailProduct[],
  rules: readonly WeighedBarcodeRule[] = [],
): ScannedHit {
  return resolveScannedCode(code, createCatalog(products), rules);
}

/**
 * 解析一次掃碼輸入。
 *
 * 次序**好重要**：
 *   ① 變重碼優先 —— EAN-13 嘅 `2x` 開頭本來就係「店內自編 / 秤重」保留區間，
 *      若先查商品索引，一間同時有「自編碼 2 開頭商品」同「秤標籤」嘅店就會撞。
 *   ② 再查商品條碼索引（含變體）。
 *   ③ 都唔中 → `unknown`（呼叫端**必須**響鈴 + 提示，唔可以靜默）。
 */
export function resolveScannedCode(
  code: string | null | undefined,
  catalog: RetailCatalog,
  rules: readonly WeighedBarcodeRule[] = [],
): ScannedHit {
  const norm = normalizeScanInput(code);
  if (!norm) return { kind: "unknown", code: "" };

  // ① 變重碼（秤標籤）
  const weighed = parseWeighedBarcode(norm, rules);
  if (weighed) {
    const productId = catalog.index.byPlu.get(weighed.plu);
    const product = productId ? catalog.byId.get(productId) : undefined;
    return { kind: "weighed", code: norm, weighed, product };
  }

  // ② 商品條碼（含變體條碼）
  const entry = catalog.index.byBarcode.get(norm);
  if (entry) {
    const product = catalog.byId.get(entry.productId);
    if (product) {
      const variant = entry.variantId
        ? (product.variants ?? []).find((v) => v.id === entry.variantId)
        : undefined;
      return { kind: "product", code: norm, product, variant };
    }
  }

  // ③ 唔認得
  return { kind: "unknown", code: norm };
}

/** 認得到嘅掃碼結果（商品 或 變重碼） */
export type KnownScannedHit = Exclude<ScannedHit, { kind: "unknown" }>;

/**
 * 掃碼結果係咪「認得到」，供 UI 判斷要唔要響鈴。
 *
 * 刻意做 **type guard**（`hit is KnownScannedHit`）而唔係普通 `boolean` ——
 * 咁樣呼叫端 `if (!isScannedHit(hit)) return;` 之後 TS 就窄化得到 `product` / `weighed`，
 * 唔使每個 call site 各自寫一次 `as`。
 */
export function isScannedHit(hit: ScannedHit): hit is KnownScannedHit {
  return hit.kind !== "unknown";
}

/**
 * 建議下一個可用嘅店內自編碼（「2」開頭）。
 *
 * 用途：無廠碼散裝商品補一個可掃條碼。
 * ⚠️ 一定要**避開已用嘅碼**，亦要同秤重前綴區間（20–29）保持距離 ——
 * 所以預設由 `2000000000000` 段開始，而秤重碼通常係 `21/22` + 5 位 PLU。
 */
export function nextInternalBarcode(
  catalog: RetailCatalog,
  start = 2000000000000,
): string {
  let n = start;
  const used = catalog.index.byBarcode;
  while (used.has(String(n))) n += 1;
  return String(n);
}
