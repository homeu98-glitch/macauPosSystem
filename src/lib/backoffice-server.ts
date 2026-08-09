import "server-only";

import { listAdminDataFromServer } from "@/lib/admin-account-server";
import { normalizeBootstrapPayload } from "@/lib/bootstrap-normalizer";
import { defaultBackofficeSyncJobs, defaultDeviceConfig, mockBootstrap } from "@/lib/mock-data";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { normalizeDeviceConfig, normalizePosLocalSettings } from "@/lib/storage";
import { AccountPermissionGroup, AccountStore, AccountUser, BackofficeSyncJob, PosBootstrap } from "@/lib/types";

type BackofficeOverviewResult =
  | {
      ok: true;
      dbConfigured: boolean;
      source: "supabase" | "mock";
      stores: AccountStore[];
      accounts: AccountUser[];
      permissionGroups: AccountPermissionGroup[];
      syncJobs: BackofficeSyncJob[];
    }
  | { ok: false; error: string };

function decorateStore(store: AccountStore, accountCount: number) {
  return {
    ...store,
    code: store.code ?? store.id.toUpperCase(),
    city: store.city ?? "澳門",
    sourceStoreId: store.sourceStoreId ?? `main-${store.id}`,
    sourceActive: store.sourceActive ?? true,
    manualDeactivated: store.manualDeactivated ?? !store.active,
    effectiveActive: store.effectiveActive ?? store.active,
    syncStatus: store.syncStatus ?? "ok",
    lastSyncedAt: store.lastSyncedAt ?? store.updatedAt,
    lastHeartbeatAt: store.lastHeartbeatAt ?? store.updatedAt,
    note: store.note ?? "",
    accountCount,
  };
}

function decorateAccount(account: AccountUser) {
  return {
    ...account,
    sourceAccountId: account.sourceAccountId ?? `main-${account.id}`,
    sourceActive: account.sourceActive ?? true,
    manualDeactivated: account.manualDeactivated ?? !account.active,
    effectiveActive: account.effectiveActive ?? account.active,
    lastSyncedAt: account.lastSyncedAt ?? account.updatedAt,
  };
}

function buildMockBootstrap(store: AccountStore): PosBootstrap {
  return normalizeBootstrapPayload({
    ...mockBootstrap,
    storeId: store.id,
    storeName: store.name,
    lastUpdatedAt: store.updatedAt,
  });
}

function buildMockDeviceConfig(store: AccountStore) {
  return normalizeDeviceConfig({
    ...defaultDeviceConfig,
    deviceId: store.id === "macau-store-b" ? "tablet-02" : defaultDeviceConfig.deviceId,
    terminalName: store.id === "macau-store-b" ? "收銀機 02" : defaultDeviceConfig.terminalName,
    storeId: store.id,
    updatedAt: store.updatedAt,
  });
}

