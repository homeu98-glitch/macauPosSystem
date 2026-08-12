import { LedgerMenuCategory, LedgerMenuProduct, LedgerOrderMenu } from "@/lib/ledger/menu";
import { SoldOutState } from "@/lib/storage";
import { MenuCategory, MenuItem, PosBootstrap } from "@/lib/types";

export const LEDGER_CATEGORY_ID_PREFIX = "ledger-cat-";
export const LEDGER_MENU_ITEM_ID_PREFIX = "ledger-";

export type LedgerMenuImportOptions = {
  /** 刪除非 Ledger 來源的本地分類／菜品（不含 `ledger-` 前綴） */
  removeLocalMenu: boolean;
};

export function toLedgerCategoryId(rawId: string): string {
  return `${LEDGER_CATEGORY_ID_PREFIX}${rawId}`;
}

export function toLedgerMenuItemId(rawId: string): string {
  return `${LEDGER_MENU_ITEM_ID_PREFIX}${rawId}`;
}

export function isLocalMenuCategory(id: string): boolean {
  return !id.startsWith(LEDGER_CATEGORY_ID_PREFIX);
}

export function isLocalMenuItem(id: string): boolean {
  return !id.startsWith(LEDGER_MENU_ITEM_ID_PREFIX);
}

export type LedgerMenuImportPreview = {
  enabled: boolean;
  openNow: boolean;
  removeLocalMenu: boolean;
  categoriesAdded: number;
  categoriesUpdated: number;
  itemsAdded: number;
  itemsUpdated: number;
  soldOutCount: number;
  inStockCount: number;
  ledgerCategoryCount: number;
  ledgerProductCount: number;
  localCategoryCount: number;
  localItemCount: number;
  localCategoriesRemoved: number;
  localItemsRemoved: number;
  specOptionsWithPrice: number;
  specPriceSample: string;
};

export type LedgerMenuImportStats = LedgerMenuImportPreview;

function buildCategoryMaps(categories: MenuCategory[]) {
  return new Map(categories.map((row) => [row.id, row]));
}

function buildItemMaps(items: MenuItem[]) {
  return new Map(items.map((row) => [row.id, row]));
}

function summarizeLedgerSpecPrices(products: LedgerMenuProduct[]) {
  let specOptionsWithPrice = 0;
  let specPriceSample = "";

  for (const product of products) {
    for (const group of product.specGroups ?? []) {
      for (const option of group.options) {
        if (option.priceDelta > 0) {
          specOptionsWithPrice += 1;
          if (!specPriceSample) {
            specPriceSample = `${product.name} · ${group.name}: ${option.label}(+${option.priceDelta})`;
          }
        }
      }
    }
  }

  return { specOptionsWithPrice, specPriceSample };
}

export function previewLedgerMenuImport(
  bootstrap: PosBootstrap,
  ledger: LedgerOrderMenu,
  options: LedgerMenuImportOptions = { removeLocalMenu: false },
): LedgerMenuImportPreview {
  const categoryById = buildCategoryMaps(bootstrap.categories);
  const itemById = buildItemMaps(bootstrap.menuItems);

  const localCategoryCount = bootstrap.categories.filter((row) => isLocalMenuCategory(row.id)).length;
  const localItemCount = bootstrap.menuItems.filter((row) => isLocalMenuItem(row.id)).length;

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

  const { specOptionsWithPrice, specPriceSample } = summarizeLedgerSpecPrices(ledger.products);

  return {
    enabled: ledger.enabled,
    openNow: ledger.openNow,
    removeLocalMenu: options.removeLocalMenu,
    categoriesAdded,
    categoriesUpdated,
    itemsAdded,
    itemsUpdated,
    soldOutCount,
    inStockCount,
    ledgerCategoryCount: ledger.categories.length,
    ledgerProductCount: ledger.products.length,
    localCategoryCount,
    localItemCount,
    localCategoriesRemoved: options.removeLocalMenu ? localCategoryCount : 0,
    localItemsRemoved: options.removeLocalMenu ? localItemCount : 0,
    specOptionsWithPrice,
    specPriceSample,
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
    specGroups: product.specGroups !== undefined ? product.specGroups : existing?.specGroups,
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

function stripSoldOutForLocalItems(soldOut: SoldOutState, bootstrap: PosBootstrap): SoldOutState {
  const next = { ...soldOut };
  for (const item of bootstrap.menuItems) {
    if (isLocalMenuItem(item.id)) {
      delete next[item.id];
    }
  }
  return next;
}

export function mergeLedgerMenuReference(
  bootstrap: PosBootstrap,
  ledger: LedgerOrderMenu,
  soldOutSeed: SoldOutState = {},
  options: LedgerMenuImportOptions = { removeLocalMenu: false },
): { bootstrap: PosBootstrap; soldOut: SoldOutState; stats: LedgerMenuImportStats } {
  if (!ledger.enabled) {
    throw new Error("Ledger 線上點餐未啟用，無法匯入菜單。");
  }

  const stats = previewLedgerMenuImport(bootstrap, ledger, options);
  const timestamp = new Date().toISOString();
  const existingItems = buildItemMaps(bootstrap.menuItems);

  const localCategories = options.removeLocalMenu
    ? []
    : bootstrap.categories.filter((row) => isLocalMenuCategory(row.id));
  const localItems = options.removeLocalMenu
    ? []
    : bootstrap.menuItems.filter((row) => isLocalMenuItem(row.id));

  const ledgerCategories = ledger.categories.map(mapLedgerCategory);
  const ledgerItems = ledger.products.map((product) =>
    mapLedgerProduct(product, existingItems.get(toLedgerMenuItemId(product.id))),
  );

  let soldOut = options.removeLocalMenu ? stripSoldOutForLocalItems(soldOutSeed, bootstrap) : { ...soldOutSeed };
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
