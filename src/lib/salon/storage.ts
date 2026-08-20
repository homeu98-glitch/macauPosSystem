// Salon 命名空間的 localStorage 包裝（不污染餐飲 src/lib/storage.ts）。
// 所有讀寫透過此模組；鍵值集中於 src/lib/salon/types.ts 的 SALON_STORAGE_KEYS。

import {
  type SalonBootstrap,
  type SalonBooking,
  type SalonPosOrder,
  type SalonStaff,
  type SalonStaffRole,
  type SalonStation,
  type SalonServiceCategory,
  type SalonServiceItem,
  type SalonCustomerProfile,
  type SalonPackageTemplate,
  type SalonCustomerPackage,
  type SalonQueueEvent,
  type SalonProduct,
  type SalonProductSale,
  type SalonStaffLeave,
  type SalonStaffShift,
  SALON_STORAGE_KEYS,
} from "@/lib/salon/types";
import type { PrintJob } from "@/lib/types";
import { buildDefaultSalonBootstrap, buildEmptySalonBootstrap, DEFAULT_SALON_STORE_ID, defaultSalonCustomers, defaultSalonPackageTemplates, DEFAULT_SALON_LOYALTY, DEFAULT_SALON_PRODUCTS } from "@/lib/salon/mock-data";
import {
  DEFAULT_SALON_STAFF_ROLE_TYPES,
  DEFAULT_SALON_STAFF_LEVEL_TYPES,
} from "@/lib/salon/salon-labels";
import {
  idbSet,
  idbEnqueue,
  flushSalonSyncQueue,
  hydrateSalonFromIdb,
} from "@/lib/salon/idb";

// ────────────────────────────────────────────────────────────────────
// 通用 JSON 讀寫（與餐飲 storage.ts 同款，純內部使用）
// ────────────────────────────────────────────────────────────────────

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return fallback;
  }
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage write failures on restricted browsers / kiosk devices
  }
  // Phase 7-C：鏡像到 IndexedDB（離線 / crash 後可補回）
  void idbSet(key, value);
}

function removeKey(key: string) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

// ────────────────────────────────────────────────────────────────────
// Phase 7-C：IndexedDB 離線硬化初始化
// - 啟動時先從 IDB 補回 localStorage（斷網 / crash 後恢復）
// - 重連網絡 / 頁面可見時 flush 同步佇列（pending → synced）
// 全部 best-effort，唔影響現有 localStorage 熱路徑。
// ────────────────────────────────────────────────────────────────────

const SALON_MIRROR_KEYS = Object.values(SALON_STORAGE_KEYS);

let salonFlushTimer: ReturnType<typeof setInterval> | null = null;

if (typeof window !== "undefined") {
  void hydrateSalonFromIdb(SALON_MIRROR_KEYS);
  const triggerFlush = () => void flushSalonSyncQueue();
  window.addEventListener("online", triggerFlush);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") triggerFlush();
    });
  }
  void flushSalonSyncQueue();
  // 安全網：定時 retry 失敗 / 遺留嘅 queue item（flush 內部無 pending 時零成本）。
  if (salonFlushTimer === null) {
    salonFlushTimer = setInterval(triggerFlush, 20000);
  }
}

// ────────────────────────────────────────────────────────────────────
// 首次啟動 seed（把 mock bootstrap 種入 localStorage）
// ────────────────────────────────────────────────────────────────────

let seededForStore: string | null = null;
// 已為該真實 store 清走過 demo 殘留單據，避免重複清（清走會冇 idempotent 問題，但減少無謂寫）。
let staleDemoClearedFor: string | null = null;

// 示範預約用嘅電話前綴（mock-realtime.ts seedMockBookingsIfEmpty），用嚟識別 demo 殘留單。
const DEMO_PHONE_PREFIX = "6688";

/**
 * 確保 salon bootstrap 已就緒。
 * 若 macau-pos-salon/bootstrap 為空，種入預設 mock 資料。
 * activeStore 為當前綁定的 salon storeId；不同 store 之後可換 seed 來源。
 */
