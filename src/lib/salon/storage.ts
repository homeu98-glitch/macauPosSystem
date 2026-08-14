// Salon 命名空間的 localStorage 包裝（不污染餐飲 src/lib/storage.ts）。
// 所有讀寫透過此模組；鍵值集中於 src/lib/salon/types.ts 的 SALON_STORAGE_KEYS。

import {
  type SalonBootstrap,
  type SalonBooking,
  type SalonPosOrder,
  type SalonStaff,
  type SalonStation,
  type SalonServiceCategory,
  type SalonServiceItem,
  type SalonCustomerProfile,
  type SalonQueueEvent,
  SALON_STORAGE_KEYS,
} from "@/lib/salon/types";
import { buildDefaultSalonBootstrap } from "@/lib/salon/mock-data";

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
// 首次啟動 seed（把 mock bootstrap 種入 localStorage）
// ────────────────────────────────────────────────────────────────────

let seededForStore: string | null = null;

/**
 * 確保 salon bootstrap 已就緒。
 * 若 macau-pos-salon/bootstrap 為空，種入預設 mock 資料。
 * activeStore 為當前綁定的 salon storeId；不同 store 之後可換 seed 來源。
 */
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
      const seed = buildDefaultSalonBootstrap();
      if (activeStore) {
        seed.storeId = activeStore;
      }
      writeJson(SALON_STORAGE_KEYS.bootstrap, seed);
      // 同步把扁平化的分類與項目寫入專用鍵（Phase 2 起表單直接讀這裡）
      writeJson(SALON_STORAGE_KEYS.serviceCategories, seed.serviceCategories);
      writeJson(SALON_STORAGE_KEYS.serviceItems, seed.serviceItems);
      writeJson(SALON_STORAGE_KEYS.staff, seed.staff);
      writeJson(SALON_STORAGE_KEYS.stations, seed.stations);
      seededForStore = seed.storeId;
      return seed;
    }
    seededForStore = existing.storeId;
    return existing;
  }

  return readJson<SalonBootstrap>(SALON_STORAGE_KEYS.bootstrap, buildDefaultSalonBootstrap());
}

export function loadSalonBootstrap(): SalonBootstrap | null {
  return readJson<SalonBootstrap | null>(SALON_STORAGE_KEYS.bootstrap, null);
}

export function saveSalonBootstrap(bootstrap: SalonBootstrap) {
  writeJson(SALON_STORAGE_KEYS.bootstrap, bootstrap);
  writeJson(SALON_STORAGE_KEYS.serviceCategories, bootstrap.serviceCategories);
  writeJson(SALON_STORAGE_KEYS.serviceItems, bootstrap.serviceItems);
  writeJson(SALON_STORAGE_KEYS.staff, bootstrap.staff);
  writeJson(SALON_STORAGE_KEYS.stations, bootstrap.stations);
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
}

export function loadSalonOrders(): SalonPosOrder[] {
  return readJson<SalonPosOrder[]>(SALON_STORAGE_KEYS.orders, []);
}

export function saveSalonOrders(orders: SalonPosOrder[]) {
  writeJson(SALON_STORAGE_KEYS.orders, orders);
}

export function loadSalonStaff(): SalonStaff[] {
  return readJson<SalonStaff[]>(SALON_STORAGE_KEYS.staff, []);
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

export function saveCustomers(customers: SalonCustomerProfile[]) {
  writeJson(SALON_STORAGE_KEYS.customers, customers);
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
  removeKey(SALON_STORAGE_KEYS.printJobs);
  removeKey(SALON_STORAGE_KEYS.syncQueue);
  removeKey(SALON_STORAGE_KEYS.shift);
  removeKey(SALON_STORAGE_KEYS.shiftHistory);
  removeKey(SALON_STORAGE_KEYS.customers);
  removeKey(SALON_STORAGE_KEYS.activeStore);
  seededForStore = null;
}
