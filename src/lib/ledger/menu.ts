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
  priceMop: number;
  isSoldOut: boolean;
  specGroups?: MenuSpecGroup[];
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

function resolveProductPriceMop(record: UnknownRecord): number {
  const avos =
    record.price_avos ??
    record.base_price_avos ??
    record.unit_price_avos ??
    record.priceAvos ??
    record.basePriceAvos;
  const fromAvos = avosToMop(avos);
  if (fromAvos != null && fromAvos > 0) {
    const promo = Number(record.promo_rate_permille ?? record.promoRatePermille ?? 1000);
    if (promo > 0 && promo < 1000) {
      return Math.round((fromAvos * promo) / 1000);
    }
    return fromAvos;
  }

  const direct = Number(record.price_mop ?? record.priceMop ?? record.price ?? 0);
  return Number.isFinite(direct) ? direct : 0;
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

  return {
    id,
    categoryId,
    name,
    priceMop: resolveProductPriceMop(record),
    isSoldOut: Boolean(record.is_sold_out ?? record.isSoldOut ?? record.sold_out ?? false),
    specGroups: parseLedgerProductSpecGroups(record, menuRoot),
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