/**
 * 防舊資料（只有單一 role、無 roles 陣列）令 r.roles is not iterable。
 * 任何讀取員工嘅路徑都經此 normalize，確保 roles 一定係陣列。
 */
function normalizeStaff(s: SalonStaff): SalonStaff {
  if (s.roles && s.roles.length > 0) return s;
  const legacyRole = (s as unknown as { role?: string }).role;
  return { ...s, roles: legacyRole ? [legacyRole as SalonStaffRole] : ["therapist"] };
}

export function ensureSalonBootstrap(activeStore?: string): SalonBootstrap {
  if (typeof window === "undefined") {
    return buildDefaultSalonBootstrap();
  }

  if (!seededForStore || seededForStore !== activeStore) {
    const existing = readJson<SalonBootstrap | null>(
      SALON_STORAGE_KEYS.bootstrap,
      null,
    );
    if (!existing) {
      // 真實 Ledger 商戶（非 demo）首次進入 → 全空（該店從未開過 salon 係正常）；
      // 只有未登入 / demo fallback 才種入示範資料。
      const isRealStore = Boolean(activeStore) && activeStore !== DEFAULT_SALON_STORE_ID;
      const seed = isRealStore
        ? buildEmptySalonBootstrap(activeStore as string)
        : buildDefaultSalonBootstrap();
      if (activeStore) {
        seed.storeId = activeStore;
      }
      writeJson(SALON_STORAGE_KEYS.bootstrap, seed);
      // 同步把扁平化的分類與項目寫入專用鍵（Phase 2 起表單直接讀這裡）
      writeJson(SALON_STORAGE_KEYS.serviceCategories, seed.serviceCategories);
      writeJson(SALON_STORAGE_KEYS.serviceItems, seed.serviceItems);
      writeJson(SALON_STORAGE_KEYS.staff, seed.staff);
      writeJson(SALON_STORAGE_KEYS.stations, seed.stations);
      // Phase 4：首次啟動種入示範客戶
      writeJson(SALON_STORAGE_KEYS.customers, defaultSalonCustomers);
      seededForStore = seed.storeId;
      return seed;
    }
    seededForStore = existing.storeId;
    // 從 demo 切換到真實 Ledger 商戶：既有 demo 資料唔應該帶去真店，
    // 重置為全空（該店從未開過 salon 係正常）。其後 hydrate 會由 POS DB 拉真實資料。
    const switchedToRealStore =
      activeStore && activeStore !== DEFAULT_SALON_STORE_ID && existing.storeId === DEFAULT_SALON_STORE_ID;
    if (switchedToRealStore) {
      const empty = buildEmptySalonBootstrap(activeStore as string);
      writeJson(SALON_STORAGE_KEYS.bootstrap, empty);
      writeJson(SALON_STORAGE_KEYS.serviceCategories, empty.serviceCategories);
      writeJson(SALON_STORAGE_KEYS.serviceItems, empty.serviceItems);
      writeJson(SALON_STORAGE_KEYS.staff, empty.staff);
      writeJson(SALON_STORAGE_KEYS.stations, empty.stations);
      writeJson(SALON_STORAGE_KEYS.products, empty.products);
      writeJson(SALON_STORAGE_KEYS.customers, []);
      // 一併清走舊 demo 嘅單據/銷售/預約，避免真店工作台出現非本店資料。
      writeJson(SALON_STORAGE_KEYS.bookings, []);
      writeJson(SALON_STORAGE_KEYS.orders, []);
      writeJson(SALON_STORAGE_KEYS.productSales, []);
      writeJson(SALON_STORAGE_KEYS.printJobs, []);
      writeJson(SALON_STORAGE_KEYS.packageTemplates, []);
      writeJson(SALON_STORAGE_KEYS.customerPackages, []);
      seededForStore = empty.storeId;
      return empty;
    }
    // 真實 Ledger 商戶（已切換過，existing.storeId 已係真店）但本地仲殘留 demo 預約/客戶
    // （上一輪 seed 在 reset 後又種入）：清走一次，唔動 hydrate 落嚟嘅真實資料。
    const isRealStoreNow = activeStore && activeStore !== DEFAULT_SALON_STORE_ID && existing.storeId === activeStore;
    if (isRealStoreNow && staleDemoClearedFor !== activeStore) {
      const bookings = readJson<Array<{ customerPhone?: string }>>(SALON_STORAGE_KEYS.bookings, []);
      const hasDemoBooking = bookings.some((b) => String(b.customerPhone ?? "").startsWith(DEMO_PHONE_PREFIX));
      const customers = readJson<Array<{ phone?: string }>>(SALON_STORAGE_KEYS.customers, []);
      const hasDemoCustomer = customers.some((c) => String(c.phone ?? "").startsWith(DEMO_PHONE_PREFIX));
      if (hasDemoBooking || hasDemoCustomer) {
        writeJson(SALON_STORAGE_KEYS.bookings, []);
        writeJson(SALON_STORAGE_KEYS.orders, []);
        writeJson(SALON_STORAGE_KEYS.productSales, []);
        if (hasDemoCustomer) writeJson(SALON_STORAGE_KEYS.customers, []);
      }
      staleDemoClearedFor = activeStore;
    }
    // 升級既有店家：補齊後續 phase 新增欄位（不觸動其他設定，店家可自行到設置調整）。
    let changed = false;
    // Phase 8 忠誠度：loyalty 設定
    if (!existing.loyalty) {
      existing.loyalty = DEFAULT_SALON_LOYALTY;
      changed = true;
    }
    // F1+F3 工錢 / 級別：員工補 level / status；bootstrap 補可配置角色 / 級別清單
    if (existing.staff?.length) {
      for (const s of existing.staff) {
        if (!s.level) {
          s.level = "junior";
          changed = true;
        }
        if (!s.status) {
          s.status = s.active === false || s.terminatedAt ? "terminated" : "active";
          changed = true;
        }
        // F-角色多選：舊資料只有單一 role，補齊 roles 陣列（唔改其他設定）
        const legacyRole = (s as unknown as { role?: string }).role;
        if (!s.roles || s.roles.length === 0) {
          s.roles = legacyRole ? [legacyRole as SalonStaffRole] : ["therapist"];
          changed = true;
        }
      }
    }
    // 角色清單：舊店缺 staffRoleTypes → 補預設 5 角色（商家可於設置增刪）
    if (!existing.staffRoleTypes || existing.staffRoleTypes.length === 0) {
      existing.staffRoleTypes = DEFAULT_SALON_STAFF_ROLE_TYPES;
      changed = true;
    }
    // 級別清單：舊店缺 staffLevelTypes → 由舊 staffLevelMultipliers 重建（保保留倍率），
    // 否則補預設 3 級別。
    if (!existing.staffLevelTypes || existing.staffLevelTypes.length === 0) {
      const legacy = (existing as unknown as { staffLevelMultipliers?: Record<string, number> }).staffLevelMultipliers;
      existing.staffLevelTypes = legacy
        ? Object.entries(legacy).map(([id, multiplier]) => ({
            id,
            label: DEFAULT_SALON_STAFF_LEVEL_TYPES.find((t) => t.id === id)?.label ?? id,
            multiplier,
          }))
        : DEFAULT_SALON_STAFF_LEVEL_TYPES;
      changed = true;
    }
    // F4 產品目錄：bootstrap 補 products 預設（僅當 products 完全缺）
    if (!existing.products) {
      existing.products = DEFAULT_SALON_PRODUCTS;
      changed = true;
    }
    // 返結設定：舊店缺 reopenReasons → 補預設原因清單（商家可於設置增刪）
    if (!existing.reopenReasons || existing.reopenReasons.length === 0) {
      existing.reopenReasons = ["結帳錯誤", "加錯項目", "折扣計錯", "會員扣錯", "客人要求改單"];
      changed = true;
    }
    if (changed) {
      writeJson(SALON_STORAGE_KEYS.bootstrap, existing);
      // 同步寫回獨立員工鍵（loadSalonStaff 讀呢度），避免舊店家 standalone key 仍係 role-only 記錄
      writeJson(SALON_STORAGE_KEYS.staff, existing.staff);
    }
    // 首次啟動種入產品獨立鍵（仿 packageTemplates：僅當鍵為空才種入，唔覆蓋店家已建）
    if (!readJson<SalonProduct[] | null>(SALON_STORAGE_KEYS.products, null)) {
      writeJson(SALON_STORAGE_KEYS.products, existing.products ?? DEFAULT_SALON_PRODUCTS);
    }
    return existing;
  }

  // Phase P1：套票模板種子（僅種入一次；不覆蓋店家已建立的模板）。
  // 放在 bootstrap 讀取之後，確保既有店家首次進入也能拿到示範套票。
  if (!readJson<SalonPackageTemplate[] | null>(SALON_STORAGE_KEYS.packageTemplates, null)) {
    writeJson(SALON_STORAGE_KEYS.packageTemplates, defaultSalonPackageTemplates);
  }

  return readJson<SalonBootstrap>(SALON_STORAGE_KEYS.bootstrap, buildDefaultSalonBootstrap());
}

