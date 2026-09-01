import { LedgerMenuCategory, LedgerMenuProduct, LedgerOrderMenu, parseLedgerOrderMenu } from "@/lib/ledger/menu";
import { loadBootstrapCache, loadSoldOutState, saveBootstrapCache, saveSoldOutState, SoldOutState } from "@/lib/storage";
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
    // price = 客人實際畀嘅折後價（與 Ledger 線上客人對齊）
    price: product.priceMop,
    printerGroup: existing?.printerGroup ?? "kitchen",
    specGroups: product.specGroups !== undefined ? product.specGroups : existing?.specGroups,
    image: product.image ?? existing?.image,
    // 菜品層折扣：原價 / 折扣率從 Ledger 帶落嚟。
    // 同步方向 = 單向（§菜品折扣 v1）：Ledger 為權威；existing 嘅值只在 Ledger 無提供時先 fallback。
    // 唔取 max / merge，避免店員本機改完折扣被下次 import 覆蓋之外，仲會出現「兩邊折扣不一致」
    // 但 Ledger 已經係單一 source of truth。
    ...(product.originalPriceMop != null ? { originalPrice: product.originalPriceMop } : {}),
    ...(product.discountRate != null && product.discountRate > 0 && product.discountRate < 100
      ? { discountRate: product.discountRate }
      : {}),
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

/**
 * M7 — `public.products` Realtime 嘅本地 patch/upsert。
 * 唔做全 `list_merchant_order_menu` re-fetch；只按單筆變更更新 bootstrap 餐牌 cache。
 *
 * - INSERT / UPDATE：parse 單筆 raw product → `LedgerMenuProduct` → `MenuItem`（重用 mapLedgerProduct），
 *   按 `ledger-<id>` upsert；分類唔存在就補一筆；同步售罄狀態。
 * - DELETE：移除 `ledger-<id>` 菜品同售罄標記。
 * 改完 saveBootstrapCache + dispatch `pos-bootstrap-changed`（pos-app / kiosk 聽咗會重讀）。
 *
 * 守衛：若 bootstrap 根本未匯入 Ledger 餐牌（無任何 `ledger-` 菜品），跳過單筆 patch，
 * 等下次完整匯入帶齊，避免出現孤兒菜品 / 殘缺分類。
 */
export function patchMenuFromRealtimeRecord(
  record: unknown,
  eventType: "INSERT" | "UPDATE" | "DELETE",
): { changed: boolean } {
  const bootstrap = loadBootstrapCache();
  if (!bootstrap) return { changed: false };

  const hasLedgerMenu = bootstrap.menuItems.some((row) => row.id.startsWith(LEDGER_MENU_ITEM_ID_PREFIX));
  if (!hasLedgerMenu) return { changed: false };

  const rawRecord = (record && typeof record === "object" ? (record as Record<string, unknown>) : null) ?? {};
  const rawId = String(rawRecord.id ?? rawRecord.product_id ?? rawRecord.menu_item_id ?? "").trim();
  if (!rawId) return { changed: false };

  const posId = toLedgerMenuItemId(rawId);

  if (eventType === "DELETE") {
    const hadItem = bootstrap.menuItems.some((row) => row.id === posId);
    if (!hadItem) return { changed: false };
    const nextItems = bootstrap.menuItems.filter((row) => row.id !== posId);
    const nextSoldOut = { ...loadSoldOutState() };
    delete nextSoldOut[posId];
    saveSoldOutState(nextSoldOut);
    saveBootstrapCache({ ...bootstrap, menuItems: nextItems, lastUpdatedAt: new Date().toISOString() });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pos-bootstrap-changed"));
    }
    return { changed: true };
  }

  const parsed = parseLedgerOrderMenu({ products: [record], categories: [] });
  const product = parsed.products[0];
  if (!product) return { changed: false };

  const itemById = buildItemMaps(bootstrap.menuItems);
  const mapped = mapLedgerProduct(product, itemById.get(posId));

  const catPosId = toLedgerCategoryId(product.categoryId);
  const categories: MenuCategory[] = bootstrap.categories.some((row) => row.id === catPosId)
    ? bootstrap.categories
    : [...bootstrap.categories, { id: catPosId, name: String(rawRecord.category_name ?? catPosId) }];

  const nextItems = bootstrap.menuItems.some((row) => row.id === posId)
    ? bootstrap.menuItems.map((row) => (row.id === posId ? mapped : row))
    : [...bootstrap.menuItems, mapped];

  const soldOut = applySoldOutForProduct(loadSoldOutState(), product, new Date().toISOString());
  saveSoldOutState(soldOut);

  saveBootstrapCache({
    ...bootstrap,
    categories,
    menuItems: nextItems,
    lastUpdatedAt: new Date().toISOString(),
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-bootstrap-changed"));
  }
  return { changed: true };
}
