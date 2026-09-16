"use client";

import { defaultBackofficeSyncJobs } from "@/lib/mock-data";
import {
  loadAccountStores,
  loadAccountUsers,
  loadAuthSession,
  loadPermissionGroups,
  saveAccountStores,
} from "@/lib/storage";
import { posDeviceAuthHeaders } from "@/lib/pos/pos-sync-auth";
import { loadSalonBootstrap } from "@/lib/salon/storage";
import { AccountPermissionGroup, AccountStore, AccountUser, BackofficeSyncJob } from "@/lib/types";

export type BackofficeOverviewPayload = {
  ok: boolean;
  dbConfigured: boolean;
  source?: "supabase" | "mock";
  stores: AccountStore[];
  accounts: AccountUser[];
  permissionGroups: AccountPermissionGroup[];
  syncJobs: BackofficeSyncJob[];
};

/**
 * 把 salon 本地 bootstrap 店（示範美容院）併入 backoffice 門店列表，標 industry:"salon"。
 * 真 Supabase 路徑由 /api/backoffice/overview 回傳 industry（seam，後端未做時回 mock）。
 */
function buildSalonAccountStore(): AccountStore | null {
  const bootstrap = loadSalonBootstrap();
  if (!bootstrap) return null;
  const now = new Date().toISOString();
  return {
    id: bootstrap.storeId,
    name: bootstrap.storeName,
    active: true,
    code: "SALON",
    city: "澳門",
    industry: "salon",
    syncStatus: "ok",
    createdAt: bootstrap.lastUpdatedAt ?? now,
    updatedAt: bootstrap.lastUpdatedAt ?? now,
  };
}

export function loadLocalBackofficeOverview(): BackofficeOverviewPayload {
  const baseStores = loadAccountStores().map((store) => ({
    ...store,
    industry: store.industry ?? ("restaurant" as const),
  }));
  const salonStore = buildSalonAccountStore();
  const merged = salonStore
    ? [...baseStores, salonStore]
    : baseStores;
  return {
    ok: true,
    dbConfigured: false,
    source: "mock",
    stores: merged,
    accounts: loadAccountUsers(),
    permissionGroups: loadPermissionGroups(),
    syncJobs: defaultBackofficeSyncJobs,
  };
}

export async function fetchBackofficeOverview(): Promise<BackofficeOverviewPayload> {
  try {
    /**
     * 🔒 2026-09-16：`/api/backoffice/overview` 已加鑑權閘（admin session 或 POS 終端憑證）。
     *
     * 舊版匿名即可抽走 **全部店舖清單（id + 名稱）＋帳號／權限組**
     * ⇒ 等於免費列舉所有 storeId，再用嗰啲 storeId 打其他端點。
     *
     * 這裡兩者都試：`/backoffice` 由 `AuthGuard allowedRoles:["admin"]` 保護，
     * 但商戶用 POS 帳號登入時**唔一定**有 `adminSessionToken` → 退用 POS 終端憑證。
     * 兩者都冇 → 401 → 下面 `!response.ok` 會 fallback 去本機 mock（行為安全，唔會白屏）。
     */
    const adminToken = loadAuthSession()?.adminSessionToken;
    const headers: Record<string, string> = adminToken
      ? { Authorization: `Bearer ${adminToken}` }
      : { ...posDeviceAuthHeaders() };
    const response = await fetch("/api/backoffice/overview", { cache: "no-store", headers });
    const payload = (await response.json()) as Partial<BackofficeOverviewPayload>;
    if (!response.ok || !payload.ok) {
      throw new Error("backoffice overview unavailable");
    }
    if (!payload.dbConfigured) {
      return loadLocalBackofficeOverview();
    }
    return {
      ok: true,
      dbConfigured: true,
      source: payload.source,
      stores: (payload.stores ?? []).map((store) => ({
        ...store,
        industry: store.industry ?? ("restaurant" as const),
      })),
      accounts: payload.accounts ?? [],
      permissionGroups: payload.permissionGroups ?? [],
      syncJobs: payload.syncJobs ?? [],
    };
  } catch {
    return loadLocalBackofficeOverview();
  }
}

export function updateLocalStoreActive(storeId: string, active: boolean) {
  const stores = loadAccountStores();
  const nextStores = stores.map((store) =>
    store.id === storeId
      ? {
          ...store,
          active,
          effectiveActive: active,
          manualDeactivated: !active,
          updatedAt: new Date().toISOString(),
        }
      : store,
  );
  saveAccountStores(nextStores);
  return nextStores;
}