/**
 * 開機由 POS DB hydrate：有網 + 配咗 Supabase 就 GET bootstrap + state 寫入 localStorage。
 * 用 writeJson（唔 enqueue）避免 hydrate → save* → enqueue → flush → 回寫 DB 嘅 loop。
 * source=mock（未配 Supabase / 表空）時唔寫，保留本地 mock。
 * 由 src/app/salon/layout.tsx 開機 fire 一次（冪等）。
 */
export async function hydrateSalonFromPosDb(storeId?: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (typeof navigator !== "undefined" && !navigator.onLine) return;
  const sid = storeId ?? loadActiveSalonStore() ?? undefined;
  const q = sid ? `?storeId=${encodeURIComponent(sid)}` : "";
  try {
    const [bootRes, stateRes] = await Promise.all([
      fetch(`/api/salon/bootstrap${q}`),
      fetch(`/api/salon/state${q}`),
    ]);
    if (!bootRes.ok || !stateRes.ok) return;
    const boot = await bootRes.json();
    const state = await stateRes.json();

    if (boot?.source === "supabase") {
      saveSalonBootstrap(boot);
    }
    if (state?.source === "supabase") {
      if (Array.isArray(state.bookings)) writeJson(SALON_STORAGE_KEYS.bookings, state.bookings);
      if (Array.isArray(state.orders)) writeJson(SALON_STORAGE_KEYS.orders, state.orders);
      if (Array.isArray(state.customers)) writeJson(SALON_STORAGE_KEYS.customers, state.customers);
      if (Array.isArray(state.printJobs)) writeJson(SALON_STORAGE_KEYS.printJobs, state.printJobs);
      if (Array.isArray(state.packageTemplates)) writeJson(SALON_STORAGE_KEYS.packageTemplates, state.packageTemplates);
      if (Array.isArray(state.customerPackages)) writeJson(SALON_STORAGE_KEYS.customerPackages, state.customerPackages);
    }
  } catch {
    // 網絡 / 解析失敗：留低本地數據，唔影響使用
  }
}

