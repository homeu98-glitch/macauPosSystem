"use client";

import { defaultBackofficeSyncJobs } from "@/lib/mock-data";
import {
  loadAccountStores,
  loadAccountUsers,
  loadPermissionGroups,
  saveAccountStores,
} from "@/lib/storage";
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
    const response = await fetch("/api/backoffice/overview", { cache: "no-store" });
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
