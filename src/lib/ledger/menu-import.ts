import { LedgerMenuCategory, LedgerMenuProduct, LedgerOrderMenu } from "@/lib/ledger/menu";
import { SoldOutState } from "@/lib/storage";
import { MenuCategory, MenuItem, PosBootstrap } from "@/lib/types";

export const LEDGER_CATEGORY_ID_PREFIX = "ledger-cat-";
export const LEDGER_MENU_ITEM_ID_PREFIX = "ledger-";

export function toLedgerCategoryId(rawId: string): string {
  return `${LEDGER_CATEGORY_ID_PREFIX}${rawId}`;
}

export function toLedgerMenuItemId(rawId: string): string {
  return `${LEDGER_MENU_ITEM_ID_PREFIX}${rawId}`;
}

export type LedgerMenuImportPreview = {
  enabled: boolean;
  openNow: boolean;
  categoriesAdded: number;
  categoriesUpdated: number;
  itemsAdded: number;
  itemsUpdated: number;
  soldOutCount: number;
  inStockCount: number;
  ledgerCategoryCount: number;
  ledgerProductCount: number;
};

export type LedgerMenuImportStats = LedgerMenuImportPreview;

function buildCategoryMaps(categories: MenuCategory[]) {
  return new Map(categories.map((row) => [row.id, row]));
}

function buildItemMaps(items: MenuItem[]) {
  return new Map(items.map((row) => [row.id, row]));
}

export function previewLedgerMenuImport(
  bootstrap: PosBootstrap,
  ledger: LedgerOrderMenu,
): LedgerMenuImportPreview {
  const categoryById = buildCategoryMaps(bootstrap.categories);
  const itemById = buildItemMaps(bootstrap.menuItems);

  let categoriesAdded = 0;
  let categoriesUpdated = 0;
  let itemsAdded = 0;
  let itemsUpdated = 0;
  let soldOutCount = 0;
  let inStockCount = 0;

  for (const category of ledger.categories) {
    const posId = toLedgerCategoryId(category.id);
    const existing = categoryById.get(posId);
    if (!existing) categoriesAdded += 1;
    else if (existing.name !== category.name) categoriesUpdated += 1;
  }

  for (const product of ledger.products) {
    const posId = toLedgerMenuItemId(product.id);
    if (itemById.has(posId)) itemsUpdated += 1;
    else itemsAdded += 1;
    if (product.isSoldOut) soldOutCount += 1;
    else inStockCount += 1;
  }

  return {
    enabled: ledger.enabled,
    openNow: ledger.openNow,
    categoriesAdded,
    categoriesUpdated,
    itemsAdded,
    itemsUpdated,
    soldOutCount,
    inStockCount,
    ledgerCategoryCount: ledger.categories.length,
    ledgerProductCount: ledger.products.length,
  };
}

function mapLedgerCategory(category: LedgerMenuCategory): MenuCategory {
  return {
    id: toLedgerCategoryId(category.id),
    name: category.name,
  };
}

function mapLedgerProduct(product: LedgerMenuProduct, existing?: MenuItem): MenuItem {
  return {
    id: toLedgerMenuItemId(product.id),
    categoryId: toLedgerCategoryId(product.categoryId),
    name: product.name,
    price: product.priceMop,
    printerGroup: existing?.printerGroup ?? "kitchen",
    specGroups: product.specGroups ?? existing?.specGroups,
  };
}

function applySoldOutForProduct(
  soldOut: SoldOutState,
  product: LedgerMenuProduct,
  timestamp: string,
): SoldOutState {
  const itemId = toLedgerMenuItemId(product.id);
  if (product.isSoldOut) {
    return {
      ...soldOut,
      [itemId]: {
        initialQty: soldOut[itemId]?.initialQty ?? 1,
        remainingQty: 0,
        updatedAt: timestamp,
      },
    };
  }
  if (!soldOut[itemId]) return soldOut;
  const next = { ...soldOut };
  delete next[itemId];
  return next;
}

export function mergeLedgerMenuReference(
  bootstrap: PosBootstrap,
  ledger: LedgerOrderMenu,
  soldOutSeed: SoldOutState = {},
): { bootstrap: PosBootstrap; soldOut: SoldOutState; stats: LedgerMenuImportStats } {
  if (!ledger.enabled) {
    throw new Error("Ledger 線上點餐未啟用，無法匯入菜單。");
  }

  const stats = previewLedgerMenuImport(bootstrap, ledger);
  const timestamp = new Date().toISOString();
  const existingItems = buildItemMaps(bootstrap.menuItems);

  const localCategories = bootstrap.categories.filter((row) => !row.id.startsWith(LEDGER_CATEGORY_ID_PREFIX));
  const localItems = bootstrap.menuItems.filter((row) => !row.id.startsWith(LEDGER_MENU_ITEM_ID_PREFIX));

  const ledgerCategories = ledger.categories.map(mapLedgerCategory);
  const ledgerItems = ledger.products.map((product) =>
    mapLedgerProduct(product, existingItems.get(toLedgerMenuItemId(product.id))),
  );

  let soldOut = { ...soldOutSeed };
  for (const product of ledger.products) {
    soldOut = applySoldOutForProduct(soldOut, product, timestamp);
  }

  return {
    bootstrap: {
      ...bootstrap,
      categories: [...localCategories, ...ledgerCategories],
      menuItems: [...localItems, ...ledgerItems],
      lastUpdatedAt: timestamp,
    },
    soldOut,
    stats,
  };
}