export function loadSalonBootstrap(): SalonBootstrap | null {
  const b = readJson<SalonBootstrap | null>(SALON_STORAGE_KEYS.bootstrap, null);
  if (!b) return b;
  if (b.staff?.length) b.staff = b.staff.map(normalizeStaff);
  return b;
}

export function saveSalonBootstrap(bootstrap: SalonBootstrap) {
  writeJson(SALON_STORAGE_KEYS.bootstrap, bootstrap);
  writeJson(SALON_STORAGE_KEYS.serviceCategories, bootstrap.serviceCategories);
  writeJson(SALON_STORAGE_KEYS.serviceItems, bootstrap.serviceItems);
  writeJson(SALON_STORAGE_KEYS.staff, bootstrap.staff);
  writeJson(SALON_STORAGE_KEYS.stations, bootstrap.stations);
  // Phase 7-C：類目 / 服務 / 員工 / 場地改動同步上雲 salon_bootstrap_config（多終端設定一致）。
  // payload 為整個 bootstrap，flush 按 entity 去重只推最新一份。
  void idbEnqueue({ entity: "bootstrap", refId: "bootstrap", payload: bootstrap });
  seededForStore = bootstrap.storeId;
}

// ────────────────────────────────────────────────────────────────────
// 預約 / 訂單 / 員工 / 房型 / 服務 / 客戶
// ────────────────────────────────────────────────────────────────────

