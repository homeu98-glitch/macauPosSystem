"use client";

import { defaultBackofficeSyncJobs } from "@/lib/mock-data";
import {
  loadAccountStores,
  loadAccountUsers,
  loadPermissionGroups,
  saveAccountStores,
} from "@/lib/storage";
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

export function loadLocalBackofficeOverview(): BackofficeOverviewPayload {
  return {
    ok: true,
    dbConfigured: false,
    source: "mock",
    stores: loadAccountStores(),
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
      stores: payload.stores ?? [],
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
