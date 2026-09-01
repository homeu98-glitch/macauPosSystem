"use client";

import { parseLedgerProductSpecGroups } from "@/lib/ledger/menu-spec";
import { MenuSpecGroup } from "@/lib/types";
import { getLedgerMerchantId } from "@/lib/ledger/session";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? (value as UnknownRecord) : null;
}

export type LedgerMenuCategory = {
  id: string;
  name: string;
  sortOrder: number;
};

export type LedgerMenuProduct = {
  id: string;
  categoryId: string;
  name: string;
  /**
   * 客人實際畀嘅價（MOP，已折後）。
   * 即 Ledger `price_avos` 直接除 100；若菜品有 promo，佢已經係折後價。
   */
  priceMop: number;
  /**
   * 菜品原價（MOP，未折扣）。可選。
   * 由 Ledger 嘅 `promo_rate_permille` × `price_avos` 倒推返出嚟；
   * 冇 promo 時省略（= `priceMop`）。
   * POS `MenuItem.originalPrice` 食呢個 field — 用嚟喺菜品列表 / 揀菜 UI
   * 顯示「~~原價~~ 折後價」。
   */
  originalPriceMop?: number;
  /**
   * 菜品折扣百分比（0-100；80 = 8折 = 收原價嘅 80%）。
   * 從 Ledger `promo_rate_permille` 除 10 換算（800 / 10 = 80）。
   * 100 = 冇折扣；省略 = 未知 / 冇折扣。
   */
  discountRate?: number;
  isSoldOut: boolean;
  specGroups?: MenuSpecGroup[];
  image?: string;
};

export type LedgerOrderMenu = {
  enabled: boolean;
  openNow: boolean;
  categories: LedgerMenuCategory[];
  products: LedgerMenuProduct[];
};

function avosToMop(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n) / 100;
}

function resolveProductImage(record: UnknownRecord): string | undefined {
  const raw =
    record.image ??
    record.image_url ??
    record.imageUrl ??
    record.photo ??
    record.photo_url ??
    record.img ??
    record.thumbnail ??
    record.picture;
  return raw ? String(raw) : undefined;
}

/**
 * 從 Ledger record 抽出折扣百分比（0-100）。
 * - Ledger `promo_rate_permille` = 1000 = 無折扣；800 = 8折；850 = 85折。
 * - 範圍收窄：只接受 (0, 1000)；1000 同以上一律視為無折扣（POS rate = 100）。
 * - 唔接受負數 / 非數字 / 超過 1000 → 視為無折扣。
 */
function resolveProductDiscountRate(record: UnknownRecord): number | undefined {
  const raw = record.promo_rate_permille ?? record.promoRatePermille;
  const permille = Number(raw);
  if (!Number.isFinite(permille) || permille <= 0 || permille >= 1000) return undefined;
  return Math.round(permille) / 10;
}

function resolveProductPriceMop(record: UnknownRecord): {
  /** 客人實際畀嘅價（MOP，已含折扣） */
  priceMop: number;
  /** 菜品原價（MOP，未折扣）。冇就省略。 */
  originalPriceMop?: number;
  /** 菜品折扣百分比（0-100）。冇就省略。 */
  discountRate?: number;
} {
  const discountRate = resolveProductDiscountRate(record);

  const avos =
    record.price_avos ??
    record.base_price_avos ??
    record.unit_price_avos ??
    record.priceAvos ??
    record.basePriceAvos;
  const fromAvos = avosToMop(avos);
  if (fromAvos != null && fromAvos > 0) {
    // 有折扣 → 算出原價；customer price 照舊用 priceMop（已折後）
    if (discountRate != null && discountRate > 0 && discountRate < 100) {
      const originalPriceMop = Math.round((fromAvos * 100) / discountRate * 100) / 100;
      // 倒推嘅原價可能因為 rounding 同 base_price 唔完全一致；
      // 但反正 POS 菜單顯示用，唔影響對帳（對帳靠 OrderItem.discountRate）。
      // 設只會喺 priceMop 明顯細過原價時先擺 originalPrice（避免傻下 rounding noise）。
      const showOriginal = originalPriceMop > fromAvos + 0.005;
      return {
        priceMop: fromAvos,
        ...(showOriginal ? { originalPriceMop } : {}),
        discountRate,
      };
    }
    return { priceMop: fromAvos };
  }

  const direct = Number(record.price_mop ?? record.priceMop ?? record.price ?? 0);
  return { priceMop: Number.isFinite(direct) ? direct : 0 };
}

function parseCategory(raw: unknown, index: number): LedgerMenuCategory | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = String(record.id ?? record.category_id ?? "").trim();
  const name = String(record.name ?? record.category_name ?? record.title ?? "").trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    sortOrder: Number(record.sort_order ?? record.sortOrder ?? index),
  };
}

function parseProduct(raw: unknown, menuRoot: UnknownRecord | null): LedgerMenuProduct | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = String(record.id ?? record.product_id ?? record.menu_item_id ?? "").trim();
  const categoryId = String(record.category_id ?? record.categoryId ?? "").trim();
  const name = String(record.name ?? record.product_name ?? record.title ?? "").trim();
  if (!id || !categoryId || !name) return null;

  const price = resolveProductPriceMop(record);

  return {
    id,
    categoryId,
    name,
    priceMop: price.priceMop,
    originalPriceMop: price.originalPriceMop,
    discountRate: price.discountRate,
    isSoldOut: Boolean(record.is_sold_out ?? record.isSoldOut ?? record.sold_out ?? false),
    specGroups: parseLedgerProductSpecGroups(record, menuRoot),
    image: resolveProductImage(record),
  };
}

export function parseLedgerOrderMenu(data: unknown): LedgerOrderMenu {
  const record = asRecord(data) ?? {};
  const menuRoot = record;
  const categoriesRaw = Array.isArray(record.categories) ? record.categories : [];
  const productsRaw = Array.isArray(record.products) ? record.products : [];

  const categories = categoriesRaw
    .map((row, index) => parseCategory(row, index))
    .filter((row): row is LedgerMenuCategory => row !== null)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const products = productsRaw
    .map((row) => parseProduct(row, menuRoot))
    .filter((row): row is LedgerMenuProduct => row !== null);

  return {
    enabled: Boolean(record.enabled ?? true),
    openNow: Boolean(record.open_now ?? record.openNow ?? false),
    categories,
    products,
  };
}

export async function fetchLedgerOrderMenu(): Promise<LedgerOrderMenu> {
  const merchantId = getLedgerMerchantId();
  if (!merchantId) {
    throw new Error("尚未登入 Ledger 或缺少 merchantId。");
  }

  const client = getLedgerSupabaseClient();
  if (!client) {
    throw new Error("Ledger Supabase 尚未設定。");
  }

  const { data, error } = await client.rpc("list_merchant_order_menu", {
    p_merchant_id: merchantId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return parseLedgerOrderMenu(data);
}