export function loadBookings(): SalonBooking[] {
  return readJson<SalonBooking[]>(SALON_STORAGE_KEYS.bookings, []);
}

export function saveBookings(bookings: SalonBooking[]) {
  writeJson(SALON_STORAGE_KEYS.bookings, bookings);
  void idbEnqueue({
    entity: "bookings",
    refId: "bookings",
    payload: bookings,
  });
}

export function loadSalonOrders(): SalonPosOrder[] {
  return readJson<SalonPosOrder[]>(SALON_STORAGE_KEYS.orders, []);
}

export function saveSalonOrders(orders: SalonPosOrder[]) {
  writeJson(SALON_STORAGE_KEYS.orders, orders);
  void idbEnqueue({
    entity: "orders",
    refId: "orders",
    payload: orders,
  });
}

export function loadSalonStaff(): SalonStaff[] {
  return readJson<SalonStaff[]>(SALON_STORAGE_KEYS.staff, []).map(normalizeStaff);
}

export function saveSalonStaff(staff: SalonStaff[]) {
  writeJson(SALON_STORAGE_KEYS.staff, staff);
  const bootstrap = loadSalonBootstrap();
  if (bootstrap) {
    saveSalonBootstrap({ ...bootstrap, staff, lastUpdatedAt: new Date().toISOString() });
  }
}

export function loadStations(): SalonStation[] {
  return readJson<SalonStation[]>(SALON_STORAGE_KEYS.stations, []);
}

export function saveStations(stations: SalonStation[]) {
  writeJson(SALON_STORAGE_KEYS.stations, stations);
  const bootstrap = loadSalonBootstrap();
  if (bootstrap) {
    saveSalonBootstrap({ ...bootstrap, stations, lastUpdatedAt: new Date().toISOString() });
  }
}

export function loadServiceCategories(): SalonServiceCategory[] {
  return readJson<SalonServiceCategory[]>(SALON_STORAGE_KEYS.serviceCategories, []);
}

export function saveServiceCategories(categories: SalonServiceCategory[]) {
  writeJson(SALON_STORAGE_KEYS.serviceCategories, categories);
  const bootstrap = loadSalonBootstrap();
  if (bootstrap) {
    saveSalonBootstrap({ ...bootstrap, serviceCategories: categories, lastUpdatedAt: new Date().toISOString() });
  }
}

export function loadServiceItems(): SalonServiceItem[] {
  return readJson<SalonServiceItem[]>(SALON_STORAGE_KEYS.serviceItems, []);
}

export function saveServiceItems(items: SalonServiceItem[]) {
  writeJson(SALON_STORAGE_KEYS.serviceItems, items);
  const bootstrap = loadSalonBootstrap();
  if (bootstrap) {
    saveSalonBootstrap({ ...bootstrap, serviceItems: items, lastUpdatedAt: new Date().toISOString() });
  }
}