async function loadSyncJobsFromDb() {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return defaultBackofficeSyncJobs;

  const { data, error } = await supabase
    .from("backoffice_sync_jobs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(10);

  if (error || !data) {
    return defaultBackofficeSyncJobs;
  }

  return data.map(
    (row): BackofficeSyncJob => ({
      id: row.id,
      jobType: row.job_type ?? "full",
      scope: row.scope ?? "全部",
      status: row.status ?? "success",
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      pulledCount: Number(row.pulled_count ?? 0),
      upsertedCount: Number(row.upserted_count ?? 0),
      failedCount: Number(row.failed_count ?? 0),
      summary: row.summary ?? "同步完成",
      error: row.error_summary ?? undefined,
    }),
  );
}

export async function listBackofficeOverviewFromServer(): Promise<BackofficeOverviewResult> {
  const base = await listAdminDataFromServer();
  if (!base.ok) {
    return { ok: false, error: base.error };
  }

  const accounts = base.accounts.map((account) => decorateAccount(account));
  const stores = base.stores.map((store) =>
    decorateStore(
      store,
      accounts.filter((account) => account.storeIds.includes(store.id)).length,
    ),
  );
  const syncJobs = await loadSyncJobsFromDb();

  return {
    ok: true,
    dbConfigured: base.dbConfigured,
    source: base.source,
    stores,
    accounts,
    permissionGroups: base.permissionGroups,
    syncJobs,
  };
}

export async function getBackofficeStoreDetailFromServer(storeId: string) {
  const overview = await listBackofficeOverviewFromServer();
  if (!overview.ok) return overview;

  const store = overview.stores.find((item) => item.id === storeId);
  if (!store) {
    return { ok: false as const, error: "找不到指定門店。" };
  }

  const boundAccounts = overview.accounts.filter((account) => account.storeIds.includes(storeId));
  const supabase = getSupabaseAdminClient();

  if (!supabase) {
    const bootstrap = buildMockBootstrap(store);
    const deviceConfig = buildMockDeviceConfig(store);
    return {
      ok: true as const,
      dbConfigured: false,
      store,
      accounts: boundAccounts,
      bootstrapSummary: {
        sourceVersion: bootstrap.sourceVersion,
        categories: bootstrap.categories.length,
        menuItems: bootstrap.menuItems.length,
        tables: bootstrap.tables.length,
        paymentMethods: bootstrap.rules.paymentMethods.length,
        updatedAt: bootstrap.lastUpdatedAt,
      },
      devices: deviceConfig
        ? [
            {
              deviceId: deviceConfig.deviceId,
              terminalName: deviceConfig.terminalName,
              printerCount: deviceConfig.printers.filter((printer) => printer.enabled).length,
              updatedAt: deviceConfig.updatedAt,
            },
          ]
        : [],
      syncJobs: overview.syncJobs,
      localSettingsUpdatedAt: store.updatedAt,
    };
  }

  const [{ data: bootstrapRow }, { data: deviceRows }, { data: syncRows }] = await Promise.all([
    supabase.from("pos_bootstrap_config").select("*").eq("store_id", storeId).maybeSingle(),
    supabase.from("pos_device_configs").select("*").eq("store_id", storeId).order("updated_at", { ascending: false }),
    supabase.from("backoffice_sync_jobs").select("*").or(`scope.eq.${storeId},scope.eq.全部店舖`).order("started_at", { ascending: false }).limit(8),
  ]);

  const bootstrap = bootstrapRow
    ? normalizeBootstrapPayload({
        sourceVersion: bootstrapRow.source_version ?? 1,
        storeId: bootstrapRow.store_id,
        storeName: bootstrapRow.store_name,
        currency: bootstrapRow.currency,
        categories: bootstrapRow.categories,
        menuItems: bootstrapRow.menu_items,
        tables: bootstrapRow.tables,
        rules: bootstrapRow.rules,
        printerGroups: bootstrapRow.printer_groups,
        lastUpdatedAt: bootstrapRow.updated_at,
      })
    : buildMockBootstrap(store);

  return {
    ok: true as const,
    dbConfigured: true,
    store,
    accounts: boundAccounts,
    bootstrapSummary: {
      sourceVersion: bootstrap.sourceVersion,
      categories: bootstrap.categories.length,
      menuItems: bootstrap.menuItems.length,
      tables: bootstrap.tables.length,
      paymentMethods: bootstrap.rules.paymentMethods.length,
      updatedAt: bootstrap.lastUpdatedAt,
    },
    devices: (deviceRows ?? []).map((row) => ({
      deviceId: row.device_id,
      terminalName: row.terminal_name,
      printerCount: Array.isArray(row.printers) ? row.printers.filter((printer: { enabled?: boolean }) => printer.enabled).length : 0,
      updatedAt: row.updated_at,
      localSettings: row.local_settings ? normalizePosLocalSettings(row.local_settings) : null,
    })),
    syncJobs:
      syncRows?.map(
        (row): BackofficeSyncJob => ({
          id: row.id,
          jobType: row.job_type ?? "full",
          scope: row.scope ?? "全部",
          status: row.status ?? "success",
          startedAt: row.started_at,
          finishedAt: row.finished_at ?? undefined,
          pulledCount: Number(row.pulled_count ?? 0),
          upsertedCount: Number(row.upserted_count ?? 0),
          failedCount: Number(row.failed_count ?? 0),
          summary: row.summary ?? "同步完成",
          error: row.error_summary ?? undefined,
        }),
      ) ?? overview.syncJobs,
    localSettingsUpdatedAt: deviceRows?.[0]?.updated_at ?? store.updatedAt,
  };
}

export async function updateBackofficeStoreActiveOnServer(storeId: string, active: boolean) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return { ok: false as const, error: "未配置資料庫，請使用本地模式。" };
  }

  const { error } = await supabase
    .from("admin_stores")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("id", storeId);

  if (error) {
    return { ok: false as const, error: error.message };
  }

  return { ok: true as const };
}