export function loadCustomers(): SalonCustomerProfile[] {
  return readJson<SalonCustomerProfile[]>(SALON_STORAGE_KEYS.customers, []);
}

// ────────────────────────────────────────────────────────────────────
// 產品目錄 / 產品銷售（F4）
// 產品目錄雙寫 bootstrap.products + 獨立鍵；產品銷售為獨立 collection。
// ────────────────────────────────────────────────────────────────────

export function loadSalonProducts(): SalonProduct[] {
  return readJson<SalonProduct[]>(SALON_STORAGE_KEYS.products, []);
}

export function saveSalonProducts(products: SalonProduct[]) {
  writeJson(SALON_STORAGE_KEYS.products, products);
  const bootstrap = loadSalonBootstrap();
  if (bootstrap) {
    saveSalonBootstrap({ ...bootstrap, products, lastUpdatedAt: new Date().toISOString() });
  }
}

export function loadSalonProductSales(): SalonProductSale[] {
  return readJson<SalonProductSale[]>(SALON_STORAGE_KEYS.productSales, []);
}

export function saveSalonProductSales(sales: SalonProductSale[]) {
  writeJson(SALON_STORAGE_KEYS.productSales, sales);
  void idbEnqueue({
    entity: "productSales",
    refId: "productSales",
    payload: sales,
  });
}

// ────────────────────────────────────────────────────────────────────
// 員工放假 / shift 記錄（F2）
// ────────────────────────────────────────────────────────────────────

export function loadSalonStaffLeaves(): SalonStaffLeave[] {
  return readJson<SalonStaffLeave[]>(SALON_STORAGE_KEYS.staffLeaves, []);
}

export function saveSalonStaffLeaves(leaves: SalonStaffLeave[]) {
  writeJson(SALON_STORAGE_KEYS.staffLeaves, leaves);
  void idbEnqueue({
    entity: "staffLeaves",
    refId: "staffLeaves",
    payload: leaves,
  });
}

export function loadSalonStaffShifts(): SalonStaffShift[] {
  return readJson<SalonStaffShift[]>(SALON_STORAGE_KEYS.staffShifts, []);
}

export function saveSalonStaffShifts(shifts: SalonStaffShift[]) {
  writeJson(SALON_STORAGE_KEYS.staffShifts, shifts);
  void idbEnqueue({
    entity: "staffShifts",
    refId: "staffShifts",
    payload: shifts,
  });
}

export function saveCustomers(customers: SalonCustomerProfile[]) {
  writeJson(SALON_STORAGE_KEYS.customers, customers);
  void idbEnqueue({
    entity: "customers",
    refId: "customers",
    payload: customers,
  });
}

// ────────────────────────────────────────────────────────────────────
// 套票模板 / 客戶套票卡（P1）
// 次數額度留本地；改動進 sync 佇列上雲 salon_package_templates / salon_customer_packages。
// ────────────────────────────────────────────────────────────────────

export function loadSalonPackageTemplates(): SalonPackageTemplate[] {
  return readJson<SalonPackageTemplate[]>(SALON_STORAGE_KEYS.packageTemplates, []);
}

export function saveSalonPackageTemplates(templates: SalonPackageTemplate[]) {
  writeJson(SALON_STORAGE_KEYS.packageTemplates, templates);
  void idbEnqueue({
    entity: "packageTemplates",
    refId: "packageTemplates",
    payload: templates,
  });
}

export function loadSalonCustomerPackages(): SalonCustomerPackage[] {
  return readJson<SalonCustomerPackage[]>(SALON_STORAGE_KEYS.customerPackages, []);
}

export function saveSalonCustomerPackages(pkgs: SalonCustomerPackage[]) {
  writeJson(SALON_STORAGE_KEYS.customerPackages, pkgs);
  void idbEnqueue({
    entity: "customerPackages",
    refId: "customerPackages",
    payload: pkgs,
  });
}

// ────────────────────────────────────────────────────────────────────
// 列印佇列（salon 隔離鍵 macau-pos-salon/print-jobs）
// 刻意不與餐飲 loadPrintJobs/savePrintJobs 共用，避免污染餐飲列印佇列；
// 收據 PrintJob 仍複用共享 PrintJob 型別，並經 sendJobToHub 派發到 Printer Hub。
// ────────────────────────────────────────────────────────────────────

export function loadSalonPrintJobs(): PrintJob[] {
  return readJson<PrintJob[]>(SALON_STORAGE_KEYS.printJobs, []);
}

export function saveSalonPrintJobs(jobs: PrintJob[]) {
  writeJson(SALON_STORAGE_KEYS.printJobs, jobs);
  void idbEnqueue({
    entity: "printJobs",
    refId: "printJobs",
    payload: jobs,
  });
}

// ────────────────────────────────────────────────────────────────────
// 列隊（Phase 1 暫無寫入；先暴露讀寫介面給 Phase 3+ 使用）
// ────────────────────────────────────────────────────────────────────

export function loadSalonSyncQueue(): SalonQueueEvent[] {
  return readJson<SalonQueueEvent[]>(SALON_STORAGE_KEYS.syncQueue, []);
}

export function saveSalonSyncQueue(events: SalonQueueEvent[]) {
  writeJson(SALON_STORAGE_KEYS.syncQueue, events);
}

// ────────────────────────────────────────────────────────────────────
// 終端綁定的 salon storeId
// ────────────────────────────────────────────────────────────────────

export function loadActiveSalonStore(): string | null {
  return readJson<string | null>(SALON_STORAGE_KEYS.activeStore, null);
}

export function saveActiveSalonStore(storeId: string) {
  writeJson(SALON_STORAGE_KEYS.activeStore, storeId);
}

export function clearActiveSalonStore() {
  removeKey(SALON_STORAGE_KEYS.activeStore);
}

// ────────────────────────────────────────────────────────────────────
// 重置（開發 / 測試用）
// ────────────────────────────────────────────────────────────────────

export function resetSalonStorage() {
  removeKey(SALON_STORAGE_KEYS.bootstrap);
  removeKey(SALON_STORAGE_KEYS.bookings);
  removeKey(SALON_STORAGE_KEYS.orders);
  removeKey(SALON_STORAGE_KEYS.staff);
  removeKey(SALON_STORAGE_KEYS.stations);
  removeKey(SALON_STORAGE_KEYS.serviceCategories);
  removeKey(SALON_STORAGE_KEYS.serviceItems);
  removeKey(SALON_STORAGE_KEYS.products);
  removeKey(SALON_STORAGE_KEYS.productSales);
  removeKey(SALON_STORAGE_KEYS.staffLeaves);
  removeKey(SALON_STORAGE_KEYS.staffShifts);
  removeKey(SALON_STORAGE_KEYS.printJobs);
  removeKey(SALON_STORAGE_KEYS.syncQueue);
  removeKey(SALON_STORAGE_KEYS.shift);
  removeKey(SALON_STORAGE_KEYS.shiftHistory);
  removeKey(SALON_STORAGE_KEYS.customers);
  removeKey(SALON_STORAGE_KEYS.packageTemplates);
  removeKey(SALON_STORAGE_KEYS.customerPackages);
  removeKey(SALON_STORAGE_KEYS.activeStore);
  seededForStore = null;
}

/**
 * 只重種「店家設定」層（類目 / 服務項目 / 員工 / 房型椅）回預設 mock，
 * 保留 預約 / 訂單 / 客戶 / 列印 / sync 佇列。供開發工具 tab 使用，
 * 不會清掉營運數據（與 resetSalonStorage 不同）。
 */
export function reseedSalonConfig() {
  const seed = buildDefaultSalonBootstrap();
  const activeStore = loadActiveSalonStore();
  if (activeStore) seed.storeId = activeStore;
  saveSalonBootstrap(seed);
}
